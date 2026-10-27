    const PRICE_UPDATE_STATE_URL = PRICE_DB_URL.replace('killstreak-prices.json', 'update-prices-state.json');
    const priceUpdateSchedule = {status: 'idle', data: null, error: '', loadedAt: 0, inFlight: null};

    function loadPriceUpdateSchedule(force = false) {
        if (priceUpdateSchedule.inFlight) return priceUpdateSchedule.inFlight;
        if (!force && Date.now() - priceUpdateSchedule.loadedAt < 60000) return Promise.resolve();
        priceUpdateSchedule.status = 'loading';
        updatePriceDatabaseSettingsUI();
        // Only reads GitHub's public checkpoint; never contacts Steam.
        priceUpdateSchedule.inFlight = new Promise(resolve => {
            const fail = message => {
                priceUpdateSchedule.status = 'unavailable';
                priceUpdateSchedule.error = message;
                resolve();
            };
            try {
                GM_xmlhttpRequest({
                    method: 'GET', url: PRICE_UPDATE_STATE_URL + '?t=' + Date.now(),
                    timeout: 15000, anonymous: true, headers: {Accept: 'application/json'},
                    onload: response => {
                        try {
                            if (response.status !== 200) throw new Error('GitHub HTTP ' + response.status);
                            const data = JSON.parse(response.responseText);
                            const date = data.status === 'retrying' ? data.nextAttemptAtUTC : data.nextCycleAtUTC;
                            if (data.schema !== 'maidehnless.tf2.price-updater-state.v1' ||
                                !['retrying', 'complete'].includes(data.status) ||
                                typeof date !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(date) ||
                                !Number.isFinite(Date.parse(date)) ||
                                !Number.isInteger(data.cycle?.completed) || !Number.isInteger(data.cycle?.total) ||
                                data.cycle.completed < 0 || data.cycle.completed > data.cycle.total ||
                                data.cycle.total < 1 || data.cycle.total > 550)
                                throw new Error('Invalid updater schedule');
                            priceUpdateSchedule.data = data;
                            priceUpdateSchedule.status = 'ready';
                            priceUpdateSchedule.error = '';
                            resolve();
                        } catch (error) { fail(error.message); }
                    },
                    onerror: () => fail('Could not read GitHub updater status'),
                    ontimeout: () => fail('GitHub status request timed out')
                });
            } catch (error) { fail(error.message); }
        }).finally(() => {
            priceUpdateSchedule.loadedAt = Date.now();
            priceUpdateSchedule.inFlight = null;
            updatePriceDatabaseSettingsUI();
        });
        return priceUpdateSchedule.inFlight;
    }

    function updatePriceScheduleUI() {
        const next = document.getElementById('tf2-price-db-next-update');
        const detail = document.getElementById('tf2-price-db-schedule-status');
        if (!next || !detail) return;
        if (priceUpdateSchedule.status !== 'ready') {
            next.textContent = priceUpdateSchedule.status === 'unavailable' ? 'Unavailable' : 'Loading schedule…';
            detail.textContent = priceUpdateSchedule.error || 'Reading the public GitHub updater checkpoint.';
            return;
        }
        const data = priceUpdateSchedule.data;
        const retry = data.status === 'retrying';
        next.textContent = formatLocalDatabaseTimestamp(retry ? data.nextAttemptAtUTC : data.nextCycleAtUTC);
        detail.textContent = 'GitHub scheduling and Steam limits can delay completion.\n' +
            'Previous issue: ' + (data.lastError ? String(data.lastError).slice(0, 300) : 'None reported.');
    }

    function validatePublishedPriceDatabase(data) {
        if (!data || data.schema !== 'maidehnless.tf2.killstreak_priority.v1' ||
            !['USD','AUD'].includes(data.currency) || !Array.isArray(data.prices) || data.prices.length !== 550 ||
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
        priceDatabase.currency = data.currency;
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

    // UTC remains the storage format. Date getters apply the viewer's local zone only for display.
    function formatLocalDatabaseTimestamp(value) {
        if (!value) return 'Not loaded';
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return 'Invalid timestamp';
        const pad = number => String(number).padStart(2, '0');
        const hours = date.getHours();
        return pad(hours % 12 || 12) + ':' + pad(date.getMinutes()) +
            (hours < 12 ? ' am, ' : ' pm, ') + pad(date.getDate()) + '/' +
            pad(date.getMonth() + 1) + '/' + date.getFullYear();
    }

    function formatPublishedTimestamp() {
        return formatLocalDatabaseTimestamp(priceDatabase.generatedAt);
    }

    function updatePriceDatabaseSettingsUI() {
        updatePriceScheduleUI();
        const status = document.getElementById('tf2-price-db-last-updated');
        if (status) status.textContent = formatPublishedTimestamp();
        const description = document.getElementById('tf2-price-db-status');
        if (description) description.textContent = priceDatabase.error
            ? ('Cached / offline: ' + priceDatabase.error)
            : priceDatabase.status === 'ready' ? 'Published GitHub priority list loaded (' + priceDatabase.currency + (priceDatabase.currency === 'AUD' ? ' legacy ranking)' : ' snapshot)') :
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
        for (const [value, text] of [['fast', 'Fast — 10 Killstreak entries'],
            ['balanced', 'Balanced — 25 Killstreak entries'],
            ['long', 'Long — 50 Killstreak entries'],
            ['exhaustive', 'Exhaustive — all Killstreak entries']]) {
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
        const updated = document.createElement('strong');
        updated.id = 'tf2-price-db-previous-label';
        updated.textContent = 'Previous DB Update';
        updated.style.cssText = 'display:block;color:white;';
        popup.appendChild(updated);
        const stamp = document.createElement('div');
        stamp.id = 'tf2-price-db-last-updated';
        stamp.style.cssText = 'color:white;font-weight:bold;';
        popup.appendChild(stamp);
        const state = document.createElement('div');
        state.id = 'tf2-price-db-status';
        state.style.cssText = 'font-size:11px;color:#a8b9c7;margin:3px 0 10px;';
        popup.appendChild(state);
        const nextLabel = document.createElement('strong');
        nextLabel.id = 'tf2-price-db-next-label';
        nextLabel.textContent = 'Next DB Update';
        nextLabel.style.cssText = 'display:block;color:white;';
        popup.appendChild(nextLabel);
        const next = document.createElement('div');
        next.id = 'tf2-price-db-next-update';
        next.style.cssText = 'color:white;font-weight:bold;';
        popup.appendChild(next);
        const schedule = document.createElement('div');
        schedule.id = 'tf2-price-db-schedule-status';
        schedule.style.cssText = 'white-space:pre-line;font-size:11px;color:#a8b9c7;margin:3px 0 10px;max-width:340px;';
        popup.appendChild(schedule);
        const workflow = document.createElement('a');
        workflow.href = 'https://github.com/Maidehnless/TF2-Fabricator-Smart-Buyer/actions/workflows/update-prices.yml';
        workflow.target = '_blank';
        workflow.rel = 'noopener noreferrer';
        workflow.textContent = 'View updater runs on GitHub';
        workflow.style.cssText = 'display:block;margin-bottom:10px;color:#67c1f5;';
        popup.appendChild(workflow);
        const refresh = document.createElement('button');
        refresh.type = 'button';
        refresh.textContent = 'Check GitHub for update';
        refresh.style.cssText = 'padding:6px 9px;background:#375877;border:1px solid #6388a0;' +
            'color:#fff;border-radius:3px;cursor:pointer;';
        refresh.addEventListener('click', async () => {
            refresh.disabled = true;
            await Promise.all([loadPublishedPriceDatabase(true), loadPriceUpdateSchedule(true)]);
            refresh.disabled = false;
            currentFingerprint = '';
            runUpdateSafely();
        });
        popup.appendChild(refresh);
        wrap.appendChild(popup);
        trigger.addEventListener('click', () => {
            popup.hidden = !popup.hidden;
            trigger.setAttribute('aria-expanded', String(!popup.hidden));
            if (!popup.hidden) {
                updatePriceScheduleUI();
                loadPriceUpdateSchedule();
            }
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
