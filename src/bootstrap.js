    // A stored ranking is an ordering hint. Always check publication freshness at startup.
    try {
        const previous = GM_getValue(PRICE_DB_CACHE_KEY,null);
        if(previous) applyPublishedPriceDatabase(validatePublishedPriceDatabase(previous));
    } catch(error) {
        writeDiagnostic('warn','[TF2 Price Database] Invalid stored snapshot:',error.message);
    }
    const isOwnUI = node => {
        const el = node?.nodeType === 1 ? node : node?.parentElement;
        return Boolean(el?.closest('[id^="tf2-fabricator-"], [id^="tf2-price-db-"]'));
    };
    function scheduleUpdate(records) {
        if(records && records.every(r => isOwnUI(r.target) ||
            (r.type === 'childList' && [...r.addedNodes,...r.removedNodes].length &&
                [...r.addedNodes,...r.removedNodes].every(isOwnUI)))) return;
        clearTimeout(updateTimer);
        updateTimer=setTimeout(() => {
            createInventoryPriceSettings();
            runUpdateSafely();
        },200);
    }
    createInventoryPriceSettings();
    const observer=new MutationObserver(scheduleUpdate);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,
        attributes:true,attributeFilter:['style','class','hidden','data-props']});
    loadPriceUpdateSchedule(true);
    setInterval(updatePriceScheduleUI, 15000);
    loadPublishedPriceDatabase(true).then(()=>{
        currentFingerprint='';
        runUpdateSafely();
    });
    setInterval(()=>loadPublishedPriceDatabase().then(scheduleUpdate).catch(()=>{}),PRICE_DB_REFRESH_MS);
    ensureOwnedRobotInventory()?.catch(error=>writeDiagnostic('warn','[TF2 Inventory]',error));
    runUpdateSafely();
    // Weapon checks start only for the current recipe. No speculative scans of either tier.
