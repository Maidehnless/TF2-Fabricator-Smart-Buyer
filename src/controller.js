    async function updateMultiBuyButton() {
        const fabricator = findFabricatorParts();
        const kitName = fabricator ? findFinishedKitName() : null;
        const weaponRequirement = fabricator ? findRequiredKillstreakWeapon(fabricator) : null;

        let button = document.getElementById(BUTTON_ID);
        let kitButton = document.getElementById(KIT_BUTTON_ID);
        let buttonContainer = document.getElementById(BUTTON_CONTAINER_ID);
        let buttonSpacer = document.getElementById(BUTTON_SPACER_ID);
        let weaponInfo = document.getElementById(WEAPON_INPUT_ID);
        let ownedInfo = document.getElementById(OWNED_PARTS_STATUS_ID);

        if (!fabricator) {
            weaponScanController?.abort();
            currentFingerprint = '';
            lookupID++;
            if (buttonContainer)
                buttonContainer.remove();
            else {
                if (button) button.remove();
                if (kitButton) kitButton.remove();
            }
            if (buttonSpacer) buttonSpacer.remove();
            if (weaponInfo) weaponInfo.remove();
            if (ownedInfo) ownedInfo.remove();
            return;
        }

        const fingerprint =
            'verify:' + weaponVerificationMode + '|' + priceDatabase.generatedAt + '|' +
            'owned-revision:' + ownedRobotInventory.revision + '|' +
            (kitName || '') + '|' +
            (weaponRequirement ? weaponRequirement.tier + ':' + weaponRequirement.quantity : 'missing') + '|' +
            ROBOT_PARTS.map(name => name + ':' + (fabricator.parts.get(name) || 0)).join('|') + '|' +
            fabricator.orderedInputs.map(input =>
                input.kind === 'part' ? 'part:' + input.name + ':' + input.quantity :
                    'weapon:' + input.tier + ':' + input.quantity).join('|');

        if (fingerprint === currentFingerprint && button && kitButton && buttonContainer) {
            ensureErrorReportButton();
            return;
        }

        currentFingerprint = fingerprint;
        weaponScanController?.abort();
        weaponScanController = new AbortController();
        const signal = weaponScanController.signal;
        const thisLookupID = ++lookupID;
        const partsToBuy = missingRobotParts(fabricator.parts);
        const robotURL = buildMultiBuyURL(partsToBuy, [], fabricator.orderedInputs);
        const robotRowCount = [...partsToBuy.values()].filter(qty => qty > 0).length;
        const partsButtonLabel = ownedRobotInventory.status === 'ready'
            ? 'Buy Missing Parts' : 'Buy Parts';
        let robotTotalFormatted = null;

        if (!button) button = createButton();
        button.onclick = null;
        button.onauxclick = null;
        if (robotRowCount && !['idle','loading'].includes(ownedRobotInventory.status)) button.href = robotURL;
        else button.removeAttribute('href');
        button.textContent = ownedRobotInventory.status === 'loading'
            ? 'Checking owned parts…' : robotRowCount ? partsButtonLabel + ' (...)' :
                'Robot Parts (Already owned)';
        button.title = 'Checking robot-part prices and the cheapest required weapon';

        if (!kitButton) kitButton = createKitButton();
        if (kitName) {
            kitButton.href = buildFinishedKitMarketURL(kitName);
            kitButton.textContent = 'Kit Insta-Sell Price (...)';
            kitButton.title = 'Checking the highest Steam buy order after estimated 15% tax.';
        } else {
            kitButton.removeAttribute('href');
            kitButton.textContent = 'Kit Insta-Sell Price (Kit not found)';
            kitButton.title = 'Could not identify the finished kit.';
            writeDiagnostic('error', '[TF2 Kit BuyOrder] Could not identify the finished kit.');
        }

        const lastPartElement = fabricator.elements[fabricator.elements.length - 1];
        if (lastPartElement) {
            if (!buttonSpacer) {
                buttonSpacer = createButtonSpacer(lastPartElement);
                lastPartElement.insertAdjacentElement('afterend', buttonSpacer);
            }
            if (!buttonContainer) {
                buttonContainer = createButtonContainer();
                buttonSpacer.insertAdjacentElement('afterend', buttonContainer);
            }
            buttonContainer.appendChild(button);
            buttonContainer.appendChild(kitButton);

            if (!ownedInfo) ownedInfo = createOwnedRobotPartsRow();
            buttonContainer.insertAdjacentElement('afterend', ownedInfo);
            if (!weaponInfo) weaponInfo = createWeaponInputRow();
            ownedInfo.insertAdjacentElement('afterend', weaponInfo);
            updateOwnedRobotPartsRow(ownedInfo, fabricator.parts);

            ensureErrorReportButton();
        }

        const refit = () => {
            if (buttonContainer && buttonContainer.isConnected)
                requestAnimationFrame(() => fitButtonsToContainer(
                    buttonContainer, ...buttonContainer.querySelectorAll('a')
                ));
        };
        refit();

        if (weaponRequirement) {
            setWeaponInputStatus(weaponInfo,
                'Searching Steam for cheapest ' + (weaponRequirement.tier === 'specialized' ? 'Specialized ' : '') +
                'Killstreak weapon × ' + weaponRequirement.quantity + ' ...'
            );
        } else {
            setWeaponInputStatus(weaponInfo, 'Weapon requirement not detected — robot parts only.');
            writeDiagnostic('error',
                '[TF2 Input Weapon] No "Unique Killstreak Item" or "Unique Specialized Killstreak Item" requirement found.'
            );
        }

        // Prevent a full-recipe purchase link being used while owned quantities
        // are still loading. A finished or failed scan restarts this update.
        if (ownedRobotInventory.status === 'loading' || ownedRobotInventory.status === 'idle') {
            if (weaponRequirement) {
                setWeaponInputStatus(weaponInfo, 'Weapon-price lookup will continue after inventory check.');
            }
            return;
        }

        let searchInProgress = Boolean(weaponRequirement);
        let lastProgress = null;
        const updateProvisionalCheckout = progress => {
            lastProgress = progress;
            const selected = progress.offers.slice(0,weaponRequirement.quantity);
            if (!selected.length) return;
            button.href = buildMultiBuyURL(partsToBuy,selected,fabricator.orderedInputs) + '&' +
                buildWeaponCompanionQuery(selected);
            const complete = selected.length === weaponRequirement.quantity;
            button.textContent = (complete ? 'Buy All' : 'Buy Found Items') + ' (' +
                selected.length + '/' + weaponRequirement.quantity + ' weapons' +
                (searchInProgress ? ' · searching…' : '') + ')';
            button.title = 'Open Multi-Buy with the lowest-priced weapon offers found so far.';
            refit();
        };
        const confirmSearchProgress = event => {
            if (event.type === 'auxclick' && event.button !== 1) return;
            if (thisLookupID !== lookupID || signal.aborted) { event.preventDefault(); return; }
            if (!searchInProgress || !button.hasAttribute('href')) return;
            const found = lastProgress?.offers.slice(0,weaponRequirement.quantity) || [];
            const progress = lastProgress ? lastProgress.attempted + '/' + lastProgress.budget : '0';
            const message = 'Weapon price search is still running.\n\n' +
                'Killstreak entries checked: ' + progress + '\n' +
                'Weapon offers found: ' + found.length + '/' + weaponRequirement.quantity + '\n\n' +
                (found.length ? found.map(o => o.name + ' — ' + o.priceText).join('\n') + '\n\n' : '') +
                (found.length < weaponRequirement.quantity ? 'This link does not yet include every required weapon.\n\n' : '') +
                'You can open Multi-Buy now with the items found so far. The search will continue on this inventory tab and may find cheaper offers.\n\nOpen Multi-Buy now?';
            if (!window.confirm(message)) event.preventDefault();
        };
        button.onclick = confirmSearchProgress;
        button.onauxclick = confirmSearchProgress;

        writeDiagnostic('log', '[TF2 MultiBuy] Required robot parts:', Object.fromEntries(fabricator.parts));
        writeDiagnostic('log', '[TF2 MultiBuy] Missing robot parts:', Object.fromEntries(partsToBuy));
        writeDiagnostic('log', '[TF2 MultiBuy] Recipe URL order:', fabricator.orderedInputs.map(item =>
            item.kind === 'weapon' ? 'Weapon slot × ' + item.quantity : item.name + ' × ' + item.quantity));
        writeDiagnostic('log', '[TF2 Input Weapon] Exact requirement:', weaponRequirement);
        writeDiagnostic('log', '[TF2 Kit BuyOrder] Finished kit:', kitName);

        // Preserve the existing robot-only price display and link while
        // the search is working. Never include an unpriced item in that total.
        const partsPricePromise = robotRowCount === 0
            ? Promise.resolve()
            : getMultiBuyTotal(robotURL, robotRowCount, {signal})
                .then(result => {
                    if (thisLookupID !== lookupID) return;
                    robotTotalFormatted = result.formatted;
                    button.textContent = partsButtonLabel + ' (' + result.formatted + ')';
                    button.title = 'Price of missing robot parts only. Weapon search may update this link.';
                    refit();
                    if (lastProgress?.offers.length) updateProvisionalCheckout(lastProgress);
                    writeDiagnostic('log', '[TF2 MultiBuy] Missing robot-parts total:', result.formatted);
                })
                .catch(error => {
                    if (thisLookupID !== lookupID) return;
                    writeDiagnostic('error', '[TF2 MultiBuy] ROBOT PRICE ERROR:', error);
                    button.textContent = partsButtonLabel + ' (Price unavailable)';
                    button.title = error.message;
                    if (lastProgress?.offers.length) updateProvisionalCheckout(lastProgress);
                    refit();
                });

        // Let the original robot-price request finish before updating
        // the combined label so it cannot overwrite the new total.
        const weaponPricePromise = weaponRequirement
            ? getCheapestInputWeapon(weaponRequirement.tier, weaponRequirement.quantity, {signal,
                onProgress: progress => {
                    if (thisLookupID !== lookupID || signal.aborted) return;
                    if (progress.offers.length) showSelectedWeaponOffers(weaponInfo, progress.offers, false);
                    else weaponInfo.replaceChildren();
                    const status = document.createElement('div');
                    status.textContent = 'Checking Killstreak entries: ' + progress.attempted + '/' + progress.budget +
                        ' · ' + progress.offers.length + '/' + weaponRequirement.quantity + ' offers available so far';
                    status.style.color = '#a8b9c7';
                    weaponInfo.appendChild(status);
                    updateProvisionalCheckout(progress);
                }})
                .then(async selection => {
                    if (thisLookupID !== lookupID) return;
                    searchInProgress = false;
                    await partsPricePromise;
                    if (thisLookupID !== lookupID) return;

                    const selected = selection.offers.slice(0, weaponRequirement.quantity);
                    const partial = selected.length < weaponRequirement.quantity;
                    const purchaseLabel = partial ? 'Buy Found Items (' + selected.length + '/' +
                        weaponRequirement.quantity + ' weapons)' : 'Buy All';
                    const companionParams = buildWeaponCompanionQuery(selected);
                    const combinedURL = buildMultiBuyURL(partsToBuy, selected, fabricator.orderedInputs);
                    const estimate = (() => {
                        const parts = parseSteamPrice(robotTotalFormatted);
                        const sample = parseSteamPrice(selected[0].priceText);
                        if (!sample || (robotRowCount > 0 && !parts) || !selected.every(offer => {
                            const parsed = parseSteamPrice(offer.priceText);
                            const format = parts ? parts.format : sample.format;
                            return parsed && parsed.format.prefix === format.prefix &&
                                parsed.format.suffix === format.suffix &&
                                parsed.format.decimals === format.decimals;
                        })) return '';
                        const format = parts ? parts.format : sample.format;
                        return formatSteamCurrency((parts ? parts.minorUnits : 0) +
                            selected.reduce((total, offer) => total + offer.price, 0), format);
                    })();
                    showSelectedWeaponOffers(weaponInfo, selected,
                        false, estimate);
                    if (partial) {
                        const incomplete = document.createElement('div');
                        incomplete.textContent = 'Only ' + selected.length + ' weapon offer(s) found; need ' +
                            weaponRequirement.quantity + '. This checkout includes only the found quantity.';
                        weaponInfo.appendChild(incomplete);
                    }
                    const coverage = document.createElement('div');
                    coverage.textContent = selection.checked + '/' + selection.total + ' Killstreak entries checked · ' +
                        selection.failures + ' failed' + (selection.stopped ? ' · verification stopped early' : '') +
                        ' · offers checked ' + new Date(Math.min(...selected.map(o => o.verifiedAt))).toLocaleTimeString();
                    coverage.style.color = '#a8b9c7';
                    weaponInfo.appendChild(coverage);
                    const combinedWithNotes = combinedURL + '&' + companionParams;
                    button.href = combinedWithNotes;
                    button.textContent = purchaseLabel + ' (Checking...)';
                    button.title = 'Robot parts plus ' + selected.length +
                        ' individually priced Killstreak weapon offers. Confirm market availability.';
                    refit();

                    try {
                        // Every DIFFERENT weapon market name must appear on
                        // the native Multi-Buy page; two same-name listings
                        // share one row with qty 2.
                        const uniqueWeaponCount = new Set(selected.map(offer => offer.name)).size;
                        const total = await getMultiBuyTotal(combinedURL,
                            robotRowCount + uniqueWeaponCount, {signal});
                        if (thisLookupID !== lookupID) return;
                        // Individual offers may have different prices, so a
                        // Multi-Buy quantity×minimum total can be misleading.
                        button.textContent = purchaseLabel + ' (' + (estimate || total.formatted) +
                            (estimate ? ' est.' : '') + ')';
                        button.title = 'Robot parts + selected weapon listings. ' +
                            (estimate ? 'Estimate uses individual listing prices; ' : '') +
                            'verify prices and quantities on Steam before confirming.';
                        writeDiagnostic('log', '[TF2 MultiBuy] Individual-offer cost:',
                            {offers: selected.map(o => [o.name, o.priceText]),
                                estimatedTotal: estimate || '(unknown)', steamTotal: total.formatted});
                    } catch (error) {
                        if (thisLookupID !== lookupID) return;
                        // Keep existing robot-part checkout functional if
                        // Steam will not put weapon(s) in native Multi-Buy.
                        if (robotRowCount) button.href = robotURL + '&' + companionParams;
                        else button.removeAttribute('href');
                        button.textContent = robotRowCount === 0
                            ? 'Robot Parts (Already owned)'
                            : robotTotalFormatted
                                ? partsButtonLabel + ' (' + robotTotalFormatted + ')'
                                : partsButtonLabel + ' (Weapon separate)';
                        button.title = 'Steam could not price all weapon types in Multi-Buy: ' + error.message +
                            '. Weapon Market links are listed below.';
                        writeDiagnostic('warn', '[TF2 Input Weapon] Weapon(s) require separate purchase:',
                            error.message);
                    }
                    refit();
                })
                .catch(error => {
                    if (thisLookupID !== lookupID || error.name === 'AbortError') return;
                    setWeaponInputStatus(weaponInfo,
                        'Automatic weapon search unavailable — open Steam Market search',
                        buildWeaponMarketSearchURL(weaponRequirement.tier, 0), error.message);
                    if (robotRowCount) button.href = robotURL;
                    else button.removeAttribute('href');
                    button.textContent = robotRowCount ? partsButtonLabel + (robotTotalFormatted ? ' (' + robotTotalFormatted + ')' : '') : 'Robot Parts (Already owned)';
                    writeDiagnostic('error', '[TF2 Input Weapon] SEARCH ERROR:', error);
                })
                .finally(() => { searchInProgress = false; })
            : Promise.resolve();

        const kitPricePromise = kitName
            ? getFinishedKitHighestBuyOrder(kitName, {signal})
                .then(result => {
                    if (thisLookupID !== lookupID) return;
                    kitButton.href = result.listingURL;
                    kitButton.textContent = 'Kit Insta-Sell Price (' + result.formattedPrice + ')';
                    kitButton.title = 'Highest buy order: ' + result.highestBuyOrderFormatted +
                        '. Displayed price deducts an estimated 15% Steam fee.';
                    refit();
                })
                .catch(error => {
                    if (thisLookupID !== lookupID) return;
                    writeDiagnostic('error', '[TF2 Kit BuyOrder] PRICE ERROR:', error);
                    kitButton.textContent = 'Kit Insta-Sell Price (Unavailable)';
                    kitButton.title = error.message;
                    refit();
                })
            : Promise.resolve();

        await Promise.allSettled([partsPricePromise, weaponPricePromise, kitPricePromise]);
    }

    // ============================================================
    // COMPANION NOTE ON STEAM'S MULTI-BUY PAGE
    // ============================================================

    function initMultiBuyWeaponPanel() {
        const params = new URLSearchParams(window.location.search);
        const names = params.getAll('tf2_weapon');
        const quantities = params.getAll('tf2_weapon_qty');
        const weapons = names.map((name, index) => ({
            name, quantity: Number.parseInt(quantities[index] || '1', 10)
        })).filter(x => x.name && Number.isSafeInteger(x.quantity) &&
            x.quantity >= 1 && x.quantity <= 10);
        if (!weapons.length) return;
        const panel = document.createElement('div');
        panel.id = MULTIBUY_WEAPON_PANEL_ID;
        panel.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:999999;' +
            'width:min(340px,90vw);padding:12px 14px;background:#1b2838;color:#d6d7d8;' +
            'border:1px solid #53606d;border-radius:5px;box-shadow:0 8px 28px #0009;' +
            'font:13px/1.5 Arial,sans-serif;';
        const heading = document.createElement('strong');
        heading.textContent = 'Required Killstreak weapons';
        panel.appendChild(heading);
        for (const weapon of weapons) {
            const link = document.createElement('a');
            link.href = 'https://steamcommunity.com/market/listings/440/' +
                encodeURIComponent(weapon.name);
            link.textContent = weapon.name + ' × ' + weapon.quantity;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.cssText = 'display:block;margin-top:6px;color:#66c0f4;text-decoration:underline;';
            panel.appendChild(link);
        }
        const note = document.createElement('div');
        note.style.marginTop = '7px';
        note.textContent = 'Confirm all weapons and quantities appear in the ' +
            'Steam Multi-Buy table. If missing, purchase through the links above. ' +
            'Prices may differ between individual sellers.';
        panel.appendChild(note);
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.textContent = '×';
        dismiss.title = 'Dismiss';
        dismiss.style.cssText = 'float:right;background:transparent;border:0;color:#fff;' +
            'cursor:pointer;font-size:18px;';
        dismiss.addEventListener('click', () => panel.remove());
        panel.insertBefore(dismiss, heading);
        document.body.appendChild(panel);
    }

    function initMultiBuySupportMessage() {
        const params = new URLSearchParams(window.location.search);
        if (!window.location.pathname.startsWith('/market/multibuy') ||
            params.get('appid') !== '440' || params.get('maidehn') !== 'less') return false;
        if (document.getElementById('tf2-fabricator-support')) return true;
        const header = document.querySelector('.market_header_bg');
        if (!header) return false;
        const message = document.createElement('div');
        message.id = 'tf2-fabricator-support';
        message.style.cssText = 'clear:both;padding:8px 12px;text-align:center;color:#c7d5e0;font:12px/1.5 Arial,sans-serif;';
        const link = document.createElement('a');
        link.href = 'https://steamcommunity.com/tradeoffer/new/?partner=360423137&token=fnw5189U';
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.style.cssText = 'color:#66c0f4;text-decoration:underline;';
        link.textContent = 'Making profit from this helpful script? Feel free to throw me a dollar to show support!';
        message.appendChild(link);
        header.appendChild(message);
        return true;
    }

    if (window.location.pathname.startsWith('/market/multibuy')) {
        initMultiBuyWeaponPanel();
        const params = new URLSearchParams(window.location.search);
        if (params.get('appid') === '440' && params.get('maidehn') === 'less' && !initMultiBuySupportMessage()) {
            const headerObserver = new MutationObserver(() => {
                if (initMultiBuySupportMessage()) headerObserver.disconnect();
            });
            headerObserver.observe(document.body,{childList:true,subtree:true});
        }
        return;
    }

    // ============================================================
    // STEAM INVENTORY OBSERVER
    // ============================================================

    async function runUpdateSafely() {

        try {
            if (ownedInventoryAuto.enabled) ensureOwnedRobotInventory();
            await updateMultiBuyButton();

        } catch (error) {

            writeDiagnostic('error',
                '[TF2 MultiBuy] UNHANDLED UPDATE ERROR:',
                error
            );
        }
    }
