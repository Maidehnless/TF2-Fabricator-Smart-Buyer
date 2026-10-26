# Pricing refinement, 27 October 2026

Baseline: public main at 80ab530; install metadata 1.0.1, internal version 2.8.0.

## Audit and design

Preserve the Steam inventory UI, ordered recipe inputs, robot-only ownership deductions,
manual checkout, kit buy-order estimate, error reports, settings and all 550 allowed names.
A full UI rewrite adds regression risk without improving the network bottleneck, so retain
those adapters, split their source by responsibility, and replace pricing orchestration.
The attached reconstruction handoff supplies the behavioural requirements.

Confirmed by source inspection:
- Balanced searches 25 exact names before checking listing depth; a shared 3.4s delay
  makes the discovery phase alone about 82s. Both tiers prefetch even without a recipe.
- Priceoverview/search data do not establish the second seller's price.
- Raw seller amounts can be substituted for converted prices without proving currency.
- Broad body observers react to the script's own rendering; parsing scans all div/span nodes.
- Download/update metadata points to a hyphenated file but the repo uses underscores.
- Database validation checks priority arrays but not unique/eligible price rows.
- Multi-Buy checks row count but not exact row identities/quantities.
- Updater uses assert for data validation (disabled with python -O).

## Implementation plan

1. Add dependency-free pricing tests: individual-offer selection, deduplication, arbitrary
   recipe quantities, currency rejection, cancellation, partial failures, request caching,
   request pacing and global throttling. Run red, then implement the engine.
2. Directly inspect historically ranked listing pages (4/10/275 names for Fast/Balanced/
   Exhaustive). Publish provisional links while checks continue. AUD ranking is order only.
   Exhaustive reports successful coverage, never a globally guaranteed minimum.
3. Integrate with existing adapters: localized fee-inclusive prices, same-currency proof,
   shared short-lived request caches, no speculative two-tier scans, selection cancellation,
   selected-card scope and own-UI observer filtering. Build identical JS and TXT from source.
4. Strengthen database/updater validation and errors; retain 6-hour incremental workflow.
5. Regression suite, mocked integration, deterministic request-count benchmark, independent
   review and release ZIP. Document live Steam and GitHub Actions verification limits.

## Review focus

Currency response mismatch; sold/missing listings; account ownership and incomplete inventory;
rapid recipe switching; unsupported Multi-Buy rows. Synthetic fixtures must be labelled as
synthetic. No purchase or hosted repository write is part of this deliverable.

## Progress

- Baseline Python suite: 4 passed.
- Pricing core, DOM adapters, controller integration and updater refinements implemented.
- Review fixes: explicit response currency identity, all Market-adapter cancellation,
  disabled ownership-loading purchase link, timestamped offers and bounded stale-winner rechecks.
- Manual refresh clears quote caches without bypassing the rate-limit cooldown.
- Rationale retained: improve the pricing subsystem and keep existing proven UI/format adapters;
  the installed release remains a self-contained userscript.

## 1.1.1 compatibility repair

The supplied live Firefox failure was reproduced against the primary Steam endpoint with
identical request headers: HTTP 200 now returns modern HTML/SSR, not legacy JSON.
Transport now accepts either representation; exact-name listing queries, buyer currency,
listing IDs and price+fee subtotals are validated. Own sell listings are excluded.
Per-candidate errors and distinct rate-limit/failure-limit causes are retained.
The reduced live public fixture and 13 added regression tests cover this change.
