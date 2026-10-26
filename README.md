# Steam TF2 Fabricator Multi-Buy

This repository hosts the **Tampermonkey userscript**, the **public Killstreak weapon priority database**, and a **GitHub Actions updater**. The original browser price scanner is not included.

The inventory userscript preserves the existing functionality for TF2 fabricators (robot-part ownership deductions, fabricator-order Multi-Buy links, individual input-weapon listings, and completed-kit sell estimates). It now reads the published weapon priority list from this repository, and offers Fast, Balanced, and Exhaustive verification in Steam inventory settings.

## Files

| File | Purpose |
| --- | --- |
| `TF2-Fabricator-Smart-Buyer.user.js` | Install/update this userscript in Tampermonkey |
| `TF2-Fabricator-Smart-Buyer.txt` | The identical userscript for copying into Tampermonkey |
| `data/killstreak-prices.json` | Latest published weapon priority data (550 names) |
| `updater/update_prices.py` | Small *headless* price updater run by GitHub Actions, not the old browser scanner |
| `.github/workflows/update-prices.yml` | Automatic updater schedule and manual-run button |
| `updater/test_updater.py` | Tests for database validity, currency parsing, updating and failure protection |

## Set up on GitHub

1. Upload the files **preserving their paths** into your existing repository: `Maidehnless/TF2-Fabricator-Smart-Buyer`.
2. Use `main` as the default branch, or edit `PRICE_DB_URL`, `@downloadURL` and `@updateURL` in the userscript if your default branch is different.
3. Open repository **Settings → Actions → General**. Enable workflows; configure **Workflow permissions** to allow read/write if the repository's policies require this (the updater also requests `contents: write`).
4. Open repository **Actions → Refresh Killstreak Prices → Run workflow**. Choose `test` first (6 items), then `incremental` (60 items). Confirm that the run succeeds and updates `data/killstreak-prices.json`.
5. After the first small successful test, leave the six-hour schedule enabled. You can manually trigger a `full` 550-item pass, but it is slower and more likely to be rate limited.
6. When making the project public, install the userscript using the repository's **Raw** `.user.js` URL. The script downloads the public JSON and displays the database timestamp in the new **TF2 Multi-Buy Settings** button beside **More...** on Steam inventory pages.

### Important private-repository restriction

While the repository is **private**, the updater can run and commit as normal using GitHub's built-in `GITHUB_TOKEN`, but an ordinary Tampermonkey userscript cannot access the private raw JSON anonymously. It will use a previously cached snapshot if one exists, or the original Steam search fallback otherwise. Do not put a GitHub Personal Access Token into a publicly distributed userscript.

### Update operation

- The scheduled updater runs every six hours and checks up to **60** exact Steam Market names, with a default **4-second delay** between requests.
- Eight cheap names per tier are included in each run; the remaining slots rotate through older entries, allowing all 550 names to be refreshed over multiple runs.
- Steam's public Market price endpoint is **undocumented and may reject cloud-runner traffic**. On HTTP 401/403/429, the updater stops rather than hammering Steam.
- Old prices remain unchanged when verification fails; the updater **does not replace the database if zero fresh prices were verified**.
- Every price is a snapshot of an advertised **AUD ask**, not proof that the listing is still available or that two copies exist at the same price.
- `generatedAtUTC` / `latestPublishedUTC` mean the **database was last successfully refreshed**. Each item additionally has its own `checkedAtUTC` timestamp. Some items will be older than the overall database timestamp.
- The ranking is an efficiency hint only: Fast checks the top 10 names per tier; Balanced checks 25; Exhaustive tries all 275 names for the selected tier. Steam verification runs in the user's wallet currency and should not promise an absolute cheapest price.

## Running the updater locally (optional)

No third-party Python libraries are needed:

```bash
python updater/update_prices.py --validate
python updater/update_prices.py --limit 10 --leading 2 --delay 4
```

You do **not** need to run it on your PC when GitHub Actions is enabled.

## GitHub Actions minutes

Standard GitHub-hosted runners are free for public repositories; private repositories use your account's monthly quota. See GitHub's billing documentation for the current plan limits. The workflow never needs your Steam login or a personal access token.

## Limitations and safety

- Steam can block or throttle requests (including from GitHub cloud IPs). Test the scheduled scanner before depending on it.
- The published file is a best-effort ranking, **not a global lowest-price guarantee** or an offer reservation.
- Fabricator input weapons are never automatically purchased; users must confirm Steam checkout prices and quantities themselves.
- The userscript currently uses the `main` branch in the raw GitHub URLs. If you rename the default branch, update all three script URLs.
