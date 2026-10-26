# TF2 Fabricator Smart Buyer 1.1.1

Tampermonkey helper for Specialized and Professional TF2 Killstreak Kit Fabricators.
It reads the selected recipe, subtracts verified owned robot parts, checks individual
weapon sell listings, and prepares manual Steam Market purchase links. No API key is needed.

## Install or update

1. Open Tampermonkey's dashboard and edit your existing **TF2 Fabricator Smart Buyer** script.
2. Replace its complete contents with `TF2_Fabricator_Smart_Buyer.txt`, then save.
   Alternatively, install `TF2_Fabricator_Smart_Buyer.user.js`. Keep only one active copy.
3. Reload your Steam TF2 inventory and select a Specialized or Professional Fabricator.
4. Open **TF2 Multi-Buy Settings** beside Steam's **More...** control to choose verification
   depth, refresh live prices, or check the published ranking's date.

For GitHub: copy the release files and folders into the existing repository, retaining
**underscores** in `TF2_Fabricator_Smart_Buyer.user.js`. The metadata now points to that
actual filename. Price publication and script code updates remain separate.

## 1.1.1 compatibility fix

Steam can now return a full HTML/SSR Market page from the legacy `/render/` URL,
even with HTTP 200 and JSON request headers. Version 1.1.0 expected JSON and stopped
after three failed parses. Version 1.1.1 accepts both formats, reading inert embedded
`valve-ssr-data` JSON without executing page scripts. It checks the exact item query,
individual listing IDs, currency and fee-inclusive subtotal. It does not use grouped
minimum prices as evidence for two copies.

Each failed weapon now records its exact reason. Three parser failures are reported
as verification failures rather than incorrectly implying Steam throttled requests.
The new format was reproduced from Steam and covered by a reduced public-response
fixture. Signed-in Firefox/AUD verification remains for the installation smoke test.

## What changed

- **Direct individual listings:** check historically ranked Market names directly; remove
  the separate exact-name search for every candidate. Historical AUD values only decide
  check order; displayed prices come from localized fee-inclusive Steam listings.
- **Progressive results:** usable verified weapon links appear during the scan. Final
  combined checkout is checked after that mode's scan finishes.
- **Less unnecessary work:** no scans of both tiers on page load. Check only the selected
  recipe's tier, cancel obsolete queued requests, and share in-flight/short cached replies.
- **Real quantity depth:** compare distinct listing IDs, including two differently priced
  copies of one name. Parse the recipe's actual input quantity, including quantities above two.
- **Currency checks:** require converted currency IDs and localized buyer prices. Missing
  or mismatched metadata fails visibly; raw seller prices are never substituted.
- **Freshness:** individual responses live for 60 seconds, robot/kit page quotes for 30.
  Long scans revalidate stale winners and reconsider competing offers. Final UI shows when
  the selected offers were observed. Use **Refresh live prices** after waiting or trading.
- **Safer DOM and checkout:** scope parsing to the visible selected card, ignore our own
  observer mutations, keep the robot purchase link disabled during inventory checks, and
  validate Multi-Buy item identities and requested quantities as well as row count.
- **Maintainable release:** focused source files, deterministic single-file build,
  byte-identical TXT distribution, regression tests and a deterministic request benchmark.
- **Updater hardening:** explicit validation also works with `python -O`; reject duplicate
  priorities, nonfinite prices and invalid timestamps. Track failed attempts so rotation
  does not continually select the same failures after partially successful runs.

## Verification modes

| Mode | Ranked names checked per tier | Intended use |
| --- | ---: | --- |
| Fast | 4 | Short initial search |
| Balanced (default) | 10 | Broader comparison with moderate request cost |
| Exhaustive | 275 | All allowlisted names in that tier; can take roughly 15 minutes plus network delays |

These budgets deliberately replace the old 10/25/275 budgets. Fast and Balanced trade
coverage for speed; neither guarantees the global lowest price. All modes report
**lowest verified among checked listings**. Exhaustive still uses bounded listing-page
depth (at least 10 rows per name), and can stop early on errors or throttling. Revalidation
of old selected offers is bounded to ten additional requests; unresolved old quotes are
excluded. A valid name with no sellers differs from a failed response.

All Market adapters share serial 3.4-second pacing. HTTP 401/403/429 stops further
queued Market traffic for at least 60 seconds. The script never retries purchases or
executes a transaction. Already-running network responses may complete after a recipe
switch and be cached, but cannot update the superseded recipe.

## Features retained

- Exact displayed recipe order and quantities; omit unused/fully-owned robot material rows.
- Only the signed-in player's confirmed robot parts are deducted, across paginated inventory.
  Failed/partial scans use full requirements. **Owned Killstreak weapons are not deducted.**
- Regular versus Specialized input eligibility, with exact Festivized names retained in URLs.
- Robot-only checkout and separate weapon links when Steam rejects combined Multi-Buy rows.
- Finished-kit highest-buy-order estimate, with the previous approximate 15% deduction.
  This is an estimate, not an exact reproduction of Steam's rounded/minimum fees.
- Scrollable error report with copy support and the existing Discord support link.
- GitHub ranking download, validated stored fallback and six-hour hosted updater workflow.

## Development

Node 20.19+ and Python 3.10+; the installed userscript itself has no package dependencies.
`linkedom` is used only for development fixture tests.

```sh
npm ci
npm run build
npm run check
npm run benchmark
```

Edit `src/`, not the generated root `.user.js` / `.txt`. The build concatenates source
in a fixed order with its userscript metadata. `npm run check` rejects stale generated
files and runs both JavaScript and Python suites.

| Source | Responsibility |
| --- | --- |
| `src/pricing.js` | Offer selection, coverage, freshness rechecks, request scheduler/cache |
| `src/weapons.js` | Direct Steam listing adapter and ranked checks |
| `src/recipe.js`, `src/inventory.js` | Selected-card recipe and own robot-part inventory |
| `src/money.js`, `src/multibuy.js`, `src/kit-orders.js` | Money parsing, checkout quote validation and kit estimates |
| `src/database-settings.js` | Ranking validation/download and settings |
| `src/controls.js`, `src/controller.js`, `src/bootstrap.js` | UI, selection lifecycle and observation |
| `src/config.js`, `src/diagnostics.js` | Trusted allowlist, constants and diagnostics |
| `updater/` | Headless AUD price publication |

## Hosted price updates

The included `.github/workflows/update-prices.yml` runs approximately every six hours.
Enable GitHub Actions and allow the workflow's `contents: write` permission. Under
**Actions → Refresh Killstreak Prices → Run workflow**, use `test` first (six entries),
then `incremental` (60), or an optional `full` (550).

No Steam credentials or GitHub PAT are required. The job uses GitHub's built-in token to
commit only valid incremental data. Zero verified new prices leave the previous file
unchanged; unavailable items retain the last successful price/date. `lastAttemptAtUTC`
and `lastResult` record more recent attempt outcomes when a partially successful run
publishes. A publication date is not a freshness guarantee for every weapon.

## Validation and limits

See `docs/TEST_REPORT.md` and `docs/PRICING_REFINEMENT.md` for the audit and evidence.
The release has automated unit, DOM-fixture and mocked integration coverage. Steam
Markup examples from the earlier supplied captures informed the adapter; bundled fixtures include synthetic markup and a reduced public Steam listing response. No real Firefox/Chromium Tampermonkey session, live Steam purchase flow,
or hosted GitHub Actions execution was verified here. Public Market endpoints are
undocumented and can be unavailable or change response shape.

Strict Multi-Buy validation requires identifiable listing links and matching quantity
fields. If Steam changes that markup, checkout links and separate weapon links remain,
but a combined quote may be unavailable. Historical rankings can miss newly cheap items
outside Fast/Balanced budgets. Offers can sell or change before checkout; always confirm
Steam's quantities and prices. Do not enable the previous and new userscripts together.

This release is provided as files; it has not been pushed to the live repository.
