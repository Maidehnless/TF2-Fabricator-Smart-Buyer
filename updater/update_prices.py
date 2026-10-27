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
# This compatibility header succeeded in the user's controlled one-request test.
# Override it with TF2_PRICE_USER_AGENT without changing quote currency or using login cookies.
USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0'

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
    user_agent = os.environ.get('TF2_PRICE_USER_AGENT', USER_AGENT).strip()
    if not user_agent or any(c in user_agent for c in ('\r', '\n')) or len(user_agent) > 512:
        raise ValueError('TF2_PRICE_USER_AGENT must be a non-empty single-line header of at most 512 characters')
    params = urllib.parse.urlencode({
        'appid': 440, 'currency': 1, 'country': 'US',
        'market_hash_name': item['name']
    })
    url = 'https://steamcommunity.com/market/priceoverview/?' + params
    request = urllib.request.Request(url, headers={
        'Accept': 'application/json', 'User-Agent': user_agent,
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


ADAPTIVE_POLICY = 'daily-and-cheap-v1'


def plan_adaptive(db, history, deferred, now, limit, leading, cheap_minutes, daily_hours, headroom_hours):
    """Plan accepted checks, not failed attempts; all deadlines remain UTC."""
    rows = db['prices']
    last_checks = {}
    for row in rows:
        candidates = []
        if db['currency'] == 'USD' and row['status'] == 'priced' and row.get('checkedAtUTC'):
            candidates.append(instant(row['checkedAtUTC']))
        if db['currency'] == 'USD' and row.get('lastResult') in ('priced', 'no_active_listings') and valid_timestamp(row.get('lastAttemptAtUTC')):
            candidates.append(instant(row['lastAttemptAtUTC']))
        record = history.get(row['name'])
        if record:
            candidates.append(instant(record['atUTC']))
        # A future timestamp is not evidence of a completed check.
        last_checks[row['name']] = max((t for t in candidates if t <= now), default=None)
    cheap = set()
    for tier in ('regular', 'specialized'):
        order = {name: i for i, name in enumerate(db['priority'][tier])}
        candidates = [r for r in rows if r['tier'] == tier and r['status'] == 'priced']
        candidates.sort(key=lambda r: (r['price'], order.get(r['name'], 9999)))
        cheap.update(r['name'] for r in candidates[:leading])
    cheap_interval = dt.timedelta(minutes=cheap_minutes)
    daily_interval = dt.timedelta(hours=daily_hours-headroom_hours)
    horizon = now-dt.timedelta(hours=24)
    daily_horizon = now-dt.timedelta(hours=daily_hours)
    cheap_due, daily_due, deadlines = [], [], []
    for row in rows:
        name = row['name']
        checked = last_checks[name]
        interval = cheap_interval if name in cheap else daily_interval
        due = checked+interval if checked else now
        if name in deferred:
            due = max(due, instant(deferred[name]))
        deadlines.append(due)
        if due <= now:
            if name in cheap:
                cheap_due.append(row)
            if checked is None or checked+daily_interval <= now:
                daily_due.append(row)
    hints = {name: i * 2 + tier_index for tier_index, tier in enumerate(('regular', 'specialized'))
             for i, name in enumerate(db['priority'][tier])}
    def oldest(row):
        return (last_checks[row['name']] or dt.datetime.min.replace(tzinfo=dt.timezone.utc),
                hints.get(row['name'], 9999), row['name'])
    cheap_due.sort(key=oldest)
    daily_due.sort(key=oldest)
    # Reserve capacity for the broader catalog even when leading is configured high.
    selected = cheap_due[:min(len(cheap_due), max(1, limit//2))]
    seen = {r['name'] for r in selected}
    for row in daily_due+cheap_due:
        if len(selected) == limit:
            break
        if row['name'] not in seen:
            selected.append(row)
            seen.add(row['name'])
    checks = list(last_checks.values())
    return {'selected': selected, 'nextDueAtUTC': stamp(min(deadlines)),
            'coverage': {'asOfUTC': stamp(now), 'total': len(rows), 'checkedLast24Hours': sum(t is not None and t >= horizon for t in checks),
                         'neverChecked': sum(t is None for t in checks),
                         'overdue': sum(t is not None and t < daily_horizon for t in checks),
                         'cheapCandidates': len(cheap)}}


def adaptive_settings(args, state=None):
    if state and state.get('planningPolicy') == ADAPTIVE_POLICY and (not args.adaptive or args.force_test):
        saved = state.get('adaptiveSettings')
        if saved:
            return saved
    return {'leading': args.leading, 'cheapRefreshMinutes': args.cheap_refresh_minutes,
            'dailyRefreshHours': args.daily_refresh_hours, 'dailyHeadroomHours': args.daily_headroom_hours}


def adaptive_plan(args, db, state, now):
    settings = adaptive_settings(args, state)
    return plan_adaptive(db, (state or {}).get('attemptHistory', {}), (state or {}).get('deferredEntries', {}),
                         now, args.limit, settings['leading'], settings['cheapRefreshMinutes'],
                         settings['dailyRefreshHours'], settings['dailyHeadroomHours'])


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
    rejections = state.get('consecutiveRejections', 0)
    if type(rejections) is not int or rejections < 0:
        raise ValueError('Invalid consecutive rejection count')
    pending = state.get('pending')
    cycle = state.get('cycle')
    names = {r['name'] for r in db['prices']}
    if not isinstance(pending, list) or not all(isinstance(x, str) and x in names for x in pending) or len(set(pending)) != len(pending):
        raise ValueError('Invalid pending Killstreak entries in updater checkpoint')
    settings = state.get('adaptiveSettings')
    if settings is not None:
        if (not isinstance(settings, dict) or type(settings.get('leading')) is not int or not 0 <= settings['leading'] <= 275 or
            any(type(settings.get(k)) not in (int, float) or not math.isfinite(settings[k]) for k in
                ('cheapRefreshMinutes', 'dailyRefreshHours', 'dailyHeadroomHours')) or
            not 0 <= settings['dailyHeadroomHours'] < settings['dailyRefreshHours'] or
            not 0 < settings['cheapRefreshMinutes'] <= (settings['dailyRefreshHours']-settings['dailyHeadroomHours'])*60):
            raise ValueError('Invalid adaptive policy settings')
    coverage = state.get('dailyCoverage')
    if coverage is not None:
        if not isinstance(coverage, dict) or coverage.get('total') != len(names) or not valid_timestamp(coverage.get('asOfUTC')):
            raise ValueError('Invalid daily coverage metadata')
        for key in ('checkedLast24Hours', 'neverChecked', 'overdue', 'cheapCandidates'):
            if type(coverage.get(key)) is not int or not 0 <= coverage[key] <= len(names):
                raise ValueError('Invalid daily coverage counter')
    deferred = state.get('deferredEntries', {})
    if not isinstance(deferred, dict) or any(name not in names or not valid_timestamp(value) for name, value in deferred.items()):
        raise ValueError('Invalid adaptive deferred entries')
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
    last = state.get('lastRun')
    if last:
        text += (f" Last scan: {last['attempted']} requests, {last['updated']} new quotes, "
                 f"{last['unlisted']} confirmed without active asks.")
    coverage = state.get('dailyCoverage')
    if coverage:
        text += (f" Daily coverage: {coverage['checkedLast24Hours']}/{coverage['total']} checked in the last 24 hours; "
                 f"{coverage['neverChecked']} never checked; {coverage['overdue']} overdue.")
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
    # Upgrade older rejection checkpoints without immediately hitting Steam again.
    if state and state['pending'] and state.get('lastRun', {}).get('reason') == 'rate_limited' and 'consecutiveRejections' not in state:
        state['consecutiveRejections'] = 1
        previous_attempt = state.get('updatedAtUTC') or state['cycle']['startedAtUTC']
        deadline = instant(previous_attempt) + dt.timedelta(minutes=args.rate_limit_retry_minutes)
        state['nextAttemptAtUTC'] = stamp(max(instant(state['nextAttemptAtUTC']), deadline))
        atomic_json(checkpoint, state)
    if state:
        deadline = state.get('nextAttemptAtUTC') if state['pending'] else state.get('nextCycleAtUTC')
        if deadline and now < instant(deadline) and (state['pending'] or args.scheduled) and not args.force_test and not (args.adaptive and not state['pending'] and (state.get('planningPolicy') != ADAPTIVE_POLICY or state.get('adaptiveSettings') != adaptive_settings(args))):
            reporting = dict(state)
            if args.adaptive:
                reporting['dailyCoverage'] = adaptive_plan(args, db, state, now)['coverage']
            report_checkpoint(reporting, 'waiting', 'Not due; no Steam requests made. Eligible at ' + deadline)
            return 0
    if args.force_test:
        print('Forced test: bypassing the saved cooldown for at most six requests; Steam rejections still stop the batch.')
    history = state.get('attemptHistory', {}) if state else {}
    migrate_to_usd(db)
    # Keep rotation fair even when earlier batches only confirmed unlisted items and
    # correctly left the public price database unchanged.
    for row in db['prices']:
        if row['name'] in history:
            record = history[row['name']]
            row['lastAttemptAtUTC'] = record['atUTC']
            row['lastResult'] = record['result']
    adaptive_cycle = args.adaptive and (not state or not state['pending'] or state.get('planningPolicy') == ADAPTIVE_POLICY)
    plan = adaptive_plan(args, db, state, now) if adaptive_cycle else None
    if plan is not None and not plan['selected']:
        if state:
            state['dailyCoverage'] = plan['coverage']
            state['planningPolicy'] = ADAPTIVE_POLICY
            state['adaptiveSettings'] = adaptive_settings(args, state)
            state['nextAttemptAtUTC' if state['pending'] else 'nextCycleAtUTC'] = plan['nextDueAtUTC']
            atomic_json(checkpoint, state)
            report_checkpoint(state, 'waiting', 'No entries due. Eligible at ' + plan['nextDueAtUTC'])
        else:
            print('No entries due; no Steam requests made. Eligible at ' + plan['nextDueAtUTC'])
        return 0
    if adaptive_cycle or not state or not state['pending']:
        selected = [r['name'] for r in (plan['selected'] if plan else choose_rows(db, args.limit, args.leading))]
        previous = state or {}
        state = {'schema': STATE_SCHEMA, 'status': 'retrying', 'pending': selected, 'attemptHistory': history,
                 'cycle': {'total': len(selected), 'completed': 0, 'priced': 0, 'unlisted': 0,
                           'startedAtUTC': stamp(now)}, 'nextCycleAtUTC': None,
                 'nextAttemptAtUTC': stamp(now), 'lastError': previous.get('lastError'),
                 'consecutiveRejections': previous.get('consecutiveRejections', 0)}
        if args.adaptive:
            state['planningPolicy'] = ADAPTIVE_POLICY
            state['adaptiveSettings'] = adaptive_settings(args, previous)
            state['deferredEntries'] = previous.get('deferredEntries', {})
        if previous.get('lastSuccessfulResponseAtUTC'):
            state['lastSuccessfulResponseAtUTC'] = previous['lastSuccessfulResponseAtUTC']
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
            state['consecutiveRejections'] = 0
            state['lastSuccessfulResponseAtUTC'] = checked
            state['lastError'] = None
            state.get('deferredEntries', {}).pop(name, None)
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
            previous_rejections = state.get('consecutiveRejections', 0)
            state['consecutiveRejections'] = previous_rejections + 1
            # Start with the old workflow's six-hour spacing, then back off further.
            retry_seconds = max(retry_seconds, min(24 * 3600,
                args.rate_limit_retry_minutes * 60 * 2 ** min(previous_rejections, 10)))
            if exc.retry_after is not None:
                retry_seconds = max(retry_seconds, exc.retry_after)
            logging.warning('No more Steam requests this run. Rejection streak %s; cooldown %.0f minutes.',
                            state['consecutiveRejections'], retry_seconds / 60)
            logging.warning('%s. Keeping %s pending; saving progress and pausing.', exc, name)
            break
        except (ValueError, urllib.error.URLError, TimeoutError, OSError) as exc:
            errors += 1
            if args.adaptive:
                state.setdefault('deferredEntries', {})[name] = stamp(instant(utc_now()) + dt.timedelta(minutes=max(args.retry_minutes * 2, args.cheap_refresh_minutes * 2)))
            state['lastError'] = f'{name}: {exc}'[:300]
            state['pending'].append(state['pending'].pop(0))
            logging.warning('Could not verify %s: %s. Entry remains pending.', name, exc)
            reason = 'verification_error'
            if errors >= 3:
                break
    ended = instant(utc_now())
    state['updatedAtUTC'] = stamp(ended)
    state['lastRun'] = {'attempted': attempted, 'updated': okay, 'unlisted': unavailable,
                        'errors': errors, 'verifiedResponses': okay + unavailable,
                        'reason': reason if state['pending'] else 'complete'}
    next_plan = adaptive_plan(args, db, state, ended) if args.adaptive or state.get('planningPolicy') == ADAPTIVE_POLICY else None
    if next_plan:
        state['dailyCoverage'] = next_plan['coverage']
    if state['pending']:
        state['status'] = 'retrying'
        state['nextAttemptAtUTC'] = stamp(ended + dt.timedelta(seconds=retry_seconds))
    else:
        state['status'] = 'complete'
        state['nextAttemptAtUTC'] = None
        state['nextCycleAtUTC'] = next_plan['nextDueAtUTC'] if next_plan else stamp(ended + dt.timedelta(hours=args.interval_hours))
        if args.adaptive:
            state['planningPolicy'] = ADAPTIVE_POLICY
            state['adaptiveSettings'] = adaptive_settings(args, state)
        state['lastError'] = None
    # Persist the validated quote data BEFORE the checkpoint that marks those items done.
    if okay:
        rebuild_priority(db)
        db['generatedAtUTC'] = utc_now()
        db['latestPublishedUTC'] = db['generatedAtUTC']
        db['updaterVersion'] = '1.3.0'
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
    ap.add_argument('--force-test', action='store_true', help='Manual six-request test that bypasses saved cooldowns and preserves active progress')
    ap.add_argument('--scheduled', action='store_true', help='Respect the five-hour new-cycle interval')
    ap.add_argument('--adaptive', action='store_true', help='Daily catalog coverage and frequent cheap-candidate checks; requires --state-file')
    ap.add_argument('--cheap-refresh-minutes', type=float, default=60)
    ap.add_argument('--daily-refresh-hours', type=float, default=24)
    ap.add_argument('--daily-headroom-hours', type=float, default=4)
    ap.add_argument('--interval-hours', type=float, default=5)
    ap.add_argument('--retry-minutes', type=float, default=30)
    ap.add_argument('--rate-limit-retry-minutes', type=float, default=360,
                    help='First rejection cooldown; doubles after repeat rejections, up to 24h (server Retry-After can be longer)')
    ap.add_argument('--max-requests', type=int, default=60, help='Request budget per resumable invocation')
    ap.add_argument('--max-runtime-seconds', type=float, default=1200, help='Yield before the Actions job timeout')
    ap.add_argument('--validate', action='store_true', help='Validate database without contacting Steam')
    args = ap.parse_args(argv)
    if not (1 <= args.limit <= 550 and 0 <= args.leading <= args.limit//2 and args.delay >= 3):
        ap.error('Choose a limit 1..550, leading <= limit/2, and delay >= 3 seconds')
    if not (1 <= args.max_requests <= 550 and all(math.isfinite(x) and x > 0 for x in
            (args.interval_hours, args.retry_minutes, args.rate_limit_retry_minutes, args.max_runtime_seconds))):
        ap.error('Interval, retry and runtime must be positive finite values; max-requests must be 1..550')
    if args.adaptive and not args.state_file:
        ap.error('--adaptive requires --state-file')
    if not (math.isfinite(args.cheap_refresh_minutes) and args.cheap_refresh_minutes > 0 and
            math.isfinite(args.daily_refresh_hours) and math.isfinite(args.daily_headroom_hours) and
            0 <= args.daily_headroom_hours < args.daily_refresh_hours and
            args.cheap_refresh_minutes <= (args.daily_refresh_hours - args.daily_headroom_hours) * 60):
        ap.error('Adaptive intervals must be finite and positive; cheap interval cannot exceed the daily refresh threshold')
    if args.state_file and Path(args.state_file).resolve() == Path(args.database).resolve():
        ap.error('Checkpoint and price database must be different files')
    if args.force_test:
        if args.scheduled or not args.state_file:
            ap.error('--force-test requires --state-file and cannot be used with --scheduled')
        args.limit = 6
        args.leading = min(args.leading, 2)
        args.max_requests = min(args.max_requests, 6)
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
        db['updaterVersion'] = '1.3.0'
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
    logging.Formatter.converter = time.gmtime
    logging.basicConfig(level=logging.INFO, format='%(asctime)sZ %(levelname)s %(message)s',
                        datefmt='%Y-%m-%dT%H:%M:%S')
    sys.exit(main())
