    function normalizeMarketName(name) {
        return String(name || '')
            .normalize('NFC')
            .replace(/\u00A0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function findRequiredKillstreakWeapon(fabricator) {
        if (!fabricator || !fabricator.parent)
            return null;

        // Read exact recipe text, rather than assuming Professional always
        // needs two or Specialized always needs one.
        for (const element of fabricator.parent.querySelectorAll('div, span')) {
            if (!isVisible(element) || element.children.length > 0)
                continue;

            const text = element.textContent.replace(/\u00A0/g, ' ').trim();
            const match = text.match(
                /^Unique\s+(Specialized\s+)?Killstreak\s+Item\s*[x×]\s*(\d+)\s*$/i
            );
            if (!match)
                continue;

            const quantity = Number.parseInt(match[2], 10);
            if (!Number.isSafeInteger(quantity) || quantity < 1)
                return null;

            return {
                tier: match[1] ? 'specialized' : 'regular',
                quantity,
                recipeText: text
            };
        }
        return null;
    }

    function getRobotPartFromElement(element) {

        if (!element || element.children.length > 0)
            return null;

        const text = element.textContent
            .replace(/\u00A0/g, ' ')
            .trim();

        for (const partName of ROBOT_PARTS) {

            const regex = new RegExp(
                '^' +
                escapeRegex(partName) +
                '\\s*[x×]\\s*(\\d+)\\s*$',
                'i'
            );

            const match = text.match(regex);

            if (match) {
                return {
                    name: partName,
                    quantity: parseInt(match[1], 10)
                };
            }
        }

        return null;
    }

    function selectedItemRoot() {
        const roots = [...document.querySelectorAll('[data-featuretarget="iteminfo"], #iteminfo0, #iteminfo1, .inventory_iteminfo')]
            .filter(isVisible);
        // Nested adapters can describe the same card. Keep the outer visible root.
        const distinct = roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
        const fabricators = distinct.filter(root => /(?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit\s+Fabricator/i.test(root.textContent));
        if (fabricators.length) return fabricators.length === 1 ? fabricators[0] : null;
        // Some Steam card captures/layouts omit the legacy wrapper. Anchor at a visible
        // Fabricator heading and stop at the nearest ancestor containing its recipe.
        const candidates = [...document.querySelectorAll('h1')].filter(h => isVisible(h) &&
            /^(?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit\s+Fabricator/i.test(h.textContent.trim()));
        if (candidates.length !== 1) return null;
        for (let root=candidates[0].parentElement; root && root !== document.body; root=root.parentElement) {
            if (/The following are the inputs that must be fulfilled/.test(root.textContent)) return root;
        }
        return null;
    }

    function findFabricatorParts() {
        recipeRoot = selectedItemRoot();
        if (!recipeRoot) return null;


        const groups = new Map();

        const elements =
            recipeRoot.querySelectorAll('div, span');

        for (const element of elements) {

            if (!isVisible(element))
                continue;

            const part =
                getRobotPartFromElement(element);

            if (!part)
                continue;

            const parent =
                element.parentElement;

            if (!parent)
                continue;

            if (!groups.has(parent)) {

                groups.set(parent, {
                    parent,
                    parts: new Map(),
                    elements: []
                });

            }

            const group =
                groups.get(parent);

            group.parts.set(
                part.name,
                part.quantity
            );

            group.elements.push(element);
        }

        if (groups.size === 0)
            return null;

        const chosen = [...groups.values()].sort(
            (a, b) =>
                b.parts.size - a.parts.size
        )[0];

        chosen.orderedInputs = readOrderedFabricatorInputs(chosen.parent);
        return chosen;
    }

    // Read the fabricator's displayed ingredients in their *actual* order.
    // The market/multibuy URL order also controls Steam's displayed row order.
    // Use the visible recipe instead of the complete eight-part master list.
    function readOrderedFabricatorInputs(parent) {
        if (!parent) return [];

        const leaves = [...parent.querySelectorAll('div, span')].filter(element =>
            element.children.length === 0 && isVisible(element));
        const textAt = element => element.textContent
            .replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();

        const inputHeader = leaves.findIndex(element =>
            /^The following are the inputs that must be fulfilled\.?$/i.test(textAt(element)));
        const start = inputHeader < 0 ? 0 : inputHeader + 1;
        const outputHeader = leaves.findIndex((element, index) =>
            index >= start && /^You will receive all of the following outputs/i.test(textAt(element)));
        const end = outputHeader < 0 ? leaves.length : outputHeader;

        const ingredients = [];
        const seenParts = new Set();
        for (const element of leaves.slice(start, end)) {
            const part = getRobotPartFromElement(element);
            if (part) {
                // Recipe input lines are unique; guard against duplicate DOM
                // text without accidentally adding the same ingredient twice.
                if (part.quantity > 0 && !seenParts.has(part.name)) {
                    ingredients.push({ kind: 'part', name: part.name, quantity: part.quantity });
                    seenParts.add(part.name);
                }
                continue;
            }
            const text = textAt(element);
            const weapon = text.match(
                /^Unique\s+(Specialized\s+)?Killstreak\s+Item\s*[x×]\s*(\d+)\s*$/i
            );
            if (weapon && Number.parseInt(weapon[2], 10) > 0) {
                ingredients.push({
                    kind: 'weapon',
                    tier: weapon[1] ? 'specialized' : 'regular',
                    quantity: Number.parseInt(weapon[2], 10)
                });
            }
        }
        return ingredients;
    }

    // ============================================================
    // FIND FINISHED KILLSTREAK KIT
    // ============================================================

    function findFinishedKitName() {

        /*
         * Preferred method:
         *
         * Read the actual crafted output shown in the item card.
         *
         * Example:
         * Professional Killstreak Apoco-Fists Kit
         *
         * This is safer than relying only on the <h1> because some
         * Steam layouts/extensions can duplicate adjacent heading text.
         */
        const elements =
            (recipeRoot || selectedItemRoot() || document.createElement('div')).querySelectorAll('div, span');

        for (const element of elements) {

            if (
                !isVisible(element) ||
                element.children.length > 0
            ) {
                continue;
            }

            const text =
                element.textContent
                    .replace(/\u00A0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

            /*
             * Fabricator outputs are Specialized or Professional
             * Killstreak Kits. Exclude any text still containing
             * "Fabricator".
             */
            if (
                /^(?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit$/i.test(
                    text
                ) &&
                !/\bFabricator\b/i.test(text)
            ) {

                if (lastLoggedFinishedKitName !== text) {
                    lastLoggedFinishedKitName = text;
                    writeDiagnostic('log',
                        '[TF2 Kit BuyOrder] Finished kit found from output line:', text);
                }
                return text;
            }
        }

        /*
         * Fallback:
         *
         * Extract only the FIRST complete "... Kit Fabricator"
         * occurrence from a visible heading, then remove Fabricator.
         *
         * This deliberately does not use the entire heading text, so
         * malformed DOM text such as:
         *
         * Professional Killstreak Apoco-Fists Kit Fabricator
         * Professional Killstreak Apoco-Fists Kit
         *
         * still resolves cleanly to:
         *
         * Professional Killstreak Apoco-Fists Kit
         */
        const headings =
            (recipeRoot || selectedItemRoot() || document.createElement('div')).querySelectorAll('h1');

        for (const heading of headings) {

            if (!isVisible(heading))
                continue;

            const title =
                heading.textContent
                    .replace(/\u00A0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

            const match =
                title.match(
                    /((?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit)\s+Fabricator\b/i
                );

            if (match) {

                const kitName =
                    match[1]
                        .replace(/\s+/g, ' ')
                        .trim();

                if (lastLoggedFinishedKitName !== kitName) {
                    lastLoggedFinishedKitName = kitName;
                    writeDiagnostic('log',
                        '[TF2 Kit BuyOrder] Finished kit derived from heading:',
                        {rawHeading: title, kitName});
                }

                return kitName;
            }
        }

        writeDiagnostic('warn',
            '[TF2 Kit BuyOrder] Could not identify finished Killstreak Kit.'
        );

        return null;
    }

    function buildFinishedKitMarketURL(kitName) {

        /*
         * Final safety check: a finished kit market name must never
         * contain "Fabricator". If unexpected duplicated DOM text
         * reaches this point, extract the first valid finished-kit
         * name rather than generating a broken Steam Market URL.
         */
        const match =
            String(kitName || '')
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .match(
                    /((?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit)(?:\s+Fabricator\b)?/i
                );

        const safeKitName =
            match
                ? match[1].trim()
                : String(kitName || '').trim();

        return (
            'https://steamcommunity.com/market/listings/440/' +
            encodeURIComponent(safeKitName)
        );
    }

    // ============================================================
    // BUILD MULTIBUY URL
    // ============================================================

    function buildMultiBuyURL(parts, weapons = [], orderedInputs = null) {
        let url = 'https://steamcommunity.com/market/multibuy?appid=440&maidehn=less';

        // Each named weapon occupies one Steam row. Two listings for the same
        // weapon become quantity 2; two different weapons remain separate rows.
        const weaponCounts = new Map();
        for (const offer of weapons) {
            if (!offer || !offer.name) continue;
            weaponCounts.set(offer.name, (weaponCounts.get(offer.name) || 0) + 1);
        }

        const appendItem = (name, quantity) => {
            if (!name || !Number.isSafeInteger(quantity) || quantity <= 0) return;
            url += '&items%5B%5D=' + encodeURIComponent(name);
            url += '&qty[]=' + quantity;
        };
        const appendWeapons = () => {
            for (const [name, quantity] of weaponCounts) appendItem(name, quantity);
        };

        if (Array.isArray(orderedInputs) && orderedInputs.length > 0) {
            let addedWeaponSlot = false;
            const addedParts = new Set();
            // Preserve the exact position of every ingredient on the card.
            for (const input of orderedInputs) {
                if (input.kind === 'weapon') {
                    if (!addedWeaponSlot) {
                        appendWeapons();
                        addedWeaponSlot = true;
                    }
                } else if (input.kind === 'part' && !addedParts.has(input.name)) {
                    appendItem(input.name, Number(parts.get(input.name) || 0));
                    addedParts.add(input.name);
                }
            }
            // Defensive fallback for any ingredient Steam omitted from the
            // visible recipe parser: never silently omit a required part.
            for (const [name, quantity] of parts) {
                if (!addedParts.has(name)) appendItem(name, Number(quantity));
            }
            if (!addedWeaponSlot) appendWeapons();
        } else {
            // Fallback still follows the parts' DOM discovery order and
            // excludes all zero-quantity entries from the URL.
            for (const [name, quantity] of parts) appendItem(name, Number(quantity));
            appendWeapons();
        }
        return url;
    }

    function buildWeaponCompanionQuery(offers) {
        const params = new URLSearchParams();
        const counts = new Map();
        for (const offer of offers) {
            counts.set(offer.name, (counts.get(offer.name) || 0) + 1);
        }
        for (const [name, quantity] of counts) {
            params.append('tf2_weapon', name);
            params.append('tf2_weapon_qty', String(quantity));
        }
        return params.toString();
    }

    // ============================================================
    // PRICE PARSING
    // ============================================================

    /*
     * Converts Steam prices such as:
     *
     * A$0.05
     * A$ 0.05
     * $1.25
     * 1,25€
     *
     * into minor currency units.
     *
     * For AUD:
     *
     * A$0.05 -> 5
     * A$1.25 -> 125
     */
