    function escapeRegex(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function isVisible(element) {
        if (!element)
            return false;

        const style = window.getComputedStyle(element);

        return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getClientRects().length > 0
        );
    }

    // ============================================================
    // OWN ROBOT PARTS: STEAM TF2 INVENTORY SNAPSHOT
    // ============================================================

    // Security/accuracy: only subtract parts when the viewed profile is
    // demonstrably the signed-in Steam account. Other users' inventories
    // must never be counted as the viewer's own materials.
    function readSignedInSteamID() {
        // Tampermonkey page isolation varies between browsers, so prefer
        // visible page data before attempting window globals.
        const candidates = [
            document.querySelector('meta[name="steamid"]')?.content,
            document.body?.getAttribute('data-steamid')
        ];
        try { candidates.push(window.g_steamID); } catch (_) { /* isolated world */ }
        for (const value of candidates) {
            if (/^7656119\d{10}$/.test(String(value || ''))) return String(value);
        }
        // Steam embeds this variable in some inventory page layouts.
        for (const script of document.querySelectorAll('script:not([src])')) {
            const content = script.textContent || '';
            const match = content.match(/\bg_steamID\s*=\s*['"](7656119\d{10})['"]/);
            if (match) return match[1];
        }
        return null;
    }

    function currentInventoryOwnerID() {
        const numericPath = location.pathname.match(/^\/profiles\/(7656119\d{10})\/inventory\/?/i);
        if (numericPath) return numericPath[1];
        const info = [...document.querySelectorAll('[data-featuretarget="iteminfo"][data-props]')]
            .find(node => node.getClientRects().length);
        if (info) {
            try {
                const id = JSON.parse(info.getAttribute('data-props')).steamidOwner;
                if (/^7656119\d{10}$/.test(String(id || ''))) return String(id);
            } catch (_) { /* changed Steam props */ }
        }
        return null;
    }

    function isViewedInventoryOwn(steamID) {
        const signedInID = readSignedInSteamID();
        if (signedInID) return signedInID === steamID;

        // When Steam does not expose g_steamID, compare the inventory
        // page's profile URL with the signed-in user's header avatar URL.
        const headerAvatar = document.querySelector(
            '#global_actions a.user_avatar[href], #global_actions .user_avatar[href], ' +
            'a.global_actions_avatar[href]');
        if (!headerAvatar) return false;
        try {
            const signedInProfile = new URL(headerAvatar.href).pathname.replace(/\/+$/, '').toLowerCase();
            const path = location.pathname.replace(/\/inventory\/?$/i, '').replace(/\/+$/, '').toLowerCase();
            return /^\/(id|profiles)\//.test(path) && signedInProfile === path;
        } catch (_) {
            return false;
        }
    }

    function requestInventoryJSON(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url, timeout: 20000, anonymous: false,
                headers: { 'Accept': 'application/json' },
                onload: response => {
                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error('Steam inventory returned HTTP ' + response.status));
                        return;
                    }
                    try {
                        const data = JSON.parse(response.responseText);
                        if (!data || !(data.success === 1 || data.success === true || data.success === '1') ||
                            !Array.isArray(data.assets) || !Array.isArray(data.descriptions)) {
                            throw new Error('Steam returned an incomplete inventory response');
                        }
                        resolve(data);
                    } catch (error) { reject(error); }
                },
                onerror: () => reject(new Error('Steam inventory request failed')),
                ontimeout: () => reject(new Error('Steam inventory request timed out'))
            });
        });
    }

    function parseRobotPartInventoryPage(data, counts, seenAssetIDs) {
        const descriptions = new Map();
        for (const desc of data.descriptions) {
            if (!desc || desc.classid == null) continue;
            const key = String(desc.classid) + '_' + String(desc.instanceid || '0');
            descriptions.set(key, desc);
        }
        const eligibleNames = new Map(ROBOT_PARTS.map(name => [normalizeMarketName(name), name]));
        for (const asset of data.assets) {
            if (!asset || asset.classid == null) continue;
            const assetID = String(asset.assetid || asset.id || '');
            if (assetID && seenAssetIDs.has(assetID)) continue;
            if (assetID) seenAssetIDs.add(assetID);
            const key = String(asset.classid) + '_' + String(asset.instanceid || '0');
            const description = descriptions.get(key);
            if (!description) continue;
            // Only recognised robot parts. No Killstreak weapon ownership
            // detection, quality checks, or deductions are performed.
            const name = eligibleNames.get(normalizeMarketName(description.market_hash_name)) ||
                eligibleNames.get(normalizeMarketName(description.name));
            if (!name) continue;
            const amount = Number(asset.amount == null ? 1 : asset.amount);
            if (!Number.isSafeInteger(amount) || amount <= 0) continue;
            counts.set(name, (counts.get(name) || 0) + amount);
        }
    }

    function missingRobotParts(requiredParts) {
        const ready = ownedRobotInventory.status === 'ready' &&
            ownedRobotInventory.steamID === currentInventoryOwnerID() &&
            isViewedInventoryOwn(ownedRobotInventory.steamID);
        const missing = new Map();
        for (const [name, quantity] of requiredParts) {
            const owned = ready ? (ownedRobotInventory.counts.get(name) || 0) : 0;
            missing.set(name, Math.max(0, quantity - owned));
        }
        return missing;
    }

    function createOwnedRobotPartsRow() {
        const row = document.createElement('div');
        row.id = OWNED_PARTS_STATUS_ID;
        row.style.cssText = 'font:12px/1.5 Arial,sans-serif;margin-top:5px;color:#c7d5e0;' +
            'overflow-wrap:anywhere;';
        return row;
    }

    function updateOwnedRobotPartsRow(row, required) {
        if (!row) return;
        row.replaceChildren();
        const status = ownedRobotInventory.status;
        const message = document.createElement('span');
        const names = [...required.entries()].filter(([, count]) => count > 0);
        const details = [];
        if (status === 'ready') {
            let accountedFor = 0;
            let stillNeeded = 0;
            for (const [name, count] of names) {
                const owned = ownedRobotInventory.counts.get(name) || 0;
                const use = Math.min(count, owned);
                accountedFor += use;
                stillNeeded += count - use;
                details.push(name + ': need ' + count + ', owned ' + owned +
                    ', buy ' + (count - use));
            }
            message.textContent = 'Robot parts: ' + accountedFor + ' covered by inventory · ' +
                stillNeeded + ' to buy';
            message.title = details.join('\n') + '\nLast checked: ' +
                new Date(ownedRobotInventory.updatedAt).toLocaleString();
        } else if (status === 'loading' || status === 'idle') {
            message.textContent = 'Checking your owned robot parts…';
        } else if (status === 'unavailable') {
            message.textContent = 'Owned robot parts not verified — using full recipe';
            message.title = ownedRobotInventory.error;
        } else {
            message.textContent = 'Inventory scan failed — using full recipe';
            message.title = ownedRobotInventory.error;
        }
        row.appendChild(message);
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.textContent = status === 'loading' ? 'Checking…' : 'Refresh';
        refresh.disabled = status === 'loading';
        refresh.title = 'Refresh the owned robot-parts count from your Steam inventory';
        refresh.style.cssText = 'border:0;background:none;padding:0 0 0 8px;' +
            'color:#66c0f4;text-decoration:underline;cursor:pointer;font:inherit;';
        refresh.addEventListener('click', () => { refreshOwnedRobotInventory(true); });
        row.appendChild(refresh);
    }

    function notifyInventoryUpdate() {
        ownedRobotInventory.revision++;
        // The inventory snapshot changes the URLs/prices and must invalidate
        // the selected fabricator's fingerprint before re-rendering.
        currentFingerprint = '';
        runUpdateSafely();
    }

    const ownedInventoryAuto = {enabled:false,owner:null,attempts:0,readinessChecks:0,nextAt:0,timer:null};
    function ensureOwnedRobotInventory() {
        const auto=ownedInventoryAuto;
        auto.enabled=true;
        if (ownedRobotInventory.inFlight || ownedRobotInventory.status==='loading') return ownedRobotInventory.inFlight;
        const owner=currentInventoryOwnerID();
        const schedule=delay=>{
            if(auto.timer!==null) return;
            auto.timer=setTimeout(()=>{auto.timer=null;ensureOwnedRobotInventory();},delay);
        };
        if(!owner || !isViewedInventoryOwn(owner)) {
            if(ownedRobotInventory.status!=='unavailable') {
                ownedRobotInventory.status='unavailable';
                ownedRobotInventory.error='Waiting to confirm the signed-in inventory owner.';
                ownedRobotInventory.counts=new Map();
                notifyInventoryUpdate();
            }
            if(auto.readinessChecks<10) {auto.readinessChecks++;schedule(1500);}
            return Promise.resolve(null);
        }
        if(auto.owner!==owner) {
            auto.owner=owner;auto.attempts=0;auto.nextAt=0;
            clearTimeout(auto.timer);auto.timer=null;
        }
        if(ownedRobotInventory.status==='ready' && ownedRobotInventory.steamID===owner &&
            Date.now()-ownedRobotInventory.updatedAt<INVENTORY_CACHE_MS) return Promise.resolve(ownedRobotInventory.counts);
        if(auto.attempts>=3) return Promise.resolve(null);
        if(Date.now()<auto.nextAt) {schedule(auto.nextAt-Date.now());return Promise.resolve(null);}
        auto.attempts++;
        auto.nextAt=Date.now()+10000;
        return refreshOwnedRobotInventory(true).finally(()=>{
            if(ownedRobotInventory.status==='ready') {auto.attempts=0;clearTimeout(auto.timer);auto.timer=null;}
            if(ownedRobotInventory.status==='error' && auto.attempts<3) schedule(Math.max(0,auto.nextAt-Date.now()));
        });
    }

    async function refreshOwnedRobotInventory(force = false) {
        const inventory = ownedRobotInventory;
        if (inventory.inFlight) return inventory.inFlight;
        const owner = currentInventoryOwnerID();
        if (!force && inventory.status === 'ready' && inventory.steamID === owner && isViewedInventoryOwn(owner) &&
            Date.now() - inventory.updatedAt < INVENTORY_CACHE_MS) return inventory.counts;
        if (!owner || !isViewedInventoryOwn(owner)) {
            inventory.status = 'unavailable';
            inventory.error = 'Could not confirm the inventory belongs to the signed-in Steam user.';
            inventory.counts = new Map();
            notifyInventoryUpdate();
            return null;
        }
        inventory.status = 'loading';
        inventory.error = '';
        notifyInventoryUpdate();
        inventory.inFlight = (async () => {
            const counts = new Map(ROBOT_PARTS.map(name => [name, 0]));
            const seenAssetIDs = new Set();
            const seenCursors = new Set();
            let startAssetID = null;
            let pages = 0;
            let hasMore = false;
            try {
                do {
                    const url = 'https://steamcommunity.com/inventory/' + owner + '/440/2' +
                        '?l=english&count=' + INVENTORY_PAGE_SIZE +
                        (startAssetID ? '&start_assetid=' + encodeURIComponent(startAssetID) : '');
                    const data = await requestInventoryJSON(url);
                    pages++;
                    parseRobotPartInventoryPage(data, counts, seenAssetIDs);
                    hasMore = Boolean(data.more_items);
                    if (!hasMore) break;
                    const cursor = String(data.last_assetid || '');
                    if (!/^\d+$/.test(cursor) || seenCursors.has(cursor)) {
                        throw new Error('Steam inventory pagination returned an invalid cursor');
                    }
                    seenCursors.add(cursor);
                    startAssetID = cursor;
                    // Only paginated inventories incur a wait. Avoid bursts.
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } while (pages < 50);
                if (hasMore) {
                    throw new Error('Inventory pagination exceeded the safety limit');
                }
                inventory.status = 'ready';
                inventory.steamID = owner;
                inventory.counts = counts;
                inventory.updatedAt = Date.now();
                writeDiagnostic('log', '[TF2 Owned Robot Parts] Inventory scan complete:',
                    { pages, totalParts: [...counts.values()].reduce((a, b) => a + b, 0),
                        robotParts: Object.fromEntries(counts) });
                return counts;
            } catch (error) {
                inventory.status = 'error';
                inventory.error = error.message || String(error);
                inventory.counts = new Map();
                writeDiagnostic('warn', '[TF2 Owned Robot Parts] Inventory unavailable:', error);
                return null;
            } finally {
                inventory.inFlight = null;
                notifyInventoryUpdate();
            }
        })();
        return inventory.inFlight;
    }

    // ============================================================
    // READ FABRICATOR ITEM CARD
    // ============================================================
