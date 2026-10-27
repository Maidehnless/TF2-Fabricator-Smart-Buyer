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

    function extractModernIndividualOffers(data,name,quantity,requestedCurrency) {
        const matches=data.queries.filter(q => Array.isArray(q?.queryKey) &&
            q.queryKey[0] === 'market_item_search' && Number(q.queryKey[1]?.appid) === 440 &&
            normalizeMarketName(q.queryKey[1]?.strItemName) === normalizeMarketName(name));
        if (!matches.length) throw Error('Steam embedded listing query is missing for the requested item');
        const offers=[];
        let checkedPage=false, emptyPage=false, seenRows=0, ownRows=0;
        for (const query of matches) {
            const pages=query.state?.data?.pages;
            if (!Array.isArray(pages)) continue;
            for (const page of pages) {
                if (!Array.isArray(page?.listings)) continue;
                checkedPage=true;
                if (!page.listings.length && Number(page.total_count)===0) emptyPage=true;
                for (const listing of page.listings) {
                    seenRows++;
                    if ([true,1,'1'].includes(listing?.bMine)) { ownRows++; continue; }
                    const id=listing?.listingid;
                    if (typeof id!=='string' || !/^\d+$/.test(id)) continue;
                    const desc=listing.description;
                    if (Number(desc?.appid)!==440 || normalizeMarketName(desc.market_hash_name)!==normalizeMarketName(name)) continue;
                    const asset=listing.asset;
                    if (Number(asset?.appid)!==440) continue;
                    const amount=Number(asset.amount);
                    if (!Number.isSafeInteger(amount) || amount<1) continue;
                    const currencyID=Number(listing.eCurrency);
                    if (!Number.isSafeInteger(currencyID) || currencyID<=0) throw Error('Steam omitted listing currency metadata');
                    if (requestedCurrency && currencyID!==requestedCurrency) throw Error('Steam returned a different wallet currency');
                    const parsed=parseSteamPrice(listing.strSubtotal);
                    const base=listing.unPrice, fee=listing.unFee;
                    if (!parsed || !(parsed.format.prefix || parsed.format.suffix) ||
                        !Number.isSafeInteger(base) || base<=0 || !Number.isSafeInteger(fee) || fee<0 ||
                        !Number.isSafeInteger(base+fee) || parsed.minorUnits!==base+fee)
                        throw Error('Steam listing subtotal does not match its integer price and buyer fee');
                    let price=parsed.minorUnits;
                    if (amount>1) {
                        const unitBase=listing.unPricePerUnit,unitFee=listing.unFeePerUnit;
                        if (!Number.isSafeInteger(unitBase) || unitBase<=0 || !Number.isSafeInteger(unitFee) || unitFee<0 ||
                            (unitBase+unitFee)*amount!==price) throw Error('Steam stack has no verifiable per-unit price');
                        price=unitBase+unitFee;
                    }
                    const currency=JSON.stringify([currencyID,parsed.format.prefix,parsed.format.suffix,parsed.format.decimals]);
                    for(let i=0;i<Math.min(amount,quantity);i++) offers.push({name,price,
                        priceText:formatSteamCurrency(price,parsed.format),currency,listingID:id+':'+i,fromDetail:true,
                        url:'https://steamcommunity.com/market/listings/440/'+encodeURIComponent(name)});
                }
            }
        }
        if (!offers.length && !(checkedPage && (emptyPage || (seenRows>0 && ownRows===seenRows)))) throw Error('No verifiable individual offers in Steam embedded listings');
        return SmartPricing.selectOffers(offers,quantity);
    }

    // Only use localized buyer prices. Raw seller currency must never stand in for wallet currency.
    function extractIndividualOffers(data, name, quantity, requestedCurrency) {
        if (data?.marketFormat === 'steam-ssr') return extractModernIndividualOffers(data,name,quantity,requestedCurrency);
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
        const limit=weaponVerificationMode==='exhaustive'?names.length:({fast:10,balanced:25,long:50}[weaponVerificationMode] || 25);
        const reportFailure=detail=>writeDiagnostic('warn','[TF2 Pricing] Candidate failed:',detail);
        const result=await SmartPricing.scan({names,quantity,limit,signal,onProgress,onFailure:reportFailure,
            read:(name,signal)=>readIndividualWeaponOffers(name,quantity,currency,signal)});
        // Exhaustive runs can outlive the quote TTL. Reprice old winners and then
        // reconsider the pool; never silently present a fifteen-minute-old quote as fresh.
        const refreshed=await SmartPricing.refreshSelection({offers:result.candidateOffers,quantity,signal,onFailure:reportFailure,
            read:(name)=>readIndividualWeaponOffers(name,quantity,currency,signal)});
        result.offers=refreshed.offers;
        result.failures+=refreshed.failures;
        result.stopped ||= refreshed.stopped;
        if (refreshed.stopReason) result.stopReason=refreshed.stopReason;
        delete result.candidateOffers;
        result.tier=tier;
        // Listing pages have bounded depth and undocumented ordering; do not claim global minimum.
        result.verifiedMinimum=false;
        if(result.offers.length && !result.failures) weaponSearchCache.set(key,{time:Math.min(...result.offers.map(o=>o.verifiedAt)),result});
        writeDiagnostic('log','[TF2 Pricing] Scan coverage:',{tier,checked:result.checked,total:result.total,
            failures:result.failures,stopReason:result.stopReason,failureDetails:result.failureDetails,offers:result.offers.map(o=>[o.name,o.priceText])});
        if(!result.offers.length) {
            const last=result.failureDetails.at(-1);
            throw Error(result.stopReason==='rate_limited'?'Steam rate limit or access restriction; try again shortly':
                'No individual offers verified in '+result.attempted+' checked names' +
                (last ? '. '+last.name+': '+last.message : '; no available listings found'));
        }
        return result;
    }
