// ==UserScript==
// @name         TF2 Fabricator Smart Buyer
// @namespace    https://maidehnless.com/
// @author       Maidehnless
// @icon         https://avatars.akamai.steamstatic.com/2d1c9b05adb94b479e8671f9133e3d9189fcd23a_full.jpg
// @license      MIT
// @version      3.0.5
// @description  Checks ranked individual Killstreak weapon offers, subtracts owned robot parts and builds manual fabricator purchase links and kit sale estimates.
// @match        https://steamcommunity.com/*/inventory*
// @match        https://steamcommunity.com/market/multibuy*
// @grant        GM_xmlhttpRequest
// @connect      steamcommunity.com
// @connect      raw.githubusercontent.com
// @grant        GM_getValue
// @grant        GM_setValue
// @downloadURL  https://raw.githubusercontent.com/Maidehnless/TF2-Fabricator-Smart-Buyer/main/TF2_Fabricator_Smart_Buyer.user.js
// @updateURL    https://raw.githubusercontent.com/Maidehnless/TF2-Fabricator-Smart-Buyer/main/TF2_Fabricator_Smart_Buyer.user.js
// @run-at       document-idle

// ==/UserScript==

(function () {
    'use strict';
// Source: src/pricing.js
// Pure pricing logic and a session-local request scheduler. No Steam or DOM globals.
const SmartPricing = (() => {
    const abort = signal => {
        if (signal?.aborted) throw new DOMException('Selection changed', 'AbortError');
    };
    const throttled = error => /429|403|401|rate.limit|cooldown/i.test(String(error?.message || error));
    function selectOffers(offers, quantity) {
        const seen = new Set();
        const valid = offers.filter(o => {
            if (!o.fromDetail || !Number.isSafeInteger(o.price) || o.price <= 0 || !o.currency ||
                !o.listingID || seen.has(o.listingID)) return false;
            seen.add(o.listingID);
            return true;
        });
        if (new Set(valid.map(o => o.currency)).size > 1) throw new Error('Inconsistent wallet currency');
        return valid.sort((a,b) => a.price - b.price || a.name.localeCompare(b.name)).slice(0,quantity);
    }
    async function scan({names, quantity, limit, read, signal, onProgress = () => {}, onFailure = () => {}}) {
        const unique = [...new Set(names)];
        const offers = [];
        let checked=0, failures=0, attempted=0, stopped=false, stopReason='';
        const failureDetails=[];
        const snapshot = () => ({offers:selectOffers(offers,quantity), checked, failures, attempted,
            total:unique.length, budget:Math.min(limit,unique.length), stopped, stopReason, failureDetails:[...failureDetails],
            complete:checked===unique.length && failures===0});
        for (const name of unique.slice(0,limit)) {
            abort(signal);
            attempted++;
            try {
                const next = await read(name, signal);
                abort(signal);
                // Reject this whole response if it cannot be compared with previous offers.
                selectOffers([...offers,...next],quantity);
                offers.push(...next);
                checked++;
            } catch (error) {
                if (error.name === 'AbortError') throw error;
                failures++;
                const detail={name,message:String(error.message || error).slice(0,300)};
                failureDetails.push(detail);
                onFailure(detail);
                if (throttled(error)) {stopped=true;stopReason='rate_limited';}
                else if(failures>=3) {stopped=true;stopReason='failure_limit';}
            }
            onProgress(snapshot());
            if (stopped) break;
        }
        return {...snapshot(),candidateOffers:offers};
    }
    async function refreshSelection({offers,quantity,read,signal,now=Date.now,maxAge=60000,maxChecks=10,onFailure=()=>{}}) {
        let pool=[...offers], attempts=0, failures=0, stopped=false, stopReason='';
        const fresh=o=>Number.isFinite(o.verifiedAt) && now()-o.verifiedAt<maxAge;
        while(attempts<maxChecks) {
            abort(signal);
            const stale=selectOffers(pool,quantity).find(o=>!fresh(o));
            if(!stale) break;
            pool=pool.filter(o=>o.name!==stale.name);
            attempts++;
            try {
                const next=await read(stale.name,signal);
                abort(signal);
                selectOffers([...pool,...next],quantity);
                pool.push(...next);
            } catch(error) {
                if(error.name==='AbortError') throw error;
                failures++;
                onFailure({name:stale.name,message:String(error.message || error).slice(0,300),phase:'freshness'});
                if(throttled(error) || failures>=3) {stopped=true;stopReason=throttled(error)?'rate_limited':'failure_limit';break;}
            }
        }
        return {offers:selectOffers(pool.filter(fresh),quantity),failures,stopped,stopReason};
    }
    function createClient({now=Date.now, wait=ms=>new Promise(r=>setTimeout(r,ms)),
        interval=3400, ttl=30000, cooldown=60000, capacity=600}={}) {
        const cache=new Map(), pending=new Map();
        let queue=Promise.resolve(), lastStart=-Infinity, blockedUntil=0;
        function get(key, read, {signal, cacheMs=ttl}={}) {
            try { abort(signal); } catch(e) { return Promise.reject(e); }
            const cached=cache.get(key);
            if(cached && now()-cached.at < cacheMs) return Promise.resolve(cached.value);
            if(pending.has(key)) return pending.get(key).then(value=>{abort(signal);return value;}).catch(error=>{
                abort(signal);
                // A new selection must not inherit cancellation from a superseded queued owner.
                if(error.name === 'AbortError') return get(key,read,{signal,cacheMs});
                throw error;
            });
            const task=queue.catch(()=>{}).then(async()=>{
                abort(signal);
                if(now()<blockedUntil) throw Error('Steam cooldown active; try again shortly');
                const remaining=interval-(now()-lastStart);
                if(remaining>0) await wait(remaining);
                abort(signal);
                lastStart=now();
                try {
                    const value=await read();
                    cache.delete(key);
                    cache.set(key,{at:now(),value});
                    if(cache.size>capacity) cache.delete(cache.keys().next().value);
                    return value;
                } catch(e) {
                    if(throttled(e)) blockedUntil=now()+cooldown;
                    throw e;
                }
            });
            queue=task.then(()=>{},()=>{});
            const result=task.finally(()=>pending.delete(key));
            pending.set(key,result);
            return result.then(value=>{abort(signal);return value;});
        }
        return {get,clear:()=>cache.clear()};
    }
    return {selectOffers,scan,refreshSelection,createClient};
})();

// Source: src/config.js
    const BUTTON_ID = 'tf2-fabricator-multibuy-button';
    const KIT_BUTTON_ID = 'tf2-fabricator-kit-buyorder-button';
    const ERROR_BUTTON_ID = 'tf2-fabricator-error-report-button';
    const BUTTON_CONTAINER_ID = 'tf2-fabricator-button-container';
    const BUTTON_SPACER_ID = 'tf2-fabricator-button-spacer';
    const ERROR_DIALOG_ID = 'tf2-fabricator-error-report-dialog';
    const ERROR_LOG_ID = 'tf2-fabricator-error-report-log';
    const SCRIPT_VERSION = '3.0.5';
    const PRICE_DB_URL = 'https://raw.githubusercontent.com/Maidehnless/TF2-Fabricator-Smart-Buyer/main/data/killstreak-prices.json';
    const PRICE_DB_CACHE_KEY = 'tf2-fabricator-remote-price-db-v1';
    const MODE_STORAGE_KEY = 'tf2-fabricator-verify-mode-v1';
    const PRICE_DB_REFRESH_MS = 15 * 60 * 1000;
    const priceDatabase = { status: 'loading', generatedAt: '', priority: null, rows: null, error: '', loadedAt: 0, currency: 'USD' };
    let weaponVerificationMode = ['fast', 'balanced', 'long', 'exhaustive'].includes(GM_getValue(MODE_STORAGE_KEY, 'balanced'))
        ? GM_getValue(MODE_STORAGE_KEY, 'balanced') : 'balanced';
    const MULTIBUY_WEAPON_PANEL_ID = 'tf2-fabricator-multibuy-weapon-panel';
    const WEAPON_INPUT_ID = 'tf2-fabricator-cheapest-weapon';
    const OWNED_PARTS_STATUS_ID = 'tf2-fabricator-owned-robot-parts';
    const INVENTORY_PAGE_SIZE = 2000;
    const INVENTORY_CACHE_MS = 5 * 60 * 1000;
    const WEAPON_SEARCH_CACHE_MS = 60 * 1000;
    const WEAPON_SEARCH_DELAY_MS = 3400;
    const marketClient = SmartPricing.createClient({interval: WEAPON_SEARCH_DELAY_MS, ttl: 30000});
    let weaponScanController = null;
    let priceDatabaseInFlight = null;
    let recipeRoot = null;
    const quoteReceivedAt = new WeakMap();
    // Buy-order results are cached briefly to reduce Steam Market requests
    // while clicking between inventory items.
    const BUY_ORDER_CACHE_TIME = 30 * 1000;

    // Displayed kit insta-sell value deducts a 15% Steam selling tax.
    const STEAM_SELL_TAX_RATE = 0.15;

    const buyOrderCache = new Map();
    const weaponSearchCache = new Map();
    let lastLoggedFinishedKitName = null;
    const ownedRobotInventory = {
        status: 'idle', // idle, loading, ready, unavailable, error
        steamID: null,
        counts: new Map(),
        updatedAt: 0,
        revision: 0,
        error: '',
        inFlight: null
    };

    const ROBOT_PARTS = [
        'Battle-Worn Robot Money Furnace',
        'Battle-Worn Robot Taunt Processor',
        'Battle-Worn Robot KB-808',
        'Reinforced Robot Humor Suppression Pump',
        'Reinforced Robot Emotion Detector',
        'Reinforced Robot Bomb Stabilizer',
        'Pristine Robot Currency Digester',
        'Pristine Robot Brainstorm Bulb'
    ];

    // Explicit allowlist supplied by the user: regular / specialized,
    // including the listed Festivized versions. This intentionally does
    // NOT include Strange, Vintage, Genuine, fabricators or finished kits.
    const ELIGIBLE_INPUT_WEAPONS = {
        regular: new Set([
            "Killstreak Conscientious Objector",
            "Killstreak Scattergun",
            "Killstreak Flame Thrower",
            "Killstreak AWPer Hand",
            "Killstreak Rocket Launcher",
            "Killstreak Conniver's Kunai",
            "Killstreak Frying Pan",
            "Killstreak Medi Gun",
            "Killstreak Tomislav",
            "Killstreak Original",
            "Killstreak Phlogistinator",
            "Killstreak L'Étranger",
            "Killstreak Sharp Dresser",
            "Killstreak Your Eternal Reward",
            "Killstreak Tide Turner",
            "Killstreak Iron Bomber",
            "Killstreak Sniper Rifle",
            "Killstreak Black Box",
            "Killstreak Half-Zatoichi",
            "Killstreak Grenade Launcher",
            "Killstreak Big Earner",
            "Killstreak Knife",
            "Killstreak Gunslinger",
            "Killstreak Shotgun",
            "Killstreak Eyelander",
            "Killstreak Force-a-Nature",
            "Killstreak Degreaser",
            "Killstreak Panic Attack",
            "Killstreak Jag",
            "Killstreak Market Gardener",
            "Killstreak Stickybomb Launcher",
            "Killstreak Dragon's Fury",
            "Killstreak Atomizer",
            "Killstreak Bazaar Bargain",
            "Killstreak Quick-Fix",
            "Killstreak Crusader's Crossbow",
            "Killstreak Flying Guillotine",
            "Killstreak Beggar's Bazooka",
            "Killstreak Wrap Assassin",
            "Killstreak Widowmaker",
            "Killstreak Scorch Shot",
            "Killstreak Mantreads",
            "Killstreak Eureka Effect",
            "Killstreak Loch-n-Load",
            "Killstreak Bushwacka",
            "Killstreak Pistol",
            "Killstreak Shortstop",
            "Killstreak Splendid Screen",
            "Killstreak Pretty Boy's Pocket Pistol",
            "Killstreak Rescue Ranger",
            "Killstreak Sydney Sleeper",
            "Killstreak Ambassador",
            "Killstreak Minigun",
            "Killstreak Rainblower",
            "Killstreak Machina",
            "Killstreak Reserve Shooter",
            "Killstreak Cow Mangler 5000",
            "Killstreak Escape Plan",
            "Killstreak Fortified Compound",
            "Killstreak Scotsman's Skullcutter",
            "Killstreak Liberty Launcher",
            "Killstreak Family Business",
            "Killstreak Ullapool Caber",
            "Killstreak Kritzkrieg",
            "Killstreak Classic",
            "Killstreak Loose Cannon",
            "Killstreak Spy-Cicle",
            "Killstreak Detonator",
            "Killstreak Fan O'War",
            "Killstreak Hitman's Heatmaker",
            "Killstreak Quickiebomb Launcher",
            "Killstreak Powerjack",
            "Killstreak Übersaw",
            "Killstreak Revolver",
            "Killstreak Diamondback",
            "Killstreak Fire Axe",
            "Killstreak Brass Beast",
            "Killstreak Frontier Justice",
            "Killstreak SMG",
            "Killstreak Huntsman",
            "Killstreak Holy Mackerel",
            "Killstreak Persian Persuader",
            "Killstreak Bonesaw",
            "Killstreak Wrench",
            "Killstreak Shovel",
            "Killstreak Disciplinary Action",
            "Killstreak Short Circuit",
            "Killstreak Soda Popper",
            "Killstreak Holiday Punch",
            "Killstreak Hot Hand",
            "Killstreak Boston Basher",
            "Killstreak Amputator",
            "Killstreak Direct Hit",
            "Killstreak Vita-Saw",
            "Killstreak Air Strike",
            "Killstreak Kukri",
            "Killstreak Claidheamh Mòr",
            "Killstreak Homewrecker",
            "Killstreak Gloves of Running Urgently",
            "Killstreak Eviction Notice",
            "Killstreak Solemn Vow",
            "Killstreak Back Scratcher",
            "Killstreak Baby Face's Blaster",
            "Killstreak Pain Train",
            "Killstreak Equalizer",
            "Killstreak Bottle",
            "Killstreak Scottish Handshake",
            "Killstreak Southern Hospitality",
            "Killstreak Syringe Gun",
            "Killstreak Chargin' Targe",
            "Killstreak Pomson 6000",
            "Killstreak Axtinguisher",
            "Killstreak Righteous Bison",
            "Killstreak Cleaner's Carbine",
            "Killstreak Fists of Steel",
            "Killstreak Sun-on-a-Stick",
            "Killstreak Postal Pummeler",
            "Killstreak Winger",
            "Killstreak Neon Annihilator",
            "Killstreak Bat",
            "Killstreak Blutsauger",
            "Killstreak Backburner",
            "Killstreak Nessie's Nine Iron",
            "Killstreak Enforcer",
            "Killstreak Warrior's Spirit",
            "Killstreak Flare Gun",
            "Killstreak Vaccinator",
            "Killstreak Sharpened Volcano Fragment",
            "Killstreak Bat Outta Hell",
            "Killstreak Fists",
            "Killstreak Scottish Resistance",
            "Killstreak Manmelter",
            "Killstreak Lollichop",
            "Killstreak Killing Gloves of Boxing",
            "Killstreak Wanga Prick",
            "Killstreak Sandman",
            "Killstreak Overdose",
            "Killstreak Unarmed Combat",
            "Killstreak Ham Shank",
            "Killstreak Huo-Long Heater",
            "Killstreak Freedom Staff",
            "Killstreak Natascha",
            "Killstreak Back Scatter",
            "Killstreak Three-Rune Blade",
            "Killstreak Apoco-Fists",
            "Killstreak Maul",
            "Killstreak Big Kill",
            "Killstreak Bread Bite",
            "Killstreak Batsaber",
            "Killstreak C.A.P.P.E.R",
            "Killstreak Black Rose",
            "Killstreak Shooting Star",
            "Festivized Killstreak Conscientious Objector",
            "Festivized Killstreak Scattergun",
            "Festivized Killstreak Flame Thrower",
            "Festivized Killstreak AWPer Hand",
            "Festivized Killstreak Rocket Launcher",
            "Festivized Killstreak Conniver's Kunai",
            "Festivized Killstreak Frying Pan",
            "Festivized Killstreak Medi Gun",
            "Festivized Killstreak Tomislav",
            "Festivized Killstreak Original",
            "Festivized Killstreak Phlogistinator",
            "Festivized Killstreak L'Étranger",
            "Festivized Killstreak Sharp Dresser",
            "Festivized Killstreak Your Eternal Reward",
            "Festivized Killstreak Tide Turner",
            "Festivized Killstreak Iron Bomber",
            "Festivized Killstreak Sniper Rifle",
            "Festivized Killstreak Black Box",
            "Festivized Killstreak Half-Zatoichi",
            "Festivized Killstreak Grenade Launcher",
            "Festivized Killstreak Big Earner",
            "Festivized Killstreak Knife",
            "Festivized Killstreak Gunslinger",
            "Festivized Killstreak Shotgun",
            "Festivized Killstreak Eyelander",
            "Festivized Killstreak Force-a-Nature",
            "Festivized Killstreak Degreaser",
            "Festivized Killstreak Panic Attack",
            "Festivized Killstreak Jag",
            "Festivized Killstreak Market Gardener",
            "Festivized Killstreak Stickybomb Launcher",
            "Festivized Killstreak Dragon's Fury",
            "Festivized Killstreak Atomizer",
            "Festivized Killstreak Bazaar Bargain",
            "Festivized Killstreak Quick-Fix",
            "Festivized Killstreak Crusader's Crossbow",
            "Festivized Killstreak Flying Guillotine",
            "Festivized Killstreak Beggar's Bazooka",
            "Festivized Killstreak Wrap Assassin",
            "Festivized Killstreak Widowmaker",
            "Festivized Killstreak Scorch Shot",
            "Festivized Killstreak Mantreads",
            "Festivized Killstreak Eureka Effect",
            "Festivized Killstreak Loch-n-Load",
            "Festivized Killstreak Bushwacka",
            "Festivized Killstreak Pistol",
            "Festivized Killstreak Shortstop",
            "Festivized Killstreak Splendid Screen",
            "Festivized Killstreak Rescue Ranger",
            "Festivized Killstreak Sydney Sleeper",
            "Festivized Killstreak Ambassador",
            "Festivized Killstreak Minigun",
            "Festivized Killstreak Machina",
            "Festivized Killstreak Reserve Shooter",
            "Festivized Killstreak Cow Mangler 5000",
            "Festivized Killstreak Escape Plan",
            "Festivized Killstreak Fortified Compound",
            "Festivized Killstreak Scotsman's Skullcutter",
            "Festivized Killstreak Liberty Launcher",
            "Festivized Killstreak Family Business",
            "Festivized Killstreak Ullapool Caber",
            "Festivized Killstreak Kritzkrieg",
            "Festivized Killstreak Classic",
            "Festivized Killstreak Loose Cannon",
            "Festivized Killstreak Spy-Cicle",
            "Festivized Killstreak Detonator",
            "Festivized Killstreak Fan O'War",
            "Festivized Killstreak Hitman's Heatmaker",
            "Festivized Killstreak Quickiebomb Launcher",
            "Festivized Killstreak Powerjack",
            "Festivized Killstreak Übersaw",
            "Festivized Killstreak Revolver",
            "Festivized Killstreak Diamondback",
            "Festivized Killstreak Fire Axe",
            "Festivized Killstreak Brass Beast",
            "Festivized Killstreak SMG",
            "Festivized Killstreak Huntsman",
            "Festivized Killstreak Holy Mackerel",
            "Festivized Killstreak Persian Persuader",
            "Festivized Killstreak Wrench",
            "Festivized Killstreak Shovel",
            "Festivized Killstreak Disciplinary Action",
            "Festivized Killstreak Soda Popper",
            "Festivized Killstreak Boston Basher",
            "Festivized Killstreak Amputator",
            "Festivized Killstreak Direct Hit",
            "Festivized Killstreak Air Strike",
            "Festivized Killstreak Kukri",
            "Festivized Killstreak Claidheamh Mòr",
            "Festivized Killstreak Homewrecker",
            "Festivized Killstreak Gloves of Running Urgently",
            "Festivized Killstreak Solemn Vow",
            "Festivized Killstreak Back Scratcher",
            "Festivized Killstreak Baby Face's Blaster",
            "Festivized Killstreak Bottle",
            "Festivized Killstreak Scottish Handshake",
            "Festivized Killstreak Southern Hospitality",
            "Festivized Killstreak Axtinguisher",
            "Festivized Killstreak Righteous Bison",
            "Festivized Killstreak Cleaner's Carbine",
            "Festivized Killstreak Fists of Steel",
            "Festivized Killstreak Postal Pummeler",
            "Festivized Killstreak Winger",
            "Festivized Killstreak Neon Annihilator",
            "Festivized Killstreak Blutsauger",
            "Festivized Killstreak Backburner",
            "Festivized Killstreak Nessie's Nine Iron",
            "Festivized Killstreak Enforcer",
            "Festivized Killstreak Flare Gun",
            "Festivized Killstreak Vaccinator",
            "Festivized Killstreak Bat Outta Hell",
            "Festivized Killstreak Scottish Resistance",
            "Festivized Killstreak Killing Gloves of Boxing",
            "Festivized Killstreak Wanga Prick",
            "Festivized Killstreak Sandman",
            "Festivized Killstreak Unarmed Combat",
            "Festivized Killstreak Ham Shank",
            "Festivized Killstreak Huo-Long Heater",
            "Festivized Killstreak Freedom Staff",
            "Festivized Killstreak Natascha",
            "Festivized Killstreak Back Scatter",
            "Festivized Killstreak Three-Rune Blade",
            "Festivized Killstreak Maul"
]),
        specialized: new Set([
            "Specialized Killstreak Conscientious Objector",
            "Specialized Killstreak Scattergun",
            "Specialized Killstreak Flame Thrower",
            "Specialized Killstreak AWPer Hand",
            "Specialized Killstreak Rocket Launcher",
            "Specialized Killstreak Conniver's Kunai",
            "Specialized Killstreak Frying Pan",
            "Specialized Killstreak Medi Gun",
            "Specialized Killstreak Tomislav",
            "Specialized Killstreak Original",
            "Specialized Killstreak Phlogistinator",
            "Specialized Killstreak L'Étranger",
            "Specialized Killstreak Sharp Dresser",
            "Specialized Killstreak Your Eternal Reward",
            "Specialized Killstreak Tide Turner",
            "Specialized Killstreak Iron Bomber",
            "Specialized Killstreak Sniper Rifle",
            "Specialized Killstreak Black Box",
            "Specialized Killstreak Half-Zatoichi",
            "Specialized Killstreak Grenade Launcher",
            "Specialized Killstreak Big Earner",
            "Specialized Killstreak Knife",
            "Specialized Killstreak Gunslinger",
            "Specialized Killstreak Shotgun",
            "Specialized Killstreak Eyelander",
            "Specialized Killstreak Force-a-Nature",
            "Specialized Killstreak Degreaser",
            "Specialized Killstreak Panic Attack",
            "Specialized Killstreak Jag",
            "Specialized Killstreak Market Gardener",
            "Specialized Killstreak Stickybomb Launcher",
            "Specialized Killstreak Dragon's Fury",
            "Specialized Killstreak Atomizer",
            "Specialized Killstreak Bazaar Bargain",
            "Specialized Killstreak Quick-Fix",
            "Specialized Killstreak Crusader's Crossbow",
            "Specialized Killstreak Flying Guillotine",
            "Specialized Killstreak Beggar's Bazooka",
            "Specialized Killstreak Wrap Assassin",
            "Specialized Killstreak Widowmaker",
            "Specialized Killstreak Scorch Shot",
            "Specialized Killstreak Mantreads",
            "Specialized Killstreak Eureka Effect",
            "Specialized Killstreak Loch-n-Load",
            "Specialized Killstreak Bushwacka",
            "Specialized Killstreak Pistol",
            "Specialized Killstreak Shortstop",
            "Specialized Killstreak Splendid Screen",
            "Specialized Killstreak Pretty Boy's Pocket Pistol",
            "Specialized Killstreak Rescue Ranger",
            "Specialized Killstreak Sydney Sleeper",
            "Specialized Killstreak Ambassador",
            "Specialized Killstreak Minigun",
            "Specialized Killstreak Rainblower",
            "Specialized Killstreak Machina",
            "Specialized Killstreak Reserve Shooter",
            "Specialized Killstreak Cow Mangler 5000",
            "Specialized Killstreak Escape Plan",
            "Specialized Killstreak Fortified Compound",
            "Specialized Killstreak Scotsman's Skullcutter",
            "Specialized Killstreak Liberty Launcher",
            "Specialized Killstreak Family Business",
            "Specialized Killstreak Ullapool Caber",
            "Specialized Killstreak Kritzkrieg",
            "Specialized Killstreak Classic",
            "Specialized Killstreak Loose Cannon",
            "Specialized Killstreak Spy-Cicle",
            "Specialized Killstreak Detonator",
            "Specialized Killstreak Fan O'War",
            "Specialized Killstreak Hitman's Heatmaker",
            "Specialized Killstreak Quickiebomb Launcher",
            "Specialized Killstreak Powerjack",
            "Specialized Killstreak Übersaw",
            "Specialized Killstreak Revolver",
            "Specialized Killstreak Diamondback",
            "Specialized Killstreak Fire Axe",
            "Specialized Killstreak Brass Beast",
            "Specialized Killstreak Frontier Justice",
            "Specialized Killstreak SMG",
            "Specialized Killstreak Huntsman",
            "Specialized Killstreak Holy Mackerel",
            "Specialized Killstreak Persian Persuader",
            "Specialized Killstreak Bonesaw",
            "Specialized Killstreak Wrench",
            "Specialized Killstreak Shovel",
            "Specialized Killstreak Disciplinary Action",
            "Specialized Killstreak Short Circuit",
            "Specialized Killstreak Soda Popper",
            "Specialized Killstreak Holiday Punch",
            "Specialized Killstreak Hot Hand",
            "Specialized Killstreak Boston Basher",
            "Specialized Killstreak Amputator",
            "Specialized Killstreak Direct Hit",
            "Specialized Killstreak Vita-Saw",
            "Specialized Killstreak Air Strike",
            "Specialized Killstreak Kukri",
            "Specialized Killstreak Claidheamh Mòr",
            "Specialized Killstreak Homewrecker",
            "Specialized Killstreak Gloves of Running Urgently",
            "Specialized Killstreak Eviction Notice",
            "Specialized Killstreak Solemn Vow",
            "Specialized Killstreak Back Scratcher",
            "Specialized Killstreak Baby Face's Blaster",
            "Specialized Killstreak Pain Train",
            "Specialized Killstreak Equalizer",
            "Specialized Killstreak Bottle",
            "Specialized Killstreak Scottish Handshake",
            "Specialized Killstreak Southern Hospitality",
            "Specialized Killstreak Syringe Gun",
            "Specialized Killstreak Chargin' Targe",
            "Specialized Killstreak Pomson 6000",
            "Specialized Killstreak Axtinguisher",
            "Specialized Killstreak Righteous Bison",
            "Specialized Killstreak Cleaner's Carbine",
            "Specialized Killstreak Fists of Steel",
            "Specialized Killstreak Sun-on-a-Stick",
            "Specialized Killstreak Postal Pummeler",
            "Specialized Killstreak Winger",
            "Specialized Killstreak Neon Annihilator",
            "Specialized Killstreak Bat",
            "Specialized Killstreak Blutsauger",
            "Specialized Killstreak Backburner",
            "Specialized Killstreak Nessie's Nine Iron",
            "Specialized Killstreak Enforcer",
            "Specialized Killstreak Warrior's Spirit",
            "Specialized Killstreak Flare Gun",
            "Specialized Killstreak Vaccinator",
            "Specialized Killstreak Sharpened Volcano Fragment",
            "Specialized Killstreak Bat Outta Hell",
            "Specialized Killstreak Fists",
            "Specialized Killstreak Scottish Resistance",
            "Specialized Killstreak Manmelter",
            "Specialized Killstreak Lollichop",
            "Specialized Killstreak Killing Gloves of Boxing",
            "Specialized Killstreak Wanga Prick",
            "Specialized Killstreak Sandman",
            "Specialized Killstreak Overdose",
            "Specialized Killstreak Unarmed Combat",
            "Specialized Killstreak Ham Shank",
            "Specialized Killstreak Huo-Long Heater",
            "Specialized Killstreak Freedom Staff",
            "Specialized Killstreak Natascha",
            "Specialized Killstreak Back Scatter",
            "Specialized Killstreak Three-Rune Blade",
            "Specialized Killstreak Apoco-Fists",
            "Specialized Killstreak Maul",
            "Specialized Killstreak Big Kill",
            "Specialized Killstreak Bread Bite",
            "Specialized Killstreak Batsaber",
            "Specialized Killstreak C.A.P.P.E.R",
            "Specialized Killstreak Black Rose",
            "Specialized Killstreak Shooting Star",
            "Festivized Specialized Killstreak Conscientious Objector",
            "Festivized Specialized Killstreak Scattergun",
            "Festivized Specialized Killstreak Flame Thrower",
            "Festivized Specialized Killstreak AWPer Hand",
            "Festivized Specialized Killstreak Rocket Launcher",
            "Festivized Specialized Killstreak Conniver's Kunai",
            "Festivized Specialized Killstreak Frying Pan",
            "Festivized Specialized Killstreak Medi Gun",
            "Festivized Specialized Killstreak Tomislav",
            "Festivized Specialized Killstreak Original",
            "Festivized Specialized Killstreak Phlogistinator",
            "Festivized Specialized Killstreak L'Étranger",
            "Festivized Specialized Killstreak Sharp Dresser",
            "Festivized Specialized Killstreak Your Eternal Reward",
            "Festivized Specialized Killstreak Tide Turner",
            "Festivized Specialized Killstreak Iron Bomber",
            "Festivized Specialized Killstreak Sniper Rifle",
            "Festivized Specialized Killstreak Black Box",
            "Festivized Specialized Killstreak Half-Zatoichi",
            "Festivized Specialized Killstreak Grenade Launcher",
            "Festivized Specialized Killstreak Big Earner",
            "Festivized Specialized Killstreak Knife",
            "Festivized Specialized Killstreak Gunslinger",
            "Festivized Specialized Killstreak Shotgun",
            "Festivized Specialized Killstreak Eyelander",
            "Festivized Specialized Killstreak Force-a-Nature",
            "Festivized Specialized Killstreak Degreaser",
            "Festivized Specialized Killstreak Panic Attack",
            "Festivized Specialized Killstreak Jag",
            "Festivized Specialized Killstreak Market Gardener",
            "Festivized Specialized Killstreak Stickybomb Launcher",
            "Festivized Specialized Killstreak Dragon's Fury",
            "Festivized Specialized Killstreak Atomizer",
            "Festivized Specialized Killstreak Bazaar Bargain",
            "Festivized Specialized Killstreak Quick-Fix",
            "Festivized Specialized Killstreak Crusader's Crossbow",
            "Festivized Specialized Killstreak Flying Guillotine",
            "Festivized Specialized Killstreak Beggar's Bazooka",
            "Festivized Specialized Killstreak Wrap Assassin",
            "Festivized Specialized Killstreak Widowmaker",
            "Festivized Specialized Killstreak Scorch Shot",
            "Festivized Specialized Killstreak Mantreads",
            "Festivized Specialized Killstreak Eureka Effect",
            "Festivized Specialized Killstreak Loch-n-Load",
            "Festivized Specialized Killstreak Bushwacka",
            "Festivized Specialized Killstreak Pistol",
            "Festivized Specialized Killstreak Shortstop",
            "Festivized Specialized Killstreak Splendid Screen",
            "Festivized Specialized Killstreak Rescue Ranger",
            "Festivized Specialized Killstreak Sydney Sleeper",
            "Festivized Specialized Killstreak Ambassador",
            "Festivized Specialized Killstreak Minigun",
            "Festivized Specialized Killstreak Machina",
            "Festivized Specialized Killstreak Reserve Shooter",
            "Festivized Specialized Killstreak Cow Mangler 5000",
            "Festivized Specialized Killstreak Escape Plan",
            "Festivized Specialized Killstreak Fortified Compound",
            "Festivized Specialized Killstreak Scotsman's Skullcutter",
            "Festivized Specialized Killstreak Liberty Launcher",
            "Festivized Specialized Killstreak Family Business",
            "Festivized Specialized Killstreak Ullapool Caber",
            "Festivized Specialized Killstreak Kritzkrieg",
            "Festivized Specialized Killstreak Classic",
            "Festivized Specialized Killstreak Loose Cannon",
            "Festivized Specialized Killstreak Spy-Cicle",
            "Festivized Specialized Killstreak Detonator",
            "Festivized Specialized Killstreak Fan O'War",
            "Festivized Specialized Killstreak Hitman's Heatmaker",
            "Festivized Specialized Killstreak Quickiebomb Launcher",
            "Festivized Specialized Killstreak Powerjack",
            "Festivized Specialized Killstreak Übersaw",
            "Festivized Specialized Killstreak Revolver",
            "Festivized Specialized Killstreak Diamondback",
            "Festivized Specialized Killstreak Fire Axe",
            "Festivized Specialized Killstreak Brass Beast",
            "Festivized Specialized Killstreak SMG",
            "Festivized Specialized Killstreak Huntsman",
            "Festivized Specialized Killstreak Holy Mackerel",
            "Festivized Specialized Killstreak Persian Persuader",
            "Festivized Specialized Killstreak Wrench",
            "Festivized Specialized Killstreak Shovel",
            "Festivized Specialized Killstreak Disciplinary Action",
            "Festivized Specialized Killstreak Soda Popper",
            "Festivized Specialized Killstreak Boston Basher",
            "Festivized Specialized Killstreak Amputator",
            "Festivized Specialized Killstreak Direct Hit",
            "Festivized Specialized Killstreak Air Strike",
            "Festivized Specialized Killstreak Kukri",
            "Festivized Specialized Killstreak Claidheamh Mòr",
            "Festivized Specialized Killstreak Homewrecker",
            "Festivized Specialized Killstreak Gloves of Running Urgently",
            "Festivized Specialized Killstreak Solemn Vow",
            "Festivized Specialized Killstreak Back Scratcher",
            "Festivized Specialized Killstreak Baby Face's Blaster",
            "Festivized Specialized Killstreak Bottle",
            "Festivized Specialized Killstreak Scottish Handshake",
            "Festivized Specialized Killstreak Southern Hospitality",
            "Festivized Specialized Killstreak Axtinguisher",
            "Festivized Specialized Killstreak Righteous Bison",
            "Festivized Specialized Killstreak Cleaner's Carbine",
            "Festivized Specialized Killstreak Fists of Steel",
            "Festivized Specialized Killstreak Postal Pummeler",
            "Festivized Specialized Killstreak Winger",
            "Festivized Specialized Killstreak Neon Annihilator",
            "Festivized Specialized Killstreak Blutsauger",
            "Festivized Specialized Killstreak Backburner",
            "Festivized Specialized Killstreak Nessie's Nine Iron",
            "Festivized Specialized Killstreak Enforcer",
            "Festivized Specialized Killstreak Flare Gun",
            "Festivized Specialized Killstreak Vaccinator",
            "Festivized Specialized Killstreak Bat Outta Hell",
            "Festivized Specialized Killstreak Scottish Resistance",
            "Festivized Specialized Killstreak Killing Gloves of Boxing",
            "Festivized Specialized Killstreak Wanga Prick",
            "Festivized Specialized Killstreak Sandman",
            "Festivized Specialized Killstreak Unarmed Combat",
            "Festivized Specialized Killstreak Ham Shank",
            "Festivized Specialized Killstreak Huo-Long Heater",
            "Festivized Specialized Killstreak Freedom Staff",
            "Festivized Specialized Killstreak Natascha",
            "Festivized Specialized Killstreak Back Scatter",
            "Festivized Specialized Killstreak Three-Rune Blade",
            "Festivized Specialized Killstreak Maul"
])
    };

    const ELIGIBLE_INPUT_WEAPON_KEYS = {
        regular: new Set([...ELIGIBLE_INPUT_WEAPONS.regular].map(normalizeMarketName)),
        specialized: new Set([...ELIGIBLE_INPUT_WEAPONS.specialized].map(normalizeMarketName))
    };

    let currentFingerprint = '';
    let lookupID = 0;
    let updateTimer = null;
    let diagnosticErrorCount = 0;

    const diagnosticEntries = [];

    const nativeConsole = {
        log:
            console.log.bind(console),
        warn:
            console.warn.bind(console),
        error:
            console.error.bind(console)
    };

    // ============================================================
    // BASIC HELPERS
    // ============================================================

// Source: src/diagnostics.js
    function redactDiagnosticText(text) {

        return String(text)
            .replace(
                /(\b(?:sessionid|access_token|steamLoginSecure)\b["']?\s*[=:]\s*["']?)[^\s&,}"']+/gi,
                '$1[redacted]'
            );
    }

    function stringifyDiagnosticValue(value) {

        if (typeof value === 'string')
            return redactDiagnosticText(value);

        if (
            value === null ||
            typeof value === 'undefined' ||
            typeof value === 'number' ||
            typeof value === 'boolean' ||
            typeof value === 'bigint'
        ) {
            return String(value);
        }

        if (
            value instanceof Error ||
            (
                typeof value === 'object' &&
                typeof value.message === 'string' &&
                typeof value.stack === 'string'
            )
        ) {
            // Firefox Error.stack often contains only stack frames and
            // omits the exception message. Always include both.
            return redactDiagnosticText(
                (value.name || 'Error') + ': ' +
                (value.message || '(no message)') +
                (value.stack ? '\n' + value.stack : '')
            );
        }

        try {

            const seen =
                new WeakSet();

            const json =
                JSON.stringify(
                    value,
                    (key, nestedValue) => {

                        if (
                            nestedValue &&
                            typeof nestedValue === 'object'
                        ) {

                            if (seen.has(nestedValue))
                                return '[Circular]';

                            seen.add(nestedValue);
                        }

                        if (nestedValue instanceof Error) {
                            return {
                                name:
                                    nestedValue.name,
                                message:
                                    nestedValue.message,
                                stack:
                                    nestedValue.stack
                            };
                        }

                        return nestedValue;
                    },
                    2
                );

            if (typeof json === 'string')
                return redactDiagnosticText(json);

        } catch (error) {
            // Fall through to String(value).
        }

        try {
            return redactDiagnosticText(String(value));
        } catch (error) {
            return '[Unprintable value]';
        }
    }

    function buildErrorReportText() {

        const browser =
            typeof navigator !== 'undefined'
                ? navigator.userAgent
                : 'Unavailable';

        const language =
            typeof navigator !== 'undefined'
                ? navigator.language
                : 'Unavailable';

        const lines = [
            'Steam TF2 Fabricator Robot Parts Multi-Buy error report',
            'Script version: ' + SCRIPT_VERSION,
            'Generated: ' + new Date().toISOString(),
            'Browser: ' + browser,
            'Language: ' + language,
            'Recorded errors: ' + diagnosticErrorCount,
            '',
            'Userscript diagnostic log:',
            ''
        ];

        return lines
            .concat(
                diagnosticEntries.length > 0
                    ? diagnosticEntries
                    : ['No diagnostic entries were recorded.']
            )
            .join('\n');
    }

    function refreshErrorReportUI() {

        const button =
            document.getElementById(
                ERROR_BUTTON_ID
            );

        if (button) {
            button.textContent =
                'Error Report (' +
                diagnosticErrorCount +
                ')';
        }

        const logArea =
            document.getElementById(
                ERROR_LOG_ID
            );

        if (logArea) {
            logArea.textContent =
                buildErrorReportText();

            logArea.scrollTop =
                logArea.scrollHeight;
        }
    }

    function writeDiagnostic(level, ...values) {

        const consoleMethod =
            nativeConsole[level] ||
            nativeConsole.log;

        consoleMethod(...values);

        const entry =
            '[' +
            new Date().toISOString() +
            '] [' +
            String(level || 'log').toUpperCase() +
            '] ' +
            values
                .map(stringifyDiagnosticValue)
                .join(' ');

        diagnosticEntries.push(entry);

        if (level === 'error') {

            diagnosticErrorCount++;

            setTimeout(
                ensureErrorReportButton,
                0
            );
        }

        refreshErrorReportUI();
    }

    function ensureErrorReportButton() {

        if (diagnosticErrorCount <= 0)
            return null;

        const container =
            document.getElementById(
                BUTTON_CONTAINER_ID
            );

        if (!container)
            return null;

        let button =
            document.getElementById(
                ERROR_BUTTON_ID
            );

        if (!button) {

            button =
                createErrorReportButton();

            container.appendChild(button);
        }

        refreshErrorReportUI();

        requestAnimationFrame(
            () =>
                fitButtonsToContainer(
                    container,
                    ...container.querySelectorAll('a')
                )
        );

        return button;
    }

    async function copyTextToClipboard(text) {

        if (
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === 'function'
        ) {
            await navigator.clipboard.writeText(text);
            return;
        }

        const textArea =
            document.createElement('textarea');

        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';

        document.body.appendChild(textArea);
        textArea.select();

        const copied =
            document.execCommand('copy');

        textArea.remove();

        if (!copied)
            throw new Error('The browser rejected the clipboard request.');
    }

    function styleDialogButton(button, primary = false) {

        button.style.border =
            '1px solid ' +
            (primary ? '#7aa72a' : '#53606d');
        button.style.borderRadius = '3px';
        button.style.background =
            primary ? '#6b8e23' : '#303b47';
        button.style.color = '#ffffff';
        button.style.padding = '5px 10px';
        button.style.fontSize = '12px';
        button.style.cursor = 'pointer';
    }

    function closeErrorReportDialog() {

        const overlay =
            document.getElementById(
                ERROR_DIALOG_ID
            );

        if (!overlay)
            return;

        if (overlay.escapeHandler) {
            window.removeEventListener(
                'keydown',
                overlay.escapeHandler
            );
        }

        overlay.remove();
    }

    function openErrorReportDialog() {

        const existing =
            document.getElementById(
                ERROR_DIALOG_ID
            );

        if (existing) {
            refreshErrorReportUI();
            return;
        }

        const overlay =
            document.createElement('div');

        overlay.id = ERROR_DIALOG_ID;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', 'TF2 Multi-Buy error report');
        overlay.style.position = 'fixed';
        overlay.style.inset = '0';
        overlay.style.zIndex = '999999';
        overlay.style.display = 'flex';
        overlay.style.alignItems = 'center';
        overlay.style.justifyContent = 'center';
        overlay.style.padding = '20px';
        overlay.style.boxSizing = 'border-box';
        overlay.style.background = 'rgba(0, 0, 0, 0.72)';

        const dialog =
            document.createElement('div');

        dialog.style.width = 'min(760px, 96vw)';
        dialog.style.maxHeight = '90vh';
        dialog.style.display = 'flex';
        dialog.style.flexDirection = 'column';
        dialog.style.gap = '12px';
        dialog.style.padding = '16px';
        dialog.style.boxSizing = 'border-box';
        dialog.style.border = '1px solid #4b6075';
        dialog.style.borderRadius = '5px';
        dialog.style.background = '#1b2838';
        dialog.style.color = '#d6d7d8';
        dialog.style.boxShadow = '0 12px 45px rgba(0, 0, 0, 0.7)';
        dialog.style.fontFamily = 'Arial, Helvetica, sans-serif';

        const headingRow =
            document.createElement('div');

        headingRow.style.display = 'flex';
        headingRow.style.alignItems = 'center';
        headingRow.style.justifyContent = 'space-between';
        headingRow.style.gap = '12px';

        const heading =
            document.createElement('strong');

        heading.textContent = 'TF2 Multi-Buy Error Report';
        heading.style.fontSize = '18px';
        heading.style.color = '#ffffff';

        const topCloseButton =
            document.createElement('button');

        topCloseButton.type = 'button';
        topCloseButton.textContent = 'Close';
        styleDialogButton(topCloseButton);
        topCloseButton.addEventListener(
            'click',
            closeErrorReportDialog
        );

        headingRow.appendChild(heading);
        headingRow.appendChild(topCloseButton);

        const logArea =
            document.createElement('pre');

        logArea.id = ERROR_LOG_ID;
        logArea.textContent = buildErrorReportText();
        logArea.style.height = 'min(50vh, 440px)';
        logArea.style.minHeight = '180px';
        logArea.style.margin = '0';
        logArea.style.padding = '12px';
        logArea.style.boxSizing = 'border-box';
        logArea.style.overflow = 'auto';
        logArea.style.whiteSpace = 'pre-wrap';
        logArea.style.overflowWrap = 'anywhere';
        logArea.style.border = '1px solid #3d4e5f';
        logArea.style.borderRadius = '3px';
        logArea.style.background = '#101822';
        logArea.style.color = '#dcdedf';
        logArea.style.fontFamily = 'Consolas, Monaco, monospace';
        logArea.style.fontSize = '12px';
        logArea.style.lineHeight = '1.45';
        logArea.style.userSelect = 'text';

        const reportMessage =
            document.createElement('div');

        reportMessage.style.fontSize = '14px';
        reportMessage.style.lineHeight = '1.5';

        reportMessage.appendChild(
            document.createTextNode(
                'Oopsie Doopsie you have encountered an error, feel free to send these logs to the amazing and cool '
            )
        );

        const discordLink =
            document.createElement('a');

        discordLink.href =
            'https://discord.com/users/268722078633558019';
        discordLink.target = '_blank';
        discordLink.rel = 'noopener noreferrer';
        discordLink.textContent = 'maidehnless';
        discordLink.style.color = '#66c0f4';
        discordLink.style.textDecoration = 'underline';

        reportMessage.appendChild(discordLink);
        reportMessage.appendChild(
            document.createTextNode(' on discord')
        );

        const actionRow =
            document.createElement('div');

        actionRow.style.display = 'flex';
        actionRow.style.justifyContent = 'flex-end';
        actionRow.style.gap = '8px';

        const copyButton =
            document.createElement('button');

        copyButton.type = 'button';
        copyButton.textContent = 'Copy all logs';
        styleDialogButton(copyButton, true);

        copyButton.addEventListener(
            'click',
            async () => {

                const originalText =
                    copyButton.textContent;

                try {

                    await copyTextToClipboard(
                        buildErrorReportText()
                    );

                    copyButton.textContent = 'Copied!';

                } catch (error) {

                    nativeConsole.error(
                        '[TF2 Error Report] COPY ERROR:',
                        error
                    );

                    copyButton.textContent = 'Copy failed';
                }

                setTimeout(
                    () => {
                        copyButton.textContent = originalText;
                    },
                    1800
                );
            }
        );

        const bottomCloseButton =
            document.createElement('button');

        bottomCloseButton.type = 'button';
        bottomCloseButton.textContent = 'Close';
        styleDialogButton(bottomCloseButton);
        bottomCloseButton.addEventListener(
            'click',
            closeErrorReportDialog
        );

        actionRow.appendChild(copyButton);
        actionRow.appendChild(bottomCloseButton);

        dialog.appendChild(headingRow);
        dialog.appendChild(logArea);
        dialog.appendChild(reportMessage);
        dialog.appendChild(actionRow);
        overlay.appendChild(dialog);

        overlay.addEventListener(
            'click',
            event => {
                if (event.target === overlay)
                    closeErrorReportDialog();
            }
        );

        overlay.escapeHandler =
            event => {
                if (event.key === 'Escape')
                    closeErrorReportDialog();
            };

        window.addEventListener(
            'keydown',
            overlay.escapeHandler
        );

        document.body.appendChild(overlay);
        logArea.scrollTop = logArea.scrollHeight;
        topCloseButton.focus();
    }

// Source: src/inventory.js
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

// Source: src/recipe.js
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

// Source: src/money.js
    function parseSteamPrice(priceText) {

        if (!priceText)
            return null;

        const raw =
            String(priceText)
                .replace(/\u00A0/g, ' ')
                .trim();

        const firstDigit =
            raw.search(/\d/);

        if (firstDigit === -1)
            return null;

        let lastDigit = -1;

        for (
            let i = raw.length - 1;
            i >= 0;
            i--
        ) {
            if (/\d/.test(raw[i])) {
                lastDigit = i;
                break;
            }
        }

        if (lastDigit === -1)
            return null;

        /*
         * Preserve whatever currency Steam returned rather than
         * assuming AUD.
         *
         * Examples:
         *
         * A$ 1.91  -> prefix "A$"
         * $1.91    -> prefix "$"
         * 1,91€    -> suffix "€"
         * ¥120     -> prefix "¥"
         */
        const prefix =
            raw
                .substring(0, firstDigit)
                .replace(/\s+/g, '');

        const suffix =
            raw
                .substring(lastDigit + 1)
                .replace(/\s+/g, '');

        const numericText =
            raw
                .substring(
                    firstDigit,
                    lastDigit + 1
                )
                .replace(/\s+/g, '');

        const lastDot =
            numericText.lastIndexOf('.');

        const lastComma =
            numericText.lastIndexOf(',');

        let decimalSeparator = null;

        if (
            lastDot !== -1 &&
            lastComma !== -1
        ) {

            /*
             * If both separators exist, the final separator is
             * Steam's decimal separator:
             *
             * 1,234.56
             * 1.234,56
             */
            decimalSeparator =
                lastDot > lastComma
                    ? '.'
                    : ',';

        } else {

            const separator =
                lastDot !== -1
                    ? '.'
                    : (
                        lastComma !== -1
                            ? ','
                            : null
                    );

            if (separator) {

                const separatorIndex =
                    numericText.lastIndexOf(
                        separator
                    );

                const digitsAfter =
                    numericText.length -
                    separatorIndex -
                    1;

                /*
                 * Steam currencies normally use 0, 2, or in a few
                 * cases 3 decimal places. Treat a trailing group of
                 * 1-3 digits as the decimal part.
                 *
                 * This keeps the script usable across Steam wallet
                 * currencies instead of assuming two AUD decimals.
                 */
                if (
                    digitsAfter >= 1 &&
                    digitsAfter <= 3
                ) {
                    decimalSeparator =
                        separator;
                }
            }
        }

        let decimals = 0;
        let wholeText = numericText;
        let fractionText = '';

        if (decimalSeparator) {

            const decimalIndex =
                numericText.lastIndexOf(
                    decimalSeparator
                );

            decimals =
                numericText.length -
                decimalIndex -
                1;

            wholeText =
                numericText
                    .substring(
                        0,
                        decimalIndex
                    )
                    .replace(/[.,]/g, '');

            fractionText =
                numericText
                    .substring(
                        decimalIndex + 1
                    )
                    .replace(/[.,]/g, '');

        } else {

            wholeText =
                numericText
                    .replace(/[.,]/g, '');
        }

        if (!wholeText)
            wholeText = '0';

        const whole =
            parseInt(
                wholeText,
                10
            );

        if (!Number.isFinite(whole))
            return null;

        const scale =
            Math.pow(
                10,
                decimals
            );

        let fraction = 0;

        if (decimals > 0) {

            fraction =
                parseInt(
                    fractionText
                        .padEnd(
                            decimals,
                            '0'
                        )
                        .substring(
                            0,
                            decimals
                        ),
                    10
                );

            if (!Number.isFinite(fraction))
                fraction = 0;
        }

        const minorUnits =
            (whole * scale) +
            fraction;

        const format = {
            prefix,
            suffix,
            decimalSeparator:
                decimalSeparator || '.',
            decimals
        };

        return {
            minorUnits,
            format,
            formatted:
                formatSteamCurrency(
                    minorUnits,
                    format
                )
        };
    }

    function formatSteamCurrency(
        minorUnits,
        format
    ) {

        if (
            !format ||
            !Number.isFinite(minorUnits)
        ) {
            return String(minorUnits);
        }

        const decimals =
            Number.isFinite(format.decimals)
                ? format.decimals
                : 2;

        const minorUnitDecimals =
            Number.isFinite(format.minorUnitDecimals)
                ? format.minorUnitDecimals
                : decimals;

        const minorUnitScale =
            Math.pow(
                10,
                minorUnitDecimals
            );

        const displayScale =
            Math.pow(
                10,
                decimals
            );

        const absoluteUnits =
            Math.abs(
                Math.round(minorUnits)
            );

        const displayUnits =
            Math.round(
                absoluteUnits *
                displayScale /
                minorUnitScale
            );

        const whole =
            Math.floor(
                displayUnits / displayScale
            );

        const fraction =
            decimals > 0
                ? String(
                    displayUnits % displayScale
                ).padStart(
                    decimals,
                    '0'
                )
                : '';

        const numberText =
            (
                minorUnits < 0
                    ? '-'
                    : ''
            ) +
            String(whole) +
            (
                decimals > 0
                    ? (
                        format.decimalSeparator +
                        fraction
                    )
                    : ''
            );

        return (
            (format.prefix || '') +
            numberText +
            (format.suffix || '')
        );
    }

    /*
     * Compatibility helper for any debugging code that still wants
     * an approximate two-decimal numeric representation.
     *
     * Displayed prices do NOT use this function.
     */
    function parseSteamPriceToCents(priceText) {

        const parsed =
            parseSteamPrice(
                priceText
            );

        if (!parsed)
            return null;

        const scale =
            Math.pow(
                10,
                parsed.format.decimals
            );

        return Math.round(
            (
                parsed.minorUnits /
                scale
            ) *
            100
        );
    }

    // ============================================================
    // TAMPERMONKEY REQUEST
    // ============================================================

// Source: src/transport.js
    // Steam's Market can return either its legacy JSON envelope or a modern
    // HTML document carrying inert JSON state. Never evaluate page JavaScript.
    function decodeSteamMarketResponse(text) {
        const raw=String(text || '').trim();
        if (!raw) throw Error('Steam returned an empty Market response');
        if (raw.startsWith('{') || raw.startsWith('[') || raw === 'null') {
            try { return JSON.parse(raw); }
            catch (_) { throw Error('Steam returned malformed Market JSON'); }
        }
        const doc=new DOMParser().parseFromString(raw,'text/html');
        const state=doc.querySelector('script#valve-ssr-data[type="application/json"], script#valve-ssr-data');
        if (!state) throw Error('Steam returned HTML without embedded Market data' +
            (doc.title ? ' (' + doc.title.slice(0,80) + ')' : ''));
        try {
            const ssr=JSON.parse(state.textContent);
            const rawQueries=ssr?.renderContext?.queryData;
            const queries=typeof rawQueries==='string' ? JSON.parse(rawQueries) : rawQueries;
            if (!Array.isArray(queries?.queries)) throw Error('missing query cache');
            return {marketFormat:'steam-ssr',queries:queries.queries};
        } catch(error) { throw Error('Steam embedded Market data could not be decoded: ' + error.message); }
    }

    // All Market adapters share pacing, deduplication, short caching and a cooldown.
    function requestHTML(url, options = {}) {
        return marketClient.get('html:' + url, () => requestHTMLUncached(url), options);
    }
    function requestJSON(url, referer = null, options = {}) {
        return marketClient.get('json:' + url, async () => { const data = await requestJSONUncached(url, referer); if(data && typeof data === 'object') quoteReceivedAt.set(data,Date.now()); return data; }, options);
    }
    function requestHTMLUncached(url) {

        return new Promise(
            (resolve, reject) => {

                GM_xmlhttpRequest({

                    method: 'GET',

                    url: url,

                    timeout: 15000,

                    headers: {
                        'Accept':
                            'text/html,application/xhtml+xml'
                    },

                    anonymous: false,

                    onload: function (response) {

                        writeDiagnostic('log',
                            '[TF2 MultiBuy] HTTP status:',
                            response.status
                        );

                        if (
                            response.status < 200 ||
                            response.status >= 300
                        ) {

                            reject(
                                new Error(
                                    'Steam returned HTTP ' +
                                    response.status
                                )
                            );

                            return;
                        }

                        if (!response.responseText) {

                            reject(
                                new Error(
                                    'Steam returned an empty page.'
                                )
                            );

                            return;
                        }

                        resolve(
                            response.responseText
                        );
                    },

                    onerror: function (error) {

                        writeDiagnostic('warn',
                            '[TF2 MultiBuy] Network error:',
                            error
                        );

                        reject(
                            new Error(
                                'Tampermonkey request failed.'
                            )
                        );
                    },

                    ontimeout: function () {

                        reject(
                            new Error(
                                'Steam request timed out.'
                            )
                        );
                    }

                });

            }
        );
    }

    function requestJSONUncached(url, referer = null) {

        return new Promise(
            (resolve, reject) => {

                const headers = {
                    'Accept':
                        'application/json,text/javascript,*/*;q=0.01',
                    'X-Requested-With':
                        'XMLHttpRequest'
                };

                if (referer)
                    headers['Referer'] = referer;

                GM_xmlhttpRequest({

                    method: 'GET',

                    url: url,

                    timeout: 15000,

                    headers: headers,

                    anonymous: false,

                    onload: function (response) {

                        writeDiagnostic('log',
                            '[TF2 Market JSON/SSR] HTTP status:',
                            response.status
                        );

                        if (
                            response.status < 200 ||
                            response.status >= 300
                        ) {

                            reject(
                                new Error(
                                    'Steam returned HTTP ' +
                                    response.status
                                )
                            );

                            return;
                        }

                        try {

                            const data =
                                response.response &&
                                typeof response.response === 'object'
                                    ? response.response
                                    : decodeSteamMarketResponse(response.responseText);

                            resolve(data);

                        } catch (error) {

                            reject(error);
                        }
                    },

                    onerror: function (error) {

                        writeDiagnostic('warn',
                            '[TF2 Kit BuyOrder] Network error:',
                            error
                        );

                        reject(
                            new Error(
                                'Tampermonkey request failed.'
                            )
                        );
                    },

                    ontimeout: function () {

                        reject(
                            new Error(
                                'Steam request timed out.'
                            )
                        );
                    }

                });
            }
        );
    }

    // ============================================================
    // READ STEAM MULTIBUY PAGE
    // ============================================================

// Source: src/multibuy.js
    async function getMultiBuyTotal(url, expectedPositiveRows = null, options = {}) {

        writeDiagnostic('log',
            '[TF2 MultiBuy] Fetching:',
            url
        );

        const html =
            await requestHTML(url, options);

        writeDiagnostic('log',
            '[TF2 MultiBuy] Received HTML:',
            html.length,
            'characters'
        );

        const parser =
            new DOMParser();

        const doc =
            parser.parseFromString(
                html,
                'text/html'
            );

        /*
         * These are the same price inputs Steam's
         * UpdateOrderTotal() function reads.
         */
        const priceInputs =
            [
                ...doc.querySelectorAll(
                    '.market_multi_price'
                )
            ];

        writeDiagnostic('log',
            '[TF2 MultiBuy] Price inputs found:',
            priceInputs.length
        );

        if (priceInputs.length === 0) {

            /*
             * Useful information if Steam returned
             * a login/error page.
             */
            writeDiagnostic('log',
                '[TF2 MultiBuy] Page title:',
                doc.title
            );

            writeDiagnostic('log',
                '[TF2 MultiBuy] Page summary:',
                {
                    htmlLength:
                        html.length,
                    bodyTextLength:
                        doc.body && doc.body.textContent
                            ? doc.body.textContent.length
                            : 0
                }
            );

            throw new Error(
                'Steam multibuy page contained no price fields.'
            );
        }

        const requested = new URL(url).searchParams;
        const expectedNames = requested.getAll('items[]');
        const expectedQty = requested.getAll('qty[]');
        const expected = new Map(expectedNames.map((name,i) => [normalizeMarketName(name), Number(expectedQty[i])]));
        const matched = new Set();
        let totalMinorUnits = 0;
        let priceFormat = null;
        let pricedItems = 0;

        for (const priceInput of priceInputs) {

            const nameID =
                priceInput.getAttribute(
                    'data-nameid'
                );

            let quantityInput = null;

            /*
             * This mirrors Steam's own selector:
             *
             * #buy_NAMEID_qty
             */
            if (nameID) {

                quantityInput =
                    doc.getElementById(
                        'buy_' +
                        nameID +
                        '_qty'
                    );
            }

            /*
             * Fallback in case Steam changes
             * the quantity ID.
             */
            if (!quantityInput) {

                const row =
                    priceInput.closest('tr');

                if (row) {

                    quantityInput =
                        row.querySelector(
                            '.market_multi_quantity'
                        );
                }
            }

            if (!quantityInput)
                continue;

            const quantity =
                parseInt(
                    quantityInput.value,
                    10
                );

            if (
                !Number.isFinite(quantity) ||
                quantity <= 0
            ) {
                continue;
            }

            const row = priceInput.closest('.market_multi_buy_row, .market_listing_row, tr') ||
                doc.getElementById('buy_' + nameID);
            const names = [...(row?.querySelectorAll('a[href*="/market/listings/440/"]') || [])].map(a => {
                try { return normalizeMarketName(decodeURIComponent(new URL(a.getAttribute('href'), 'https://steamcommunity.com').pathname.split('/market/listings/440/')[1])); }
                catch (_) { return ''; }
            });
            const name = names.find(n => expected.has(n));
            if (!name || matched.has(name) || expected.get(name) !== quantity)
                throw Error('Steam Multi-Buy row identity or quantity does not match the requested recipe.');
            matched.add(name);

            const priceText =
                priceInput.value;

            const parsedPrice =
                parseSteamPrice(
                    priceText
                );

            writeDiagnostic('log',
                '[TF2 MultiBuy] Row:',
                {
                    nameID,
                    priceText,
                    parsedPrice,
                    quantity
                }
            );

            if (
                !parsedPrice ||
                parsedPrice.minorUnits <= 0
            ) {

                throw new Error(
                    'Could not parse Steam price "' +
                    priceText +
                    '".'
                );
            }

            if (!priceFormat) {

                priceFormat =
                    parsedPrice.format;

            } else if (
                parsedPrice.format.decimals !==
                    priceFormat.decimals ||
                parsedPrice.format.prefix !==
                    priceFormat.prefix ||
                parsedPrice.format.suffix !==
                    priceFormat.suffix
            ) {

                throw new Error(
                    'Steam returned inconsistent currency formatting on the multibuy page.'
                );
            }

            /*
             * Same formula Steam uses:
             *
             * row total = unit price × quantity
             */
            const rowTotal =
                parsedPrice.minorUnits *
                quantity;

            totalMinorUnits +=
                rowTotal;

            pricedItems++;
        }

        if (pricedItems === 0) {

            throw new Error(
                'Steam prices were found but no required quantities could be matched.'
            );
        }

        // Never show a misleading "complete" cost if a weapon (or a
        // robot part) was silently omitted by Steam's Multi-Buy page.
        if (matched.size !== expected.size || (expectedPositiveRows !== null && pricedItems !== expectedPositiveRows)) {
            throw new Error(
                'Steam Multi-Buy priced ' + pricedItems + ' of ' +
                expectedPositiveRows + ' required item types. ' +
                'One or more items may not be supported by Multi-Buy.'
            );
        }

        const formattedTotal =
            formatSteamCurrency(
                totalMinorUnits,
                priceFormat
            );

        writeDiagnostic('log',
            '[TF2 MultiBuy] Final total:',
            formattedTotal
        );

        return {
            minorUnits:
                totalMinorUnits,

            format:
                priceFormat,

            formatted:
                formattedTotal
        };
    }

    // ============================================================
    // FINISHED KIT BUY ORDER
    // ============================================================

// Source: src/kit-orders.js
    function extractListingOrderContext(html) {

        const itemNameIDPatterns = [
            /Market_LoadOrderSpread\s*\(\s*(\d+)\s*\)/i,
            /["']item_nameid["']\s*:\s*["']?(\d+)["']?/i,
            /\bitem_nameid\b\s*[:=]\s*["']?(\d+)["']?/i
        ];

        let itemNameID = null;

        for (const pattern of itemNameIDPatterns) {

            const match =
                String(html || '').match(pattern);

            if (match) {
                itemNameID = match[1];
                break;
            }
        }

        const countryMatch =
            String(html || '').match(
                /\bg_strCountryCode\s*=\s*["']([A-Za-z]{2})["']/i
            );

        const currencyMatch =
            String(html || '').match(
                /["']wallet_currency["']\s*:\s*(\d+)/i
            ) ||
            String(html || '').match(
                /\bwallet_currency\b\s*[:=]\s*(\d+)/i
            );

        return {
            itemNameID,
            countryCode:
                countryMatch
                    ? countryMatch[1].toUpperCase()
                    : 'US',
            currencyID:
                currencyMatch
                    ? currencyMatch[1]
                    : '1'
        };
    }

    function buildOrderHistogramURL(context) {

        const parameters =
            new URLSearchParams({
                country:
                    context.countryCode,
                language:
                    'english',
                currency:
                    context.currencyID,
                item_nameid:
                    context.itemNameID,
                two_factor:
                    '0',
                norender:
                    '1'
            });

        return (
            'https://steamcommunity.com/market/itemordershistogram?' +
            parameters.toString()
        );
    }

    function inferHistogramDecimals(
        histogram,
        highestBuyOrder,
        fallbackDecimals
    ) {

        const graphPrice =
            Array.isArray(histogram.buy_order_graph) &&
            Array.isArray(histogram.buy_order_graph[0])
                ? Number(histogram.buy_order_graph[0][0])
                : NaN;

        if (
            Number.isFinite(graphPrice) &&
            graphPrice > 0
        ) {

            for (let decimals = 0; decimals <= 3; decimals++) {

                const scaledGraphPrice =
                    Math.round(
                        graphPrice *
                        Math.pow(10, decimals)
                    );

                if (scaledGraphPrice === highestBuyOrder) {
                    return decimals;
                }
            }
        }

        return fallbackDecimals;
    }

    function extractHighestBuyOrderFromHistogram(
        histogram,
        kitName
    ) {

        if (
            !histogram ||
            !(
                histogram.success === true ||
                histogram.success === 1 ||
                histogram.success === '1'
            )
        ) {
            throw new Error(
                'Steam returned an unsuccessful order-book response for ' +
                kitName
            );
        }

        const highestBuyOrder =
            Number.parseInt(
                histogram.highest_buy_order,
                10
            );

        if (
            !Number.isFinite(highestBuyOrder) ||
            highestBuyOrder <= 0
        ) {

            const error =
                new Error(
                    'There are currently no buy orders for this kit.'
                );

            error.noBuyOrders = true;

            throw error;
        }

        let priceText =
            typeof histogram.buy_order_price === 'string'
                ? histogram.buy_order_price.trim()
                : '';

        if (
            !priceText &&
            typeof histogram.buy_order_summary === 'string'
        ) {

            const summaryDocument =
                new DOMParser().parseFromString(
                    histogram.buy_order_summary,
                    'text/html'
                );

            const summaryText =
                (
                    summaryDocument.body
                        ? (
                            summaryDocument.body.innerText ||
                            summaryDocument.body.textContent
                        )
                        : summaryDocument.documentElement.textContent
                )
                    .replace(/\u00A0/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();

            const summaryMatch =
                summaryText.match(
                    /\brequests?\s+to\s+buy\s+at\s+(.{1,40}?)\s+or\s+lower\b/i
                );

            if (summaryMatch)
                priceText = summaryMatch[1].trim();
        }

        if (
            !priceText &&
            Array.isArray(histogram.buy_order_graph) &&
            Array.isArray(histogram.buy_order_graph[0]) &&
            typeof histogram.buy_order_graph[0][2] === 'string'
        ) {

            const graphMatch =
                histogram.buy_order_graph[0][2].match(
                    /\bat\s+(.{1,40}?)\s+or\s+higher\b/i
                );

            if (graphMatch)
                priceText = graphMatch[1].trim();
        }

        const parsedPrice =
            parseSteamPrice(priceText);

        let format =
            parsedPrice
                ? parsedPrice.format
                : {
                    prefix:
                        String(
                            histogram.price_prefix || ''
                        ),
                    suffix:
                        String(
                            histogram.price_suffix || ''
                        ),
                    decimalSeparator:
                        '.',
                    decimals:
                        2
                };

        format = {
            ...format,
            minorUnitDecimals:
                inferHistogramDecimals(
                    histogram,
                    highestBuyOrder,
                    format.decimals
                )
        };

        const formattedPrice =
            priceText ||
            formatSteamCurrency(
                highestBuyOrder,
                format
            );

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Order-book buy order:',
            kitName,
            formattedPrice
        );

        return {
            minorUnits:
                highestBuyOrder,
            format,
            formatted:
                formattedPrice
        };
    }

    function extractHighestBuyOrderFromListingHTML(
        html,
        kitName
    ) {

        const parser =
            new DOMParser();

        const doc =
            parser.parseFromString(
                html,
                'text/html'
            );

        const bodyText =
            (
                doc.body
                    ? (
                        doc.body.innerText ||
                        doc.body.textContent
                    )
                    : doc.documentElement.textContent
            )
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

        /*
         * Legacy fallback for Steam responses that still render the
         * current top buy order directly in the listing HTML, for example:
         *
         * "40 requests to buy at A$ 1.91 or lower"
         *
         * Current Steam pages normally inject this text after loading
         * the JSON order book, so this must not be the primary lookup.
         */
        const buyOrderMatch =
            bodyText.match(
                /\brequests?\s+to\s+buy\s+at\s+(.{1,40}?)\s+or\s+lower\b/i
            );

        if (!buyOrderMatch) {

            if (
                /\bno\s+(?:active\s+)?buy\s+orders?\b/i.test(
                    bodyText
                )
            ) {

                throw new Error(
                    'There are currently no buy orders for this kit.'
                );
            }

            writeDiagnostic('log',
                '[TF2 Kit BuyOrder] Listing page summary:',
                {
                    title:
                        doc.title,
                    htmlLength:
                        html.length,
                    bodyTextLength:
                        bodyText.length
                }
            );

            throw new Error(
                'Could not find the buy-order price on the Steam listing page for ' +
                kitName
            );
        }

        const priceText =
            buyOrderMatch[1].trim();

        const parsedPrice =
            parseSteamPrice(
                priceText
            );

        if (
            !parsedPrice ||
            parsedPrice.minorUnits <= 0
        ) {

            throw new Error(
                'Could not parse Steam buy-order price "' +
                priceText +
                '" for ' +
                kitName
            );
        }

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Listing-page buy order:',
            kitName,
            parsedPrice.formatted
        );

        return parsedPrice;
    }

    async function getFinishedKitHighestBuyOrder(
        kitName, options = {}
    ) {

        const cleanMatch =
            String(kitName || '')
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .match(
                    /((?:Specialized|Professional)\s+Killstreak\s+.+?\s+Kit)(?:\s+Fabricator\b)?/i
                );

        if (cleanMatch) {
            kitName =
                cleanMatch[1].trim();
        }

        const cached =
            buyOrderCache.get(kitName);

        if (
            cached &&
            Date.now() - cached.time <
                BUY_ORDER_CACHE_TIME
        ) {
            return cached.result;
        }

        const listingURL =
            buildFinishedKitMarketURL(
                kitName
            );

        /*
         * Force English for the background lookup so the parser can
         * reliably match Steam's "requests to buy at ... or lower" text.
         * The visible button still links to the normal listing URL.
         */
        const listingFetchURL =
            listingURL +
            (listingURL.includes('?') ? '&' : '?') +
            'l=english';

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Loading finished-kit listing:',
            listingFetchURL
        );

        const html =
            await requestHTML(
                listingFetchURL, options
            );

        const orderContext =
            extractListingOrderContext(html);

        let highestBuyOrder;

        if (!orderContext.itemNameID) {

            writeDiagnostic('warn',
                '[TF2 Kit BuyOrder] Listing did not expose item_nameid; using legacy page-text fallback.'
            );

            highestBuyOrder =
                extractHighestBuyOrderFromListingHTML(
                    html,
                    kitName
                );

        } else {

            const histogramURL =
                buildOrderHistogramURL(
                    orderContext
                );

            writeDiagnostic('log',
                '[TF2 Kit BuyOrder] Loading order book:',
                {
                    itemNameID:
                        orderContext.itemNameID,
                    countryCode:
                        orderContext.countryCode,
                    currencyID:
                        orderContext.currencyID
                }
            );

            try {

                const histogram =
                    await requestJSON(
                        histogramURL,
                        listingURL, options
                    );

                highestBuyOrder =
                    extractHighestBuyOrderFromHistogram(
                        histogram,
                        kitName
                    );

            } catch (histogramError) {

                if (histogramError.name === 'AbortError' || options.signal?.aborted) throw histogramError;
                if (histogramError.noBuyOrders)
                    throw histogramError;

                writeDiagnostic('warn',
                    '[TF2 Kit BuyOrder] Structured order-book lookup failed; trying legacy page-text fallback:',
                    histogramError
                );

                try {

                    highestBuyOrder =
                        extractHighestBuyOrderFromListingHTML(
                            html,
                            kitName
                        );

                } catch (fallbackError) {

                    throw new Error(
                        histogramError.message +
                        ' Legacy fallback also failed: ' +
                        fallbackError.message
                    );
                }
            }
        }

        /*
         * The listing page gives us the current highest buy order.
         * For the button, show the amount remaining after a flat
         * 15% Steam selling tax:
         *
         * net = highest buy order × (1 - 0.15)
         */
        const instaSellMinorUnits =
            Math.round(
                highestBuyOrder.minorUnits *
                (1 - STEAM_SELL_TAX_RATE)
            );

        const result = {
            grossMinorUnits:
                highestBuyOrder.minorUnits,

            instaSellMinorUnits:
                instaSellMinorUnits,

            format:
                highestBuyOrder.format,

            highestBuyOrderFormatted:
                highestBuyOrder.formatted,

            formattedPrice:
                formatSteamCurrency(
                    instaSellMinorUnits,
                    highestBuyOrder.format
                ),

            listingURL:
                listingURL
        };

        buyOrderCache.set(
            kitName,
            {
                time: Date.now(),
                result: result
            }
        );

        writeDiagnostic('log',
            '[TF2 Kit BuyOrder] Highest buy order:',
            kitName,
            result.highestBuyOrderFormatted,
            '| after 15% tax:',
            result.formattedPrice
        );

        return result;
    }

    // ============================================================
    // PUBLISHED PRICE PRIORITY + STEAM INVENTORY SETTINGS
    // ============================================================

// Source: src/database-settings.js
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
        const detail = document.getElementById('tf2-price-db-schedule-status');
        if (!detail) return;
        const issue = priceDatabase.error || priceUpdateSchedule.error ||
            (priceUpdateSchedule.status === 'ready' ? priceUpdateSchedule.data.lastError || 'None reported.' :
                priceUpdateSchedule.status === 'loading' ? 'Checking updater status…' : 'Updater status not loaded.');
        detail.textContent = 'GitHub scheduling and Steam limits can delay completion.\n' +
            'Previous issue: ' + String(issue).slice(0, 300);
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

    function formatPublishedTimestamp() {
        const timestamp = Date.parse(priceDatabase.generatedAt);
        if (!Number.isFinite(timestamp)) return 'DB Last Updated: Not loaded';
        const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
        return 'DB Last Updated: ' + minutes + ' Mins Ago';
    }

    function updatePriceDatabaseSettingsUI() {
        updatePriceScheduleUI();
        const status = document.getElementById('tf2-price-db-last-updated');
        if (status) status.textContent = formatPublishedTimestamp();
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
        const stamp = document.createElement('strong');
        stamp.id = 'tf2-price-db-last-updated';
        stamp.style.cssText = 'display:block;color:white;font-weight:bold;';
        popup.appendChild(stamp);
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
        const stats = document.createElement('button');
        stats.id = 'tf2-price-db-stats-button';
        stats.type = 'button';
        stats.textContent = 'DB Stats';
        stats.style.cssText = refresh.style.cssText + 'display:block;margin-top:8px;';
        stats.addEventListener('click', () => showDatabaseStats(trigger));
        popup.appendChild(stats);
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

// Source: src/database-stats.js
    function formatDBStatsTime(value) {
        const date = new Date(value);
        if (!value || !Number.isFinite(date.getTime())) return 'Not yet updated';
        const pad = number => String(number).padStart(2, '0');
        const hour = date.getHours();
        return pad(hour % 12 || 12) + ':' + pad(date.getMinutes()) + (hour < 12 ? ' am, ' : ' pm, ') +
            pad(date.getDate()) + '/' + pad(date.getMonth() + 1) + '/' + date.getFullYear();
    }

    function showDatabaseStats(opener) {
        const existing = document.getElementById('tf2-price-db-stats-dialog');
        if (existing) { existing.querySelector('button')?.focus?.(); return; }
        const overlay = document.createElement('div');
        overlay.id = 'tf2-price-db-stats-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#000a;display:flex;' +
            'align-items:center;justify-content:center;padding:16px;box-sizing:border-box;';
        const panel = document.createElement('div');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-labelledby', 'tf2-price-db-stats-title');
        panel.style.cssText = 'width:940px;max-width:100%;max-height:85vh;display:flex;flex-direction:column;' +
            'background:#1b2838;color:#c7d5e0;border:1px solid #6388a0;border-radius:5px;' +
            'box-shadow:0 12px 40px #000a;font:13px/1.5 Arial,sans-serif;text-align:left;';
        const header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;gap:12px;';
        const title = document.createElement('strong');
        title.id = 'tf2-price-db-stats-title';
        title.textContent = 'DB Stats';
        title.style.cssText = 'color:white;font-size:18px;';
        const close = document.createElement('button');
        close.id = 'tf2-price-db-stats-close';
        close.type = 'button';
        close.textContent = 'Close';
        close.style.cssText = 'padding:6px 10px;background:#375877;border:1px solid #6388a0;border-radius:3px;color:white;cursor:pointer;';
        header.append(title, close);
        panel.appendChild(header);
        const summary = document.createElement('div');
        summary.style.cssText = 'padding:0 16px 12px;color:#a8b9c7;';
        panel.appendChild(summary);
        const content = document.createElement('div');
        content.style.cssText = 'overflow:auto;padding:0 16px 16px;min-height:0;';
        content.tabIndex = 0;
        content.setAttribute('role', 'region');
        content.setAttribute('aria-label', 'Weapon prices grouped by update time');
        panel.appendChild(content);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        const dismiss = () => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            document.body.style.overflow = previousOverflow;
            if (opener?.isConnected) opener.focus?.();
        };
        const onKey = event => {
            if (event.key === 'Escape') { event.preventDefault(); dismiss(); }
            if (event.key === 'Tab') {
                event.preventDefault();
                (document.activeElement === close ? content : close).focus?.();
            }
        };
        close.addEventListener('click', dismiss);
        overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
        document.addEventListener('keydown', onKey);
        close.focus?.();

        const rows = priceDatabase.rows ? [...priceDatabase.rows.values()] : [];
        if (!rows.length) {
            summary.textContent = 'Price database not loaded. Use Check GitHub for update, then reopen DB Stats.';
            return;
        }
        const priced = rows.filter(row => row.status === 'priced' && Number.isFinite(row.price) && row.price > 0).length;
        summary.textContent = rows.length + ' entries • ' + priced + ' priced • ' + (rows.length - priced) +
            ' without a verified price. Times are local. Groups use quote update times; prices are saved ' + priceDatabase.currency + ' snapshots.';
        const groups = new Map();
        const unpriced = [];
        for (const row of rows) {
            const time = Date.parse(row.checkedAtUTC);
            if (row.status !== 'priced' || !Number.isFinite(time) || !Number.isFinite(row.price) || row.price <= 0) {
                unpriced.push(row);
                continue;
            }
            // Align buckets to local :00/:30, including time zones offset by 45 minutes.
            // Keep the offset in the key so repeated times at a DST change remain distinct.
            const offset = new Date(time).getTimezoneOffset() * 60000;
            const bucket = Math.floor((time - offset) / 1800000) * 1800000 + offset;
            if (!groups.has(bucket)) groups.set(bucket, []);
            groups.get(bucket).push(row);
        }
        const renderGroup = (label, items, bucket) => {
            const section = document.createElement('section');
            section.style.cssText = 'margin:0 0 18px;';
            if (bucket !== null) section.setAttribute('data-bucket-start', new Date(bucket).toISOString());
            const heading = document.createElement('h3');
            heading.textContent = label + ' (' + items.length + ')';
            heading.style.cssText = 'position:sticky;top:0;background:#23364a;color:white;padding:8px;margin:0;font-size:13px;';
            section.appendChild(heading);
            const table = document.createElement('table');
            table.style.cssText = 'width:100%;border-collapse:collapse;';
            const head = document.createElement('thead');
            const labels = document.createElement('tr');
            for (const label of ['Weapon', 'Price', 'Quote updated']) {
                const th = document.createElement('th');
                th.textContent = label;
                th.style.cssText = 'text-align:left;padding:7px;border-bottom:1px solid #526477;';
                labels.appendChild(th);
            }
            head.appendChild(labels);
            table.appendChild(head);
            const body = document.createElement('tbody');
            for (const row of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
                const tr = document.createElement('tr');
                const name = document.createElement('td');
                name.textContent = row.name;
                const price = document.createElement('td');
                price.textContent = row.status === 'priced' && Number.isFinite(row.price) && row.price > 0
                    ? priceDatabase.currency + ' ' + row.price.toFixed(2) : 'No verified price';
                const updated = document.createElement('td');
                updated.textContent = formatDBStatsTime(row.checkedAtUTC);
                updated.style.whiteSpace = 'nowrap';
                const history = priceUpdateSchedule.data?.attemptHistory?.[row.name];
                const rowAttempt = Date.parse(row.lastAttemptAtUTC);
                const historyAttempt = Date.parse(history?.atUTC);
                const latest = Number.isFinite(historyAttempt) && (!Number.isFinite(rowAttempt) || historyAttempt >= rowAttempt)
                    ? {at: history.atUTC, result: history.result} : {at: row.lastAttemptAtUTC, result: row.lastResult};
                if (latest.result === 'no_active_listings') {
                    const note = document.createElement('div');
                    note.textContent = 'No active listings at last check: ' + formatDBStatsTime(latest.at);
                    note.style.cssText = 'font-size:11px;color:#a8b9c7;';
                    price.appendChild(note);
                }
                for (const cell of [name, price, updated]) {
                    cell.style.cssText += ';padding:8px 7px;border-bottom:1px solid #34485c;vertical-align:top;';
                    tr.appendChild(cell);
                }
                body.appendChild(tr);
            }
            table.appendChild(body);
            section.appendChild(table);
            content.appendChild(section);
        };
        for (const [bucket, items] of [...groups].sort((a, b) => b[0] - a[0])) {
            const zone = new Intl.DateTimeFormat(undefined, {timeZoneName: 'short'})
                .formatToParts(new Date(bucket)).find(part => part.type === 'timeZoneName')?.value || '';
            const end = formatDBStatsTime(bucket + 1800000).split(',')[0];
            renderGroup(formatDBStatsTime(bucket) + ' – ' + end + ' ' + zone, items, bucket);
        }
        if (unpriced.length) renderGroup('No verified price', unpriced, null);
    }

// Source: src/weapons.js
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

// Source: src/controls.js
    function createWeaponInputRow() {
        const container = document.createElement('div');
        container.id = WEAPON_INPUT_ID;
        container.style.fontSize = '12px';
        container.style.lineHeight = '1.5';
        container.style.marginTop = '5px';
        container.style.color = '#66c0f4';
        container.style.overflowWrap = 'anywhere';
        return container;
    }

    function setWeaponInputStatus(container, message, href = null, title = '') {
        if (!container) return;
        container.replaceChildren();
        const element = document.createElement(href ? 'a' : 'span');
        element.textContent = message;
        element.title = title || message;
        if (href) {
            element.href = href;
            element.target = '_blank';
            element.rel = 'noopener noreferrer';
            element.style.color = '#66c0f4';
            element.style.textDecoration = 'underline';
        }
        container.appendChild(element);
    }

    function showSelectedWeaponOffers(container, selected, verified, estimate = '') {
        if (!container) return;
        container.replaceChildren();
        const summary = document.createElement('div');
        summary.textContent = (verified ? 'Lowest verified among checked listings' :
            'Lowest verified offers among checked listings') +
            (estimate ? ' — estimated material total ' + estimate : '');
        summary.style.color = '#c7d5e0';
        container.appendChild(summary);
        selected.forEach((offer, index) => {
            const line = document.createElement('div');
            const link = document.createElement('a');
            link.href = offer.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.style.color = '#66c0f4';
            link.style.textDecoration = 'underline';
            link.textContent = (index + 1) + '. ' + offer.name + ' — ' + offer.priceText;
            link.title = 'Individual Steam Market listing price. Confirm availability before buying.';
            line.appendChild(link);
            container.appendChild(line);
        });
    }

    // ============================================================
    // BUTTON
    // ============================================================

    function createButton() {

        const button =
            document.createElement('a');

        button.id =
            BUTTON_ID;

        button.target =
            '_blank';

        button.rel =
            'noopener noreferrer';

        /*
         * Steam applies typography/layout rules to inventory links.
         * Use !important here so Steam cannot override the requested
         * 15px text and 24px button height.
         */
        button.style.setProperty(
            'display',
            'inline-flex',
            'important'
        );

        button.style.setProperty(
            'align-items',
            'center',
            'important'
        );

        button.style.setProperty(
            'justify-content',
            'center',
            'important'
        );

        button.style.setProperty(
            'box-sizing',
            'border-box',
            'important'
        );

        button.style.setProperty(
            'height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'min-height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'max-height',
            '24px',
            'important'
        );

        button.style.setProperty(
            'margin',
            '0',
            'important'
        );

        button.style.setProperty(
            'padding',
            '0 8px',
            'important'
        );

        button.style.setProperty(
            'font-size',
            '15px',
            'important'
        );

        button.style.setProperty(
            'line-height',
            '15px',
            'important'
        );

        button.style.setProperty(
            'font-weight',
            '400',
            'important'
        );

        button.style.setProperty(
            'white-space',
            'nowrap',
            'important'
        );

        button.style.setProperty(
            'width',
            'auto',
            'important'
        );

        button.style.setProperty(
            'min-width',
            '0',
            'important'
        );

        button.style.setProperty(
            'flex',
            '0 1 auto',
            'important'
        );

        button.style.background =
            'linear-gradient(to bottom, #799905 5%, #536904 95%)';

        button.style.color =
            '#d2efa9';

        button.style.textDecoration =
            'none';

        button.style.borderRadius =
            '2px';

        button.style.cursor =
            'pointer';

        button.addEventListener(
            'mouseenter',
            function () {

                this.style.filter =
                    'brightness(1.15)';

                this.style.color =
                    '#ffffff';
            }
        );

        button.addEventListener(
            'mouseleave',
            function () {

                this.style.filter =
                    '';

                this.style.color =
                    '#d2efa9';
            }
        );

        return button;
    }

    function createKitButton() {

        const button =
            createButton();

        button.id =
            KIT_BUTTON_ID;

        return button;
    }

    function createErrorReportButton() {

        const button =
            createButton();

        button.id =
            ERROR_BUTTON_ID;

        button.removeAttribute('href');
        button.removeAttribute('target');
        button.textContent =
            'Error Report (' +
            diagnosticErrorCount +
            ')';
        button.title =
            'Open the TF2 Multi-Buy diagnostic report';
        button.style.background =
            'linear-gradient(to bottom, #b84c4c 5%, #7d2929 95%)';
        button.style.color =
            '#ffd9d9';
        button.style.setProperty(
            'flex',
            '0 0 auto',
            'important'
        );

        button.addEventListener(
            'mouseenter',
            function () {
                this.style.color = '#ffffff';
            }
        );

        button.addEventListener(
            'mouseleave',
            function () {
                this.style.color = '#ffd9d9';
            }
        );

        button.addEventListener(
            'click',
            event => {
                event.preventDefault();
                openErrorReportDialog();
            }
        );

        return button;
    }

    function createButtonSpacer(referenceElement) {

        const spacer =
            document.createElement('div');

        spacer.id =
            BUTTON_SPACER_ID;

        /*
         * Match Steam's own blank-line rows in the item description.
         * Reuse the same classes as the robot-part text when possible
         * so the spacing remains natural if Steam changes its styling.
         */
        if (referenceElement) {

            spacer.className =
                referenceElement.className || '';

        }

        spacer.innerHTML =
            '&nbsp;';

        spacer.style.setProperty(
            '--white-space',
            'pre-line'
        );

        spacer.style.setProperty(
            'min-height',
            '1em',
            'important'
        );

        return spacer;
    }

    function createButtonContainer() {

        const container =
            document.createElement('div');

        container.id =
            BUTTON_CONTAINER_ID;

        /*
         * Both buttons live inside this one flex row.
         * This prevents Steam's surrounding inventory layout from
         * placing the second button on a separate line.
         */
        container.style.setProperty(
            'display',
            'flex',
            'important'
        );

        container.style.setProperty(
            'flex-direction',
            'row',
            'important'
        );

        container.style.setProperty(
            'align-items',
            'center',
            'important'
        );

        container.style.setProperty(
            'justify-content',
            'flex-start',
            'important'
        );

        container.style.setProperty(
            'flex-wrap',
            'nowrap',
            'important'
        );

        container.style.setProperty(
            'gap',
            '6px',
            'important'
        );

        container.style.setProperty(
            'width',
            '100%',
            'important'
        );

        container.style.setProperty(
            'max-width',
            '100%',
            'important'
        );

        container.style.setProperty(
            'min-width',
            '0',
            'important'
        );

        container.style.setProperty(
            'box-sizing',
            'border-box',
            'important'
        );

        container.style.setProperty(
            'align-self',
            'stretch',
            'important'
        );

        container.style.setProperty(
            'height',
            '24px',
            'important'
        );

        container.style.setProperty(
            'margin',
            '0',
            'important'
        );

        container.style.setProperty(
            'padding',
            '0',
            'important'
        );

        container.style.setProperty(
            'overflow',
            'hidden',
            'important'
        );

        return container;
    }

    function fitButtonsToContainer(
        container,
        ...buttons
    ) {

        if (!container || buttons.length === 0)
            return;

        /*
         * Start at the requested 15px. If Steam's item-card column is
         * too narrow for both labels, step the text down only as much
         * as required rather than allowing the row to spill outside
         * the card.
         */
        let fontSize = 15;
        const minimumFontSize = 11;

        for (const button of buttons) {
            button.style.setProperty(
                'font-size',
                fontSize + 'px',
                'important'
            );
        }

        const fits = () => {

            const gap = 6;

            const requiredWidth =
                buttons.reduce(
                    (total, button) =>
                        total + button.scrollWidth,
                    0
                ) +
                gap * (buttons.length - 1);

            return (
                requiredWidth <=
                container.clientWidth
            );
        };

        while (
            !fits() &&
            fontSize > minimumFontSize
        ) {

            fontSize -= 0.5;

            for (const button of buttons) {
                button.style.setProperty(
                    'font-size',
                    fontSize + 'px',
                    'important'
                );
            }
        }

        /*
         * If an unusually narrow inventory layout still cannot fit
         * both labels, split the available row proportionally rather
         * than allowing anything to overlap the card.
         */
        for (const button of buttons) {
            button.style.setProperty(
                'overflow',
                'hidden',
                'important'
            );

            button.style.setProperty(
                'text-overflow',
                'ellipsis',
                'important'
            );
        }
    }

    // ============================================================
    // UPDATE SELECTED INVENTORY ITEM
    // ============================================================

// Source: src/controller.js
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

// Source: src/bootstrap.js
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
    setInterval(updatePriceDatabaseSettingsUI, 30000);
    loadPublishedPriceDatabase(true).then(()=>{
        currentFingerprint='';
        runUpdateSafely();
    });
    setInterval(()=>loadPublishedPriceDatabase().then(scheduleUpdate).catch(()=>{}),PRICE_DB_REFRESH_MS);
    ensureOwnedRobotInventory()?.catch(error=>writeDiagnostic('warn','[TF2 Inventory]',error));
    runUpdateSafely();
    // Weapon checks start only for the current recipe. No speculative scans of either tier.

})();
