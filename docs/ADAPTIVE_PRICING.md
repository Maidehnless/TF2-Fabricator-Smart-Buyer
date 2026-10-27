# Adaptive price updater 1.3.0

## Intent and chosen policy

Target an accepted Steam price check for all 550 exact names in every rolling 24-hour window, while refreshing inexpensive crafting inputs much more often. These are best-effort freshness targets, not a guarantee of Steam access or the cheapest purchasable listing.

A fixed five-hour scan of 60 names cannot cover the catalog daily: it has insufficient capacity even before refreshing cheap entries. A constant full scan wastes requests on fresh, expensive entries. The chosen adaptive approach plans only due names and gives the broader catalog reserved capacity.

Defaults chosen for this update:
- Top eight quoted names in each tier (16 total): one-hour eligibility interval. Ranking is recomputed from saved USD prices each batch.
- Other names: due after 20 hours, providing four hours of headroom before the 24-hour target.
- Names never successfully checked: immediate initial sweep, oldest-first with the existing ranking interleaved between tiers as a tie-breaking hint.
- Maximum 60 names and 20 minutes per invocation, ten-second request pacing.
- Scheduled eligibility checks every ten minutes. If the catalog has a backlog, the next eligible time is immediate; the next workflow tick takes another due batch. If all work is fresh, the updater waits until the earliest item is due.

## Freshness and failure handling

Coverage uses accepted USD quote responses or verified no-active-listing responses. Failed requests never advance freshness. Checkpoint attemptHistory preserves no-listing checks even when no new prices are published. The dailyCoverage field includes an asOfUTC timestamp, a count checked in the last 24 hours, never-checked and overdue counts, and the number of cheap candidates.

Adaptive batches are replanned from accepted history. Unfinished names remain due; individually failing names are tracked in deferredEntries and retried later (normally two hours), allowing other catalog entries to progress. Legacy pending cycles are resumed before normal adaptive selection.

Global Steam rejection cooldowns remain six, twelve, then twenty-four hours, honoring any longer Retry-After. Adaptive planning never overrides these. test-force is still a deliberate manual override capped at six requests. Completing an adaptive batch through a manual test retains the saved adaptive policy settings, instead of reducing the cheap pool to the test size.

A failure, lengthy queue or extended outage may cause overdue entries. Coverage reporting makes that visible rather than claiming all names are fresh. A saved old price is not a fresh quote merely because the database file was republished.

## Installation

Upload the included workflow, updater files, README and this document to their matching paths. Do not clear either data JSON file. No userscript update is needed. Existing completed five-hour checkpoints are reevaluated when adaptive scheduling takes over; active rejection cooldowns remain in force.

Once installed, the next scheduled eligibility check can begin filling coverage gaps. To start immediately, choose adaptive in Run workflow. Full remains an explicit manual scan; test-force overrides cooldown for a small request test.

## Configuration

The workflow supplies --adaptive --leading 8 --cheap-refresh-minutes 60 --daily-refresh-hours 24 --daily-headroom-hours 4. Reducing the cheap pool lowers repeated requests. More frequent checks increase traffic. Raw dates, checkpoint deadlines, quotes and Python logs remain UTC. The userscript continues using its current display and data schema.

## Validation

Tests cover initial catalog sweeps, hourly cheap-only refreshes, changing rankings, rolling daily eligibility, failed-attempt freshness, confirmed unlisted items, daily coverage, persistent rejection cooldowns, repeated item failures without starvation, old checkpoint migration, an entire simulated day, and bounded manual tests retaining policy settings. Workflow YAML and embedded shell syntax are checked, including staging when a fresh initial database has no checkpoint yet.

The day simulation uses controlled responses and a virtual clock. Live Steam traffic and an actual hosted 24-hour run have not been verified by these tests.
