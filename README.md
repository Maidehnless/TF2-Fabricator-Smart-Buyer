<div align="center">

# TF2 Fabricator Smart Buyer

**A Steam inventory userscript for planning Killstreak Kit Fabricator purchases.**

Find eligible Killstreak weapon inputs, account for robot parts you already own, and build Steam Community Market Multi-Buy links without adding up every ingredient by hand.

[![Version](https://img.shields.io/badge/userscript-v2.8.0-1b2838)](./TF2_Fabricator_Smart_Buyer.user.js)
[![Platform](https://img.shields.io/badge/platform-Steam%20Community%20Market-1b2838)](https://steamcommunity.com/market/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

**[Install the userscript](https://raw.githubusercontent.com/Maidehnless/TF2-Fabricator-Smart-Buyer/main/TF2_Fabricator_Smart_Buyer.user.js)** · **[View the price database](./data/killstreak-prices.json)** · **[Report a problem](https://github.com/Maidehnless/TF2-Fabricator-Smart-Buyer/issues)**

</div>

> [!IMPORTANT]
> This is an **unofficial, community-made tool**. It is not affiliated with Valve or Steam. It **does not automatically purchase items, execute trades, or guarantee the lowest Market price**. Always review the actual price and quantity on Steam before buying.

## What does it do?

Selecting a **Specialized** or **Professional Killstreak Kit Fabricator** in your Steam TF2 inventory gives you a shopping plan based on its currently displayed recipe.

- **Reads the fabricator's remaining recipe.** Recognizes robot parts and the required regular or Specialized Killstreak weapon inputs, including their quantities.
- **Subtracts owned robot parts.** Checks the signed-in user's own TF2 inventory, counts the eight supported robot-part types, and removes already-covered quantities from the shopping list.
- **Searches eligible weapons by price.** Uses a publicly hosted ranking to try historically inexpensive Market names first, then checks current individual Steam sell listings.
- **Handles more than one weapon.** Professional fabricators can use two differently named weapons—or two copies of the same weapon—if those are the cheapest verified offers found.
- **Preserves recipe order in Multi-Buy.** Builds a Steam Multi-Buy URL in the order ingredients appear on the selected card, omitting parts with nothing left to buy.
- **Shows an estimated kit insta-sell value.** Reads the finished kit's highest buy order and applies an approximate 15% selling-fee deduction, so you can compare the potential return with the cost of completing the recipe.
- **Shows progress and diagnostics.** Keeps available purchase links accessible as the weapon check progresses and provides a copyable error report when something goes wrong.

If Steam cannot price a selected weapon within Multi-Buy, the script can fall back to a robot-part-only link and provide separate weapon Market links.

## Installation

**Requirements:** A desktop browser with a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/), a Steam account, and access to your Steam Community inventory and Market.

1. Install and enable Tampermonkey (or a compatible userscript manager).
2. Open **[TF2_Fabricator_Smart_Buyer.user.js](https://raw.githubusercontent.com/Maidehnless/TF2-Fabricator-Smart-Buyer/main/TF2_Fabricator_Smart_Buyer.user.js)** and approve the installation prompt. Alternatively, copy the contents of [the TXT version](./TF2_Fabricator_Smart_Buyer.txt) into a new userscript.
3. Make sure **only one copy** of this userscript is enabled.
4. Open your own [Steam inventory](https://steamcommunity.com/my/inventory/) and select the *Team Fortress 2* inventory.
5. Click a Specialized or Professional Killstreak Kit Fabricator to see its purchase options.

The script runs on Steam Community inventory pages and Steam's Market Multi-Buy page. It does not require a Steam Web API key or a GitHub account from users.

## How to use it

1. **Select a fabricator.** Its displayed recipe determines which parts and how many Killstreak weapons are needed.
2. **Review owned parts.** The script checks your inventory and shows how many robot parts you still need. Use **Refresh** beside the robot-part summary after trading, buying, or crafting.
3. **Choose a search mode.** Click **TF2 Multi-Buy Settings** beside Steam's **More...** menu.
4. **Check the weapon results.** The script searches the appropriate tier and displays currently verified candidates and their Market links. Results may improve as more entries are checked.
5. **Open Multi-Buy.** Use **Buy All** when supported, or the remaining-parts link and separate weapon links if Steam cannot combine them. **Confirm the final quantities and total on Steam** before placing any order.
6. **Compare the finished kit value.** The **Kit Insta-Sell Price** link/estimate is a guide, not a guaranteed profit calculation.

### Verification modes

| Mode | Killstreak entries checked | Best for |
| --- | ---: | --- |
| **Fast** | 10 | Getting a quick shortlist |
| **Balanced** *(default)* | 25 | General use and a wider price comparison |
| **Long** | 50 | Searching more candidates for better offers |
| **Exhaustive** | All eligible names in the required tier | Maximum available coverage, at the cost of time and requests |

These modes set the number of **ranked Market names** to inspect, not the number of copies for sale. Even Exhaustive mode may be limited by Steam errors, rate limits, changing availability, or the depth of individual listing pages. The correct description is **“cheapest verified among the listings checked,”** not “guaranteed cheapest on Steam.”

The settings popup also shows the timestamp of the published price database and offers controls to refresh live prices or the ranking.

## How prices work

There are **two separate sources of information**:

| Source | Purpose | Currency |
| --- | --- | --- |
| [`data/killstreak-prices.json`](./data/killstreak-prices.json) | Historical prices and the order in which candidate weapon names are checked | AUD reference snapshot |
| Steam Community Market | Current individual weapon listings, robot-part totals, and finished-kit buy orders | **The user's Steam wallet currency** |

The published AUD database **never changes the user's purchase currency** and is **not** a quoted checkout price. The script verifies individual sell listings, rather than assuming that two copies are available at a single advertised minimum. Prices can change or disappear after verification.

Regular and **Festivized regular** weapons compete in the same regular tier; Specialized and **Festivized Specialized** weapons compete in the Specialized tier. The exact Market names remain distinct because their URLs and individual listings differ. Not every weapon has an existing Festivized Market variant.

The userscript caches successful database downloads and can fall back to cached rankings or its internal eligible-name list if GitHub is unavailable. A publication timestamp indicates when the database file was produced, **not** when every individual weapon was last rechecked.

## What is counted in your inventory?

Only **robot parts owned by the signed-in user** are considered for automatic deduction:

| Battle-Worn | Reinforced | Pristine |
| --- | --- | --- |
| Robot Money Furnace | Robot Humor Suppression Pump | Robot Currency Digester |
| Robot Taunt Processor | Robot Emotion Detector | Robot Brainstorm Bulb |
| Robot KB-808 | Robot Bomb Stabilizer | — |

For each part, `quantity to buy = max(0, recipe requirement - owned quantity)`.

The script checks all returned inventory pages and only applies deductions when it can identify the inventory as belonging to the signed-in user. If the inventory cannot be verified or loads incompletely, it uses the full remaining recipe rather than guessing what you own.

**Owned Killstreak weapons are not checked or deducted.** Their required quantities are still priced against Market offers.

## Price database and updater

The shared database contains **550 candidate Market names**, split into **275 regular** and **275 Specialized** entries. It retains exact names, the relative search order, the last observed prices, per-item check times, and unavailable-entry information.

- **[Database JSON](./data/killstreak-prices.json)** — public data consumed by the userscript.
- **[Updater source](./updater/update_prices.py)** — standalone Python script that refreshes prices using Steam's public Market price overview data.
- **[Updater tests](./updater/test_updater.py)** — verifies database constraints, price parsing, and failure behaviour.

The updater is intentionally separate from the userscript. It maintains a useful **ranking**, while each user still checks live offers locally when selecting a fabricator. The updater preserves the last verified price when an item has no available listing or a request fails; a completely unsuccessful scan does not replace the published data.

### Run the updater manually (maintainers)

Python 3 is required; the published updater uses the standard library and has no third-party package requirements.

From the repository root:

```bash
# Validate the existing database without accessing Steam
python updater/update_prices.py --validate

# Small initial price check
python updater/update_prices.py --limit 6 --leading 2 --delay 4

# Incremental scan (default: 60 names)
python updater/update_prices.py --limit 60 --leading 8 --delay 4

# Unit tests
python -m unittest discover -s updater -p "test_*.py"
```

Review the resulting `data/killstreak-prices.json` diff before committing. The scan may be interrupted or rate-limited by Steam; do not interpret a successful Python exit as proof that every requested price was updated.

### Automate updates with GitHub Actions

To run the updater without leaving a PC on, add or enable a workflow at **`.github/workflows/update-prices.yml`** with:

- `schedule` for periodic incremental refreshes and `workflow_dispatch` for manual runs;
- a checkout step, Python setup, and a command invoking `updater/update_prices.py`;
- `permissions: contents: write` so the workflow can commit valid database updates;
- a concurrency limit to avoid overlapping publication jobs.

Once the workflow has been committed to the repository's default branch, use **Actions → your price update workflow → Run workflow** to test a small batch before enabling a larger schedule. The GitHub-hosted runner can be blocked or rate-limited by Steam, so check the logs and the database timestamps. The presence of the Python updater alone does **not** schedule it.

## Repository layout

```text
TF2-Fabricator-Smart-Buyer/
├── TF2_Fabricator_Smart_Buyer.user.js   # Installable userscript
├── TF2_Fabricator_Smart_Buyer.txt       # Text copy of the userscript
├── data/
│   └── killstreak-prices.json           # Published price priorities
├── updater/
│   ├── update_prices.py                 # Python Market price updater
│   └── test_updater.py                  # Updater tests
├── README.md
└── LICENSE
```

An optional `.github/workflows/update-prices.yml` can be added to automate publishing.

## Troubleshooting

| Issue | What to check |
| --- | --- |
| No buttons on an item | Select a supported Killstreak Kit Fabricator in the **TF2** inventory, then reload the page. |
| Owned robot parts not deducted | Confirm you're looking at your **own** inventory. Use **Refresh** and make sure Steam's inventory response is available. |
| Price database unavailable | Open the [public JSON](./data/killstreak-prices.json), try refreshing the database from Settings, or use cached ranking data. |
| Weapon search takes a long time | Use **Fast** or **Balanced**. Deeper searches involve many Market requests and may be rate-limited. |
| Weapon can't be added to Multi-Buy | Use the separate weapon listing links alongside the robot-parts Multi-Buy link. |
| Prices differ at checkout | Steam listings may have changed; the AUD ranking is historical and checkout uses your Steam wallet currency. |
| An error button appears | Open **Error Report**, copy the diagnostic log, and share it when [opening an issue](https://github.com/Maidehnless/TF2-Fabricator-Smart-Buyer/issues). Remove any personal details first. |

### Known maintenance items

- The currently published **v2.8.0** userscript's `@downloadURL` and `@updateURL` metadata point to a **hyphenated filename**, while the repository's installable file is named `TF2_Fabricator_Smart_Buyer.user.js` (underscores). The metadata should be corrected in the script before relying on automatic userscript updates.
- The v2.8.0 startup mode validation does not include `long`, although the settings dropdown offers it. Long mode may revert to Balanced on reload until the stored-value validation is updated.
- Steam's Market and inventory interfaces are not guaranteed stable. This script may need maintenance when response formats, listing fields, or page layouts change.

## Privacy and safety

The script reads the current Steam inventory and public Market data as needed to calculate missing parts and purchase options. The GitHub JSON is a shared **price ranking**, not a service where users upload their inventories. You do not need to supply a Steam password, Steam API key, or GitHub access token.

The script generates links and estimates; **purchases remain manual**. Check all item names, quantities, prices, and Steam fees before confirming a transaction. Be mindful of Steam's terms and Market request limits.

## Feedback, contributions, and license

Found a bug, incorrect recipe, or a Steam Market pricing issue? [Open a GitHub issue](https://github.com/Maidehnless/TF2-Fabricator-Smart-Buyer/issues) with the script version, reproduction steps, and a redacted diagnostic report. You can also contact [Maidehnless on Discord](https://discord.com/users/268722078633558019).

Contributions and improvements are welcome through issues and pull requests. Licensed under the **[MIT License](./LICENSE)**.

---

<sub>Team Fortress 2 and Steam are trademarks of Valve Corporation. This project is an independent community utility.</sub>
