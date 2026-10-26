# Release validation — 1.1.0

Baseline: public repository commit `80ab530`, retrieved 27 October 2026.
The live userscript metadata was 1.0.1 (internal diagnostics 2.8.0); both now use 1.1.0.

## Automated checks

- `npm run check`: deterministic release build equality, JavaScript syntax, 38 JavaScript
  tests and 9 Python tests (47 total).
- JS covers individual seller quantities, duplicates, currencies, aborts, request pacing,
  cache expiration/manual clearing, 429 cooldown, stale winner revalidation, selected-card
  parsing, ordered checkout URLs, partial/paginated inventory, diagnostics, strict DB rows,
  and native Multi-Buy identity/quantity checks.
- Mocked full-controller tests verify owned-part deductions, weapon+robot checkout,
  kit buy-order net estimate, cancellation propagation and robot-only fallback.
- Python covers database validation, AUD parsing, successful incremental publication,
  failed-attempt rotation, preserving per-item checked dates, and stopping on rate limits.
- Synthetic HTML/JSON fixtures run through the actual built adapters via VM and Linkedom.
  Test-only export injection is absent from the installed userscript.

## Performance evidence

`npm run benchmark` uses a virtual clock with 100ms replies and 3400ms request spacing.
It models only the pricing engine, with the ranking already loaded, and excludes inventory,
kit, checkout and real network traffic. It is not a live Steam latency measurement.

| Mode | Direct listing requests | First two offers in model | Completed scan in model |
| --- | ---: | ---: | ---: |
| Fast | 4 | 100ms | 10.3s |
| Balanced | 10 | 100ms | 30.7s |

The old Balanced path requested 25 exact-name searches before seller depth; under the
same assumptions its first seller request could not start before 85s. The new path can
produce provisional seller links after the first successful detail response. Budgets
are smaller, so the improvement includes reduced coverage as well as elimination of
redundant discovery requests. At an equal ten-name budget the old path needs ten search
calls plus seller-detail calls; the replacement needs ten direct detail calls.

## Independent review

An independent reviewer found and the release fixed:
1. Missing/ambiguous currency ID comparisons.
2. Superseded robot/kit requests remaining in the Market queue.
3. An active full-recipe robot link during ownership loading.
4. Old exhaustive-scan winners advertised as fresh.

Regression tests cover those findings. The review also noted that Python validates the
550-name dataset structurally rather than against a second embedded exact allowlist.
The browser's exact allowlist remains authoritative; invalid additions are rejected by
browser validation. This avoids another duplicated 550-name source in the updater.

## Not verified live

- Firefox or Chromium Tampermonkey installation on a signed-in Steam account.
- Current Steam listing-render localization and native Multi-Buy markup.
- Hosted GitHub Actions access to Steam or a real database commit.
- Any actual purchase or sale. All checkout remains manual.

A local Playwright launch was unavailable because no Chromium binary is installed.
No browser-session smoke test is reported as passed. Network and publication failures
must be reported rather than interpreted as successful refreshes.
