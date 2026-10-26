#!/usr/bin/env python3
"""Incrementally refresh Steam TF2 prices for the public userscript database.

No Steam login, browser scanner, GitHub PAT, or third-party Python packages.
This is a best-effort public Market price snapshot, NOT a guaranteed purchase price.
"""
import argparse
import datetime as dt
import json
import logging
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
    pass


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def read_db(path):
    obj = json.loads(path.read_text(encoding='utf-8'))
    assert obj.get('schema') == SCHEMA and obj.get('currency') == 'AUD', 'Unexpected database schema or currency'
    rows = obj['prices']
    assert len(rows) == 550 and len({x['name'] for x in rows}) == 550, 'Expected 550 unique exact item names'
    for tier in ('regular', 'specialized'):
        names = {x['name'] for x in rows if x['tier'] == tier}
        assert len(names) == 275, 'Expected exactly 275 names per tier'
        assert set(obj['priority'][tier]) == names, 'Priority list differs from allowable names'
    return obj


def price_aud(text):
    """Conservatively parse prices returned with an AUD symbol and two decimals."""
    if not isinstance(text, str) or not re.search(r'(?:A\s*\$|AUD)', text, flags=re.I):
        raise ValueError('Steam price not in verified AUD formatting: ' + repr(text))
    val = re.search(r'\d[\d,.\s]*', text)
    if not val:
        raise ValueError('Missing price digits')
    raw = val.group().replace(' ', '').replace(',', '')
    if not re.fullmatch(r'\d+\.\d{2}', raw):
        raise ValueError('Unexpected AUD decimal precision: ' + repr(text))
    number = Decimal(raw)
    if not number.is_finite() or number <= 0:
        raise ValueError('Invalid price')
    return number


def lookup(item, timeout=18):
    params = urllib.parse.urlencode({
        'appid': 440, 'currency': 21, 'country': 'AU',
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
            raise RateLimited(f'Steam rejected requests (HTTP {exc.code})') from exc
        raise
    if not isinstance(payload, dict) or payload.get('success') not in (True, 1, '1'):
        raise ValueError('Steam did not confirm a successful price result')
    lowest = payload.get('lowest_price')
    if not lowest:
        return None
    return price_aud(lowest)


def choose_rows(db, limit, leading):
    """Recheck inexpensive candidates frequently and rotate through the remainder."""
    rows = {x['name']: x for x in db['prices']}
    top_names = []
    for tier in ('regular', 'specialized'):
        top_names.extend(name for name in db['priority'][tier]
                         if rows[name]['status'] == 'priced')
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


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--database', default='data/killstreak-prices.json')
    ap.add_argument('--limit', type=int, default=60, help='Maximum requests in this run')
    ap.add_argument('--leading', type=int, default=8, help='Cheap weapons per tier to recheck each run')
    ap.add_argument('--delay', type=float, default=4.0, help='Minimum delay between requests, seconds')
    ap.add_argument('--validate', action='store_true', help='Validate database without contacting Steam')
    args = ap.parse_args(argv)
    if not (1 <= args.limit <= 550 and 0 <= args.leading <= args.limit//2 and args.delay >= 3):
        ap.error('Choose a limit 1..550, leading <= limit/2, and delay >= 3 seconds')
    path = Path(args.database)
    db = read_db(path)
    if args.validate:
        print('VALID:', len(db['prices']), 'names,', db['pricedCount'], 'priced')
        return 0

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
            if price is None:
                # No live ask found. Do not destroy the last verified price.
                # The snapshot stays as last known, and this can be investigated.
                unavailable += 1
                logging.info('No current listing: %s (previous snapshot retained)', row['name'])
            else:
                row.update({'status': 'priced', 'price': float(price),
                            'displayPrice': f'A$ {price:.2f}',
                            'checkedAtUTC': timestamp,
                            'source': 'github-actions-priceoverview'})
                okay += 1
                logging.info('Updated %s: A$ %s', row['name'], price)
        except RateLimited as exc:
            logging.warning('%s. Stopping without further requests.', exc)
            stopped = True
            break
        except (ValueError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            errors += 1
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
        db['updaterVersion'] = '1.0'
        db['lastRun'] = {'attempted': attempted, 'successful': okay,
                         'unlisted': unavailable, 'errors': errors,
                         'rateLimitedOrStopped': stopped, 'completedUTC': stamp}
        readcheck = path.with_suffix('.json.tmp')
        readcheck.write_text(json.dumps(db, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        read_db(readcheck)
        readcheck.replace(path)
    else:
        print('No verified new prices; leaving existing database untouched.')
    # 0 even if rate limited after some successful checks: the dataset remains valid.
    return 0


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
    sys.exit(main())
