    function walletContext() {
        let currency = null;
        try { currency = window.g_rgWalletInfo?.wallet_currency; } catch (_) { /* isolation */ }
        if (!currency) {
            for (const script of document.querySelectorAll('script:not([src])')) {
                const match = script.textContent.match(/["']wallet_currency["']\s*:\s*(\d+)/);
                if (match) { currency = match[1]; break; }
            }
        }
        return /^\d+$/.test(String(currency || '')) ? Number(currency) : null;
    }

    function buildWeaponMarketSearchURL(tier, start = 0) {
        const params = new URLSearchParams({appid:'440',
            q:tier === 'specialized' ? 'Specialized Killstreak' : 'Killstreak',
            start:String(start), sort_column:'price', sort_dir:'asc'});
        for (const type of ['tag_primary','tag_secondary','tag_melee']) params.append('category_440_Type[]',type);
        params.append('category_440_Quality[]','tag_unique');
        return 'https://steamcommunity.com/market/search?' + params;
    }

    function buildWeaponListingDepthURL(name, currency, quantity = 2) {
        const params = new URLSearchParams({query:'',start:'0',count:String(Math.max(10,quantity)),language:'english'});
        if (currency) params.set('currency',String(currency));
        return 'https://steamcommunity.com/market/listings/440/' + encodeURIComponent(name) + '/render/?' + params;
    }

    // Only use localized buyer prices. Raw seller currency must never stand in for wallet currency.
    function extractIndividualOffers(data, name, quantity, requestedCurrency) {
        if (!data || ![true,1,'1'].includes(data.success)) throw Error('Steam listing response unsuccessful');
        if (!data.listinginfo || typeof data.listinginfo !== 'object') throw Error('Missing listing information');
        if (!Object.keys(data.listinginfo).length) {
            if (Number(data.total_count) === 0) return [];
            throw Error('Steam omitted listing prices');
        }
        const doc = new DOMParser().parseFromString(data.results_html || '', 'text/html');
        const localized = new Map();
        for (const row of doc.querySelectorAll('.market_listing_row')) {
            const id = (row.id || '').match(/^listing_(\d+)$/)?.[1];
            const parsed = parseSteamPrice(row.querySelector('.market_listing_price_with_fee')?.textContent);
            if (id && parsed && (parsed.format.prefix || parsed.format.suffix)) localized.set(id,parsed);
        }
        const offers = [];
        for (const [key,listing] of Object.entries(data.listinginfo)) {
            if (!listing || typeof listing !== 'object') continue;
            const id = String(listing.listingid || key);
            const asset=listing.asset;
            if (!/^\d+$/.test(id) || !asset || String(asset.appid || '440') !== '440') continue;
            const details = data.assets?.['440']?.[String(asset.contextid || '2')]?.[String(asset.id)];
            if (details?.market_hash_name && normalizeMarketName(details.market_hash_name) !== normalizeMarketName(name)) continue;
            const parsed = localized.get(id);
            // Missing rendered prices are not evidence of the user's wallet price.
            if (!parsed || !Number.isSafeInteger(parsed.minorUnits) || parsed.minorUnits <= 0) continue;
            const convertedID = Number(listing.converted_currencyid);
            if (!Number.isSafeInteger(convertedID) || convertedID <= 0) throw Error('Steam omitted wallet currency metadata');
            const actualCurrency = convertedID >= 2000 ? convertedID - 2000 : convertedID;
            if (requestedCurrency && actualCurrency !== requestedCurrency)
                throw Error('Steam returned a different wallet currency');
            const currency = JSON.stringify([actualCurrency,parsed.format.prefix,
                parsed.format.suffix,parsed.format.decimals]);
            const amount=Number(asset.amount ?? 1);
            if (!Number.isSafeInteger(amount) || amount<=0) continue;
            for(let i=0;i<Math.min(amount,quantity);i++) offers.push({name,price:parsed.minorUnits,
                priceText:formatSteamCurrency(parsed.minorUnits,parsed.format),currency,
                listingID:id+':'+i,fromDetail:true,
                url:'https://steamcommunity.com/market/listings/440/'+encodeURIComponent(name)});
        }
        if (!offers.length) throw Error('No localized fee-inclusive individual listing prices');
        return SmartPricing.selectOffers(offers,quantity);
    }

    async function readIndividualWeaponOffers(name, quantity, currency, signal) {
        const url = buildWeaponListingDepthURL(name,currency,quantity);
        const data = await requestJSON(url,'https://steamcommunity.com/market/listings/440/'+encodeURIComponent(name),
            {signal,cacheMs:60000});
        const receivedAt=quoteReceivedAt.get(data) || Date.now();
        return extractIndividualOffers(data,name,quantity,currency).map(o=>({...o,verifiedAt:receivedAt}));
    }

    async function getCheapestInputWeapon(tier, quantity = 2, {signal,onProgress} = {}) {
        const names = priceDatabase.priority?.[tier] || [...(ELIGIBLE_INPUT_WEAPONS[tier] || [])];
        if (!names.length) throw Error('Unsupported weapon tier');
        const currency = walletContext();
        const key=[tier,quantity,weaponVerificationMode,currency,priceDatabase.generatedAt].join('|');
        const cached=weaponSearchCache.get(key);
        if(cached && Date.now()-cached.time<WEAPON_SEARCH_CACHE_MS) {
            if(signal?.aborted) throw new DOMException('Selection changed','AbortError');
            onProgress?.(cached.result);
            return cached.result;
        }
        const limit=weaponVerificationMode==='fast'?4:weaponVerificationMode==='balanced'?10:names.length;
        const result=await SmartPricing.scan({names,quantity,limit,signal,onProgress,
            read:(name,signal)=>readIndividualWeaponOffers(name,quantity,currency,signal)});
        // Exhaustive runs can outlive the quote TTL. Reprice old winners and then
        // reconsider the pool; never silently present a fifteen-minute-old quote as fresh.
        const refreshed=await SmartPricing.refreshSelection({offers:result.candidateOffers,quantity,signal,
            read:(name)=>readIndividualWeaponOffers(name,quantity,currency,signal)});
        result.offers=refreshed.offers;
        result.failures+=refreshed.failures;
        result.stopped ||= refreshed.stopped;
        delete result.candidateOffers;
        result.tier=tier;
        // Listing pages have bounded depth and undocumented ordering; do not claim global minimum.
        result.verifiedMinimum=false;
        if(result.offers.length && !result.failures) weaponSearchCache.set(key,{time:Math.min(...result.offers.map(o=>o.verifiedAt)),result});
        writeDiagnostic('log','[TF2 Pricing] Scan coverage:',{tier,checked:result.checked,total:result.total,
            failures:result.failures,offers:result.offers.map(o=>[o.name,o.priceText])});
        if(!result.offers.length) throw Error(result.stopped?'Steam verification stopped or throttled; try again shortly':
            'No individual offers verified in '+result.attempted+' checked names; try a deeper mode or Steam Market search');
        return result;
    }
