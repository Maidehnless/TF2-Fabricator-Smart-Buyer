// Pure pricing logic and a session-local request scheduler. No Steam or DOM globals.
export const SmartPricing = (() => {
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
