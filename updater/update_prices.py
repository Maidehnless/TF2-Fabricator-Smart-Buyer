#!/usr/bin/env python3
"""Incrementally refresh Steam TF2 prices for the public userscript database.

No Steam login, browser scanner, GitHub PAT, or third-party Python packages.
This is a best-effort public Market price snapshot, NOT a guaranteed purchase price.
"""
import argparse
import datetime as dt
import json
import logging
import math
import os
from email.utils import parsedate_to_datetime
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from decimal import Decimal, InvalidOperation
from pathlib import Path

SCHEMA = 'maidehnless.tf2.killstreak_priority.v1'
USER_AGENT = 'TF2-Fabricator-Price-Updater/1.0 (GitHub Actions; public price snapshots)'

class RateLimited(Exception):
    def __init__(self, message, retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


def retry_after_seconds(value):
    if not value:
        return None
    try:
        seconds = float(value)
        return max(0, seconds) if math.isfinite(seconds) else None
    except (ValueError, TypeError):
        try:
            return max(0, (parsedate_to_datetime(value) - dt.datetime.now(dt.timezone.utc)).total_seconds())
        except (ValueError, TypeError, OverflowError):
            return None


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def valid_timestamp(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.tzinfo is not None
    except (ValueError, AttributeError, TypeError):
        return False


def read_db(path):
    obj = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(obj, dict) or obj.get('schema') != SCHEMA or obj.get('currency') not in ('USD', 'AUD'):
        raise ValueError('Unexpected database schema or currency')
    rows = obj.get('prices')
    if not isinstance(rows, list) or len(rows) != 550:
        raise ValueError('Expected 550 price rows')
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('name'), str) or row['name'] in seen:
            raise ValueError('Invalid or duplicate price row')
        seen.add(row['name'])
        if row.get('tier') not in ('regular', 'specialized') or row.get('status') not in ('priced', 'unavailable'):
            raise ValueError('Invalid tier or status')
        if row['status'] == 'priced':
            price = row.get('price')
            if isinstance(price, bool) or not isinstance(price, (float, int)) or not math.isfinite(price) or price <= 0:
                raise ValueError('Invalid price')
            if not valid_timestamp(row.get('checkedAtUTC')):
                raise ValueError('Invalid checked timestamp')
    for tier in ('regular', 'specialized'):
        names = {x['name'] for x in rows if x['tier'] == tier}
        priority = obj.get('priority', {}).get(tier)
        if len(names) != 275 or not isinstance(priority, list) or len(priority) != 275 or set(priority) != names:
            raise ValueError('Expected 275 unique prioritized names per tier')
    if not valid_timestamp(obj.get('generatedAtUTC')):
        raise ValueError('Invalid publication timestamp')
    if obj.get('pricedCount') != sum(x['status'] == 'priced' for x in rows):
        raise ValueError('Invalid priced count')
    return obj


def price_usd(text):
    """USD is requested explicitly; do not accept AUD/CAD or ambiguous numeric-only text."""
    if not isinstance(text, str):
        raise ValueError('Missing USD price')
    match = re.fullmatch(r'\s*(?:US\s*\$|USD|\$)\s*(\d[\d,]*\.\d{2})(?:\s*USD)?\s*', text)
    if not match:
        raise ValueError('Steam price not in verified USD formatting: ' + repr(text))
    number = Decimal(match.group(1).replace(',', ''))
    if not number.is_finite() or number <= 0:
        raise ValueError('Invalid price')
    return number


def migrate_to_usd(db):
    if db['currency'] == 'USD':
        return
    old_currency = db['currency']
    for row in db['prices']:
        row['previousQuote'] = {'currency': old_currency, 'price': row.get('price'),
                                'checkedAtUTC': row.get('checkedAtUTC'), 'status': row['status']}
        row.update(status='unavailable', price=None, displayPrice='Awaiting USD check',
                   checkedAtUTC=None, source='awaiting-usd-refresh')
        row.pop('lastAttemptAtUTC', None)
        row['lastResult'] = 'awaiting_usd_check'
    db['currency'] = 'USD'
    db['pricedCount'] = 0
    # Keep the old priority as an ordering hint for unverified entries, never a USD quote.
    db['migration'] = {'fromCurrency': old_currency, 'toCurrency': 'USD'}


def lookup(item, timeout=18):
    params = urllib.parse.urlencode({
        'appid': 440, 'currency': 1, 'country': 'US',
        'market_hash_name': item['name']
    })
    url = 'https://steamcommunity.com/market/priceoverview/?' + params
    request = urllib.request.Request(url, headers={
        'Accept': 'application/json', 'User-Agent': USER_AGENT,
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read(250000).decode('utf-8'))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 429):
            raise RateLimited(f'Steam rejected requests (HTTP {exc.code})',
                              retry_after=retry_after_seconds(exc.headers.get('Retry-After') if exc.headers else None)) from exc
        raise
    if not isinstance(payload, dict) or payload.get('success') not in (True, 1, '1'):
        raise ValueError('Steam did not confirm a successful price result')
    lowest = payload.get('lowest_price')
    if not lowest:
        return None
    return price_usd(lowest)


def choose_rows(db, limit, leading):
    """Recheck inexpensive candidates frequently and rotate through the remainder."""
    rows = {x['name']: x for x in db['prices']}
    top_names = []
    for tier in ('regular', 'specialized'):
        top_names.extend(name for name in db['priority'][tier]
                         if rows[name]['status'] == 'priced' or rows[name].get('previousQuote', {}).get('status') == 'priced')
    # Interleave tiers to avoid the first tier consuming the entire run.
    by_tier = [[], []]
    for name in top_names:
        by_tier[0 if rows[name]['tier'] == 'regular' else 1].append(name)
    selected = []
    for i in range(leading):
        for group in by_tier:
            if i < len(group) and group[i] not in selected and len(selected) < limit:
                selected.append(group[i])
    remaining = [x for x in db['prices'] if x['name'] not in selected]
    # Rotate across all remaining entries, oldest first; timestamps are retained through failures.
    remaining.sort(key=lambda r: (r.get('lastAttemptAtUTC') or r.get('checkedAtUTC') or '', r['name']))
    selected.extend(x['name'] for x in remaining[:max(0,limit-len(selected))])
    return [rows[name] for name in selected]


def rebuild_priority(db):
    old_order = {tier: {name: i for i, name in enumerate(db['priority'][tier])}
                 for tier in ('regular', 'specialized')}
    for tier in ('regular', 'specialized'):
        candidates = [x for x in db['prices'] if x['tier'] == tier]
        candidates.sort(key=lambda x: (
            0 if x['status'] == 'priced' and isinstance(x.get('price'), (float, int)) else 1,
            float(x['price']) if x['status'] == 'priced' and isinstance(x.get('price'), (float, int)) else float('inf'),
            old_order[tier].get(x['name'], 9999)
        ))
        db['priority'][tier] = [x['name'] for x in candidates]
    db['pricedCount'] = sum(x['status'] == 'priced' for x in db['prices'])


STATE_SCHEMA = 'maidehnless.tf2.price-updater-state.v1'


def instant(value):
    parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Checkpoint timestamps must include a timezone')
    return parsed.astimezone(dt.timezone.utc)


def stamp(value):
    return value.astimezone(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
    temporary.replace(path)


def read_checkpoint(path, db):
    if not path.exists():
        return None
    state = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(state, dict) or state.get('schema') != STATE_SCHEMA:
        raise ValueError('Unexpected updater checkpoint schema')
    pending = state.get('pending')
    cycle = state.get('cycle')
    names = {r['name'] for r in db['prices']}
    if not isinstance(pending, list) or not all(isinstance(x, str) and x in names for x in pending) or len(set(pending)) != len(pending):
        raise ValueError('Invalid pending Killstreak entries in updater checkpoint')
    history = state.get('attemptHistory', {})
    if not isinstance(history, dict) or len(history) > len(names):
        raise ValueError('Invalid checkpoint attempt history')
    for name, record in history.items():
        if name not in names or not isinstance(record, dict) or not valid_timestamp(record.get('atUTC')) or record.get('result') not in ('priced', 'no_active_listings'):
            raise ValueError('Invalid entry in checkpoint attempt history')
    if not isinstance(cycle, dict):
        raise ValueError('Missing updater cycle')
    for key in ('total', 'completed', 'priced', 'unlisted'):
        if type(cycle.get(key)) is not int or not 0 <= cycle[key] <= 550:
            raise ValueError('Invalid cycle counters')
    if cycle['total'] < 1 or cycle['completed'] + len(pending) != cycle['total'] or cycle['priced'] + cycle['unlisted'] != cycle['completed']:
        raise ValueError('Checkpoint counters do not match pending work')
    if state.get('status') not in ('retrying', 'complete') or (not pending) != (state['status'] == 'complete'):
        raise ValueError('Checkpoint status does not match pending work')
    for value in (cycle.get('startedAtUTC'), state.get('nextAttemptAtUTC') if pending else state.get('nextCycleAtUTC')):
        if not valid_timestamp(value):
            raise ValueError('Invalid checkpoint timestamp')
    return state


def report_checkpoint(state, status=None, note=''):
    status = status or state['status']
    cycle = state['cycle']
    text = (f"Price updater: {status}; cycle progress {cycle['completed']}/{cycle['total']}; "
            f"{len(state['pending'])} Killstreak entries remaining. {note}")
    print(text)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a', encoding='utf-8') as output:
            output.write('### TF2 price updater\n\n' + text + '\n\n')
            if state.get('nextAttemptAtUTC'):
                output.write('Next eligible attempt: ' + state['nextAttemptAtUTC'] + '\n\n')
            if state.get('nextCycleAtUTC') and not state['pending']:
                output.write('Next scheduled cycle eligible: ' + state['nextCycleAtUTC'] + '\n\n')
            if state.get('lastError'):
                output.write('Last issue: ' + state['lastError'].replace('\n', ' ') + '\n\n')


def run_resumable(args, db):
    path = Path(args.database)
    checkpoint = Path(args.state_file)
    state = read_checkpoint(checkpoint, db)
    now = instant(utc_now())
    if state:
        deadline = state.get('nextAttemptAtUTC') if state['pending'] else state.get('nextCycleAtUTC')
        if deadline and now < instant(deadline) and (state['pending'] or args.scheduled):
            report_checkpoint(state, 'waiting', 'Not due; no Steam requests made.')
            return 0
    history = state.get('attemptHistory', {}) if state else {}
    migrate_to_usd(db)
    # Keep rotation fair even when earlier batches only confirmed unlisted items and
    # correctly left the public price database unchanged.
    for row in db['prices']:
        if row['name'] in history:
            record = history[row['name']]
            row['lastAttemptAtUTC'] = record['atUTC']
            row['lastResult'] = record['result']
    if not state or not state['pending']:
        selected = [r['name'] for r in choose_rows(db, args.limit, args.leading)]
        state = {'schema': STATE_SCHEMA, 'status': 'retrying', 'pending': selected, 'attemptHistory': history,
                 'cycle': {'total': len(selected), 'completed': 0, 'priced': 0, 'unlisted': 0,
                           'startedAtUTC': stamp(now)}, 'nextCycleAtUTC': None,
                 'nextAttemptAtUTC': stamp(now), 'lastError': None}
    elif state['cycle']['total'] != args.limit:
        print('Resuming the active saved cycle before starting a differently sized scan.')
    state.setdefault('attemptHistory', history)
    rows = {r['name']: r for r in db['prices']}
    attempted = okay = unavailable = errors = 0
    reason = 'batch_limit'
    retry_seconds = args.retry_minutes * 60
    start = time.monotonic()
    # A transient item error rotates to the back; never silently remove it as completed.
    max_attempts = min(args.max_requests, len(state['pending']))
    while state['pending'] and attempted < max_attempts:
        if time.monotonic() - start >= args.max_runtime_seconds:
            reason = 'time_budget'
            break
        if attempted:
            time.sleep(args.delay + random.uniform(0, 1.0))
            if time.monotonic() - start >= args.max_runtime_seconds:
                reason = 'time_budget'
                break
        name = state['pending'][0]
        row = rows[name]
        attempted += 1
        try:
            price = lookup(row)
            checked = utc_now()
            row['lastAttemptAtUTC'] = checked
            row['lastResult'] = 'priced' if price is not None else 'no_active_listings'
            if price is None:
                unavailable += 1
                state['cycle']['unlisted'] += 1
                logging.info('Checked %s: no active ask; previous quote retained', name)
            else:
                row.update(status='priced', price=float(price), displayPrice=f'US$ {price:.2f}',
                           checkedAtUTC=checked, source='github-actions-priceoverview')
                okay += 1
                state['cycle']['priced'] += 1
                logging.info('Updated %s: US$ %s', name, price)
            state['attemptHistory'][name] = {'atUTC': checked, 'result': row['lastResult']}
            state['pending'].pop(0)
            state['cycle']['completed'] += 1
        except RateLimited as exc:
            reason = 'rate_limited'
            state['lastError'] = str(exc)[:300]
            if exc.retry_after is not None:
                retry_seconds = max(retry_seconds, exc.retry_after)
            logging.warning('%s. Keeping %s pending; saving progress and pausing.', exc, name)
            break
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as exc:
            errors += 1
            state['lastError'] = f'{name}: {exc}'[:300]
            state['pending'].append(state['pending'].pop(0))
            logging.warning('Could not verify %s: %s. Entry remains pending.', name, exc)
            reason = 'verification_error'
            if errors >= 3:
                break
    ended = instant(utc_now())
    state['updatedAtUTC'] = stamp(ended)
    state['lastRun'] = {'attempted': attempted, 'updated': okay, 'unlisted': unavailable,
                        'errors': errors, 'reason': reason if state['pending'] else 'complete'}
    if state['pending']:
        state['status'] = 'retrying'
        state['nextAttemptAtUTC'] = stamp(ended + dt.timedelta(seconds=retry_seconds))
    else:
        state['status'] = 'complete'
        state['nextAttemptAtUTC'] = None
        state['nextCycleAtUTC'] = stamp(ended + dt.timedelta(hours=args.interval_hours))
        state['lastError'] = None
    # Persist the validated quote data BEFORE the checkpoint that marks those items done.
    if okay:
        rebuild_priority(db)
        db['generatedAtUTC'] = utc_now()
        db['latestPublishedUTC'] = db['generatedAtUTC']
        db['updaterVersion'] = '1.2.0'
        db['lastRun'] = {**state['lastRun'], 'remaining': len(state['pending']),
                         'completedUTC': stamp(ended), 'nextAttemptAtUTC': state['nextAttemptAtUTC']}
        temporary = path.with_name(path.name + '.tmp')
        temporary.write_text(json.dumps(db, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
        read_db(temporary)
        temporary.replace(path)
    else:
        print('No new verified USD quotes; price database left untouched. Retry state is saved separately.')
    atomic_json(checkpoint, state)
    report_checkpoint(state)
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--database', default='data/killstreak-prices.json')
    ap.add_argument('--limit', type=int, default=60, help='Maximum requests in this run')
    ap.add_argument('--leading', type=int, default=8, help='Cheap weapons per tier to recheck each run')
    ap.add_argument('--delay', type=float, default=4.0, help='Minimum delay between requests, seconds')
    ap.add_argument('--state-file', help='Enable durable pending-entry checkpoints at this path')
    ap.add_argument('--scheduled', action='store_true', help='Respect the five-hour new-cycle interval')
    ap.add_argument('--interval-hours', type=float, default=5)
    ap.add_argument('--retry-minutes', type=float, default=30)
    ap.add_argument('--max-requests', type=int, default=60, help='Request budget per resumable invocation')
    ap.add_argument('--max-runtime-seconds', type=float, default=1200, help='Yield before the Actions job timeout')
    ap.add_argument('--validate', action='store_true', help='Validate database without contacting Steam')
    args = ap.parse_args(argv)
    if not (1 <= args.limit <= 550 and 0 <= args.leading <= args.limit//2 and args.delay >= 3):
        ap.error('Choose a limit 1..550, leading <= limit/2, and delay >= 3 seconds')
    if not (1 <= args.max_requests <= 550 and all(math.isfinite(x) and x > 0 for x in
            (args.interval_hours, args.retry_minutes, args.max_runtime_seconds))):
        ap.error('Interval, retry and runtime must be positive finite values; max-requests must be 1..550')
    if args.state_file and Path(args.state_file).resolve() == Path(args.database).resolve():
        ap.error('Checkpoint and price database must be different files')
    path = Path(args.database)
    db = read_db(path)
    if args.validate:
        if args.state_file:
            read_checkpoint(Path(args.state_file), db)
        print('VALID:', len(db['prices']), 'names,', db['pricedCount'], 'priced')
        return 0

    if args.state_file:
        return run_resumable(args, db)
    migrate_to_usd(db)
    selected = choose_rows(db, args.limit, args.leading)
    okay = 0
    unavailable = 0
    attempted = 0
    errors = 0
    stopped = False
    for row in selected:
        if attempted:
            time.sleep(args.delay + random.uniform(0, 0.6))
        attempted += 1
        try:
            price = lookup(row)
            timestamp = utc_now()
            row['lastAttemptAtUTC'] = timestamp
            row['lastResult'] = 'no_active_listings' if price is None else 'priced'
            if price is None:
                # No live ask found. Do not destroy the last verified price.
                # The snapshot stays as last known, and this can be investigated.
                unavailable += 1
                logging.info('No current listing: %s (previous snapshot retained)', row['name'])
            else:
                row.update({'status': 'priced', 'price': float(price),
                            'displayPrice': f'US$ {price:.2f}',
                            'checkedAtUTC': timestamp,
                            'source': 'github-actions-priceoverview'})
                okay += 1
                logging.info('Updated %s: US$ %s', row['name'], price)
        except RateLimited as exc:
            row['lastAttemptAtUTC'] = utc_now()
            row['lastResult'] = 'throttled'
            logging.warning('%s. Stopping without further requests.', exc)
            stopped = True
            break
        except (ValueError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            errors += 1
            row['lastAttemptAtUTC'] = utc_now()
            row['lastResult'] = 'error'
            logging.warning('Could not verify %s: %s', row['name'], exc)
            if errors >= 5:
                logging.warning('Too many errors; stopping without requesting other items')
                stopped = True
                break

    print(f'Attempted {attempted}; updated {okay}; unlisted {unavailable}; failed {errors}; stopped {stopped}')
    if okay:
        stamp = utc_now()
        rebuild_priority(db)
        db['generatedAtUTC'] = stamp
        db['latestPublishedUTC'] = stamp
        db['updaterVersion'] = '1.1.3'
        db['lastRun'] = {'attempted': attempted, 'successful': okay,
                         'unlisted': unavailable, 'errors': errors,
                         'rateLimitedOrStopped': stopped, 'completedUTC': stamp}
        readcheck = path.with_suffix('.json.tmp')
        readcheck.write_text(json.dumps(db, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')
        read_db(readcheck)
        readcheck.replace(path)
    else:
        print('No verified new prices; leaving existing database untouched.')
    # 0 even if rate limited after some successful checks: the dataset remains valid.
    return 0


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    sys.exit(main())
