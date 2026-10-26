    function validatePublishedPriceDatabase(data) {
        if (!data || data.schema !== 'maidehnless.tf2.killstreak_priority.v1' ||
            data.currency !== 'AUD' || !Array.isArray(data.prices) || data.prices.length !== 550 ||
            !data.priority || !Array.isArray(data.priority.regular) ||
            !Array.isArray(data.priority.specialized)) {
            throw new Error('GitHub price database has an unexpected format.');
        }
        for (const tier of ['regular', 'specialized']) {
            const names = data.priority[tier];
            if (names.length !== 275 || new Set(names).size !== 275 ||
                names.some(name => !ELIGIBLE_INPUT_WEAPONS[tier].has(name)))
                throw new Error('Invalid published ' + tier + ' priority array.');
        }
        const seen = new Set();
        for (const row of data.prices) {
            if (!row || !ELIGIBLE_INPUT_WEAPONS[row.tier]?.has(row.name) || seen.has(row.name) ||
                !['priced', 'unavailable'].includes(row.status) ||
                (row.status === 'priced' && (!Number.isFinite(row.price) || row.price <= 0 ||
                    !Number.isFinite(Date.parse(row.checkedAtUTC)))))
                throw new Error('Invalid or duplicate published price row.');
            seen.add(row.name);
        }
        if (!data.generatedAtUTC || !Number.isFinite(Date.parse(data.generatedAtUTC)))
            throw new Error('Price database does not have a valid publication timestamp.');
        return data;
    }

    function applyPublishedPriceDatabase(data) {
        const previous = priceDatabase.generatedAt;
        priceDatabase.priority = data.priority;
        priceDatabase.rows = new Map(data.prices.map(item => [item.name, item]));
        priceDatabase.generatedAt = data.latestPublishedUTC || data.generatedAtUTC;
        priceDatabase.status = 'ready';
        priceDatabase.error = '';
        priceDatabase.loadedAt = Date.now();
        if (previous !== priceDatabase.generatedAt) {
            currentFingerprint = '';
        }
        updatePriceDatabaseSettingsUI();
    }

    function loadPublishedPriceDatabase(force = false) {
        if (priceDatabaseInFlight) return priceDatabaseInFlight;
        priceDatabaseInFlight = fetchPublishedPriceDatabase(force).finally(() => { priceDatabaseInFlight = null; });
        return priceDatabaseInFlight;
    }

    function fetchPublishedPriceDatabase(force = false) {
        if (!force && priceDatabase.status === 'ready' &&
            Date.now() - priceDatabase.loadedAt < PRICE_DB_REFRESH_MS) return Promise.resolve();
        priceDatabase.status = priceDatabase.priority ? 'ready' : 'loading';
        updatePriceDatabaseSettingsUI();
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: PRICE_DB_URL + '?t=' + Date.now(),
                timeout: 15000,
                anonymous: true,
                headers: { Accept: 'application/json' },
                onload: response => {
                    try {
                        if (response.status !== 200) throw new Error('GitHub HTTP ' + response.status);
                        const json = validatePublishedPriceDatabase(JSON.parse(response.responseText));
                        applyPublishedPriceDatabase(json);
                        GM_setValue(PRICE_DB_CACHE_KEY, json);
                        writeDiagnostic('log', '[TF2 Price Database] Published snapshot:', priceDatabase.generatedAt);
                    } catch (error) {
                        priceDatabase.error = error.message;
                        if (!priceDatabase.priority) priceDatabase.status = 'unavailable';
                        writeDiagnostic('warn', '[TF2 Price Database] Could not load live snapshot:', error.message);
                    }
                    updatePriceDatabaseSettingsUI();
                    resolve();
                },
                ontimeout: () => {
                    priceDatabase.error = 'GitHub request timed out';
                    if (!priceDatabase.priority) priceDatabase.status = 'unavailable';
                    updatePriceDatabaseSettingsUI();
                    resolve();
                },
                onerror: () => {
                    priceDatabase.error = 'GitHub request failed (repository may still be private)';
                    if (!priceDatabase.priority) priceDatabase.status = 'unavailable';
                    updatePriceDatabaseSettingsUI();
                    resolve();
                }
            });
        });
    }

    function formatPublishedTimestamp() {
        if (!priceDatabase.generatedAt) return 'Not loaded';
        const date = new Date(priceDatabase.generatedAt);
        return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Invalid timestamp';
    }

    function updatePriceDatabaseSettingsUI() {
        const status = document.getElementById('tf2-price-db-last-updated');
        if (status) status.textContent = formatPublishedTimestamp();
        const description = document.getElementById('tf2-price-db-status');
        if (description) description.textContent = priceDatabase.error
            ? ('Cached / offline: ' + priceDatabase.error)
            : priceDatabase.status === 'ready' ? 'Published GitHub priority list loaded (AUD snapshot)' :
                priceDatabase.status === 'loading' ? 'Loading price list…' : 'No published price list available';
    }

    function createInventoryPriceSettings() {
        const more = document.getElementById('inventory_more_dselect_container');
        if (!more || document.getElementById('tf2-fabricator-settings')) return;
        const wrap = document.createElement('div');
        wrap.id = 'tf2-fabricator-settings';
        wrap.style.cssText = 'display:inline-block;position:relative;vertical-align:middle;margin:0 8px;float:right;';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'trigger';
        trigger.textContent = 'TF2 Multi-Buy Settings';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.style.cssText = 'cursor:pointer;white-space:nowrap;';
        wrap.appendChild(trigger);
        const popup = document.createElement('div');
        popup.setAttribute('role', 'dialog');
        popup.setAttribute('aria-label', 'TF2 Multi-Buy Settings');
        popup.hidden = true;
        popup.style.cssText = 'position:absolute;right:0;top:calc(100% + 6px);z-index:999999;min-width:300px;' +
            'padding:14px;background:#1b2838;color:#c7d5e0;border:1px solid #526477;' +
            'border-radius:4px;box-shadow:0 10px 30px #0008;text-align:left;font:13px/1.5 Arial,sans-serif;';
        const heading = document.createElement('strong');
        heading.textContent = 'TF2 Multi-Buy Settings';
        heading.style.cssText = 'display:block;font-size:15px;color:white;margin-bottom:10px;';
        popup.appendChild(heading);
        const label = document.createElement('label');
        label.textContent = 'Weapon verification mode';
        label.style.cssText = 'display:block;font-weight:bold;margin-bottom:4px;';
        const select = document.createElement('select');
        select.style.cssText = 'width:100%;padding:5px;background:#101822;color:#fff;border:1px solid #526477;';
        for (const [value, text] of [['fast', 'Fast — 4 ranked names'],
            ['balanced', 'Balanced — 10 ranked names'],
            ['exhaustive', 'Exhaustive — all eligible weapons']]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            select.appendChild(option);
        }
        select.value = weaponVerificationMode;
        select.addEventListener('change', () => {
            weaponVerificationMode = select.value;
            GM_setValue(MODE_STORAGE_KEY, weaponVerificationMode);
            currentFingerprint = '';
            runUpdateSafely();
        });
        label.appendChild(select);
        popup.appendChild(label);
        const note = document.createElement('div');
        note.textContent = 'Live checks use your own Steam wallet currency. ' +
            'The GitHub AUD prices determine search priority only, never a guaranteed checkout price.';
        note.style.cssText = 'color:#a8b9c7;font-size:11px;margin:8px 0 14px;';
        popup.appendChild(note);
        const refreshPrices = document.createElement('button');
        refreshPrices.type = 'button';
        refreshPrices.textContent = 'Refresh live prices';
        refreshPrices.style.cssText = 'padding:5px 8px;margin-bottom:12px;cursor:pointer;';
        refreshPrices.addEventListener('click', () => {
            marketClient.clear();
            weaponSearchCache.clear();
            buyOrderCache.clear();
            currentFingerprint = '';
            runUpdateSafely();
        });
        popup.appendChild(refreshPrices);
        const updated = document.createElement('div');
        updated.textContent = 'Latest price database:';
        popup.appendChild(updated);
        const stamp = document.createElement('div');
        stamp.id = 'tf2-price-db-last-updated';
        stamp.style.cssText = 'color:white;font-weight:bold;';
        popup.appendChild(stamp);
        const state = document.createElement('div');
        state.id = 'tf2-price-db-status';
        state.style.cssText = 'font-size:11px;color:#a8b9c7;margin:3px 0 10px;';
        popup.appendChild(state);
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.textContent = 'Check GitHub for update';
        refresh.style.cssText = 'padding:6px 9px;background:#375877;border:1px solid #6388a0;' +
            'color:#fff;border-radius:3px;cursor:pointer;';
        refresh.addEventListener('click', async () => {
            refresh.disabled = true;
            await loadPublishedPriceDatabase(true);
            refresh.disabled = false;
            currentFingerprint = '';
            runUpdateSafely();
        });
        popup.appendChild(refresh);
        wrap.appendChild(popup);
        trigger.addEventListener('click', () => {
            popup.hidden = !popup.hidden;
            trigger.setAttribute('aria-expanded', String(!popup.hidden));
        });
        document.addEventListener('click', event => {
            if (!wrap.contains(event.target)) { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') { popup.hidden = true; trigger.setAttribute('aria-expanded', 'false'); }
        });
        // Float-right elements are laid out right-to-left. Insert before More
        // so this control appears immediately to its visual right.
        more.insertAdjacentElement('beforebegin', wrap);
        updatePriceDatabaseSettingsUI();
    }
