#!/usr/bin/env python3
"""One read-only request through the installed updater; never scans or writes data."""
import sys
import urllib.error
import urllib.request
from unittest.mock import patch
import update_prices


def main():
    print('TF2 updater request diagnostic: one request, no retries, no file changes.')
    print('Python:', sys.version.split()[0])
    # Report presence only. Proxy URLs may contain passwords and must stay private.
    proxies = sorted(k for k, v in urllib.request.getproxies().items() if k != 'no' and v)
    print('Proxy configuration:', ', '.join(proxies) if proxies else 'none detected')
    original_open = urllib.request.urlopen

    def trace_open(request, *args, **kwargs):
        print('Exact request URL:', request.full_url)
        print('User-Agent:', request.get_header('User-agent', '(Python default)'))
        print('Accept:', request.get_header('Accept', '(not supplied)'))
        print('Cookie header supplied:', bool(request.get_header('Cookie')))
        try:
            response = original_open(request, *args, **kwargs)
        except urllib.error.HTTPError as error:
            print('HTTP status:', error.code)
            print('Retry-After:', error.headers.get('Retry-After', '(not supplied)') if error.headers else '(not supplied)')
            raise
        print('HTTP status:', getattr(response, 'status', '(not supplied)'))
        print('Content-Type:', response.headers.get('Content-Type', '(not supplied)'))
        return response

    try:
        with patch.object(urllib.request, 'urlopen', trace_open):
            price = update_prices.lookup({'name': 'Killstreak SMG'})
        print('Result:', 'valid response with no active ask' if price is None else f'verified USD quote ${price:.2f}')
        return 0
    except update_prices.RateLimited:
        print('Result: request rejected. Compare the exact URL printed above in the browser that returned success.')
        return 1
    except (ValueError, urllib.error.URLError, TimeoutError, OSError):
        # Avoid echoing exception text which could disclose proxy credentials.
        print('Result: connection or response validation failed. No database or checkpoint was modified.')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
