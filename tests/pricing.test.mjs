import { test } from 'node:test';
import assert from 'node:assert/strict';
// Missing module is checked explicitly so the first run reports a missing behaviour.
let P = {};
try { ({ SmartPricing: P } = await import('../src/pricing.js')); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const offer = (name, price, id, currency = 'AUD') => ({name, price, listingID:id, currency, fromDetail:true});

test('selects two different weapons instead of duplicating a grouped minimum', () => {
  assert.equal(typeof P.selectOffers, 'function');
  assert.deepEqual(P.selectOffers([offer('Bat',6,'1'),offer('Bat',25,'2'),offer('Bottle',9,'3')],2).map(o=>o.price),[6,9]);
});
test('selects two genuinely separate cheaper copies of the same name', () => {
  assert.equal(typeof P.selectOffers, 'function');
  assert.deepEqual(P.selectOffers([offer('Bat',6,'1'),offer('Bat',7,'2'),offer('Bottle',9,'3')],2).map(o=>o.price),[6,7]);
});
test('deduplicates listing IDs and never promotes grouped or invalid prices', () => {
  assert.equal(typeof P.selectOffers, 'function');
  assert.equal(P.selectOffers([offer('Bat',6,'1'),offer('Bat',6,'1'),{...offer('Bottle',4,'g'),fromDetail:false},offer('Bat',NaN,'2')],2).length,1);
});
test('refuses mixed currency offers', () => {
  assert.equal(typeof P.selectOffers, 'function');
  assert.throws(()=>P.selectOffers([offer('Bat',6,'1'),offer('Bottle',4,'2','USD')],2),/currency/i);
});
test('scan checks ranked names directly, supports quantity 3 and publishes progress', async () => {
  assert.equal(typeof P.scan, 'function');
  const seen=[], progress=[];
  const r=await P.scan({names:['Bat','Bottle','Wrench'],quantity:3,limit:2,
    read:async n=>{seen.push(n);return [offer(n,n==='Bat'?6:9,n)];},onProgress:r=>progress.push(r.offers.length)});
  assert.deepEqual(seen,['Bat','Bottle']);
  assert.equal(r.offers.length,2); assert.equal(r.complete,false); assert.ok(progress.includes(1));
  assert.equal(r.checked,2); assert.equal(r.total,3);
});
test('failed candidates make coverage incomplete without erasing verified offers', async () => {
  assert.equal(typeof P.scan, 'function');
  const r=await P.scan({names:['Bat','Bottle'],quantity:2,limit:2,read:async n=>{if(n==='Bat')throw Error('timeout');return [offer(n,9,'1')];}});
  assert.equal(r.failures,1); assert.equal(r.complete,false); assert.equal(r.offers.length,1);
});
test('a throttle stops the scan immediately', async () => {
  assert.equal(typeof P.scan, 'function');
  let count=0;
  const r=await P.scan({names:['Bat','Bottle'],quantity:2,limit:2,read:async()=>{count++;throw Error('HTTP 429');}});
  assert.equal(count,1); assert.equal(r.stopped,true);
});
test('cancelled selection does not continue with more listing requests', async () => {
  assert.equal(typeof P.scan, 'function');
  const ctrl=new AbortController(); let count=0;
  await assert.rejects(P.scan({names:['Bat','Bottle'],quantity:2,limit:2,signal:ctrl.signal,
    read:async()=>{count++;ctrl.abort();return [offer('Bat',6,'1')];}}),{name:'AbortError'});
  assert.equal(count,1);
});
test('successful empty listings count as checked but do not invent inventory', async () => {
  assert.equal(typeof P.scan, 'function');
  const r=await P.scan({names:['Bat'],quantity:2,limit:1,read:async()=>[]});
  assert.equal(r.checked,1); assert.equal(r.complete,true); assert.equal(r.offers.length,0);
});
test('request cache deduplicates in-flight work and expires successful responses', async () => {
  assert.equal(typeof P.createClient, 'function');
  let now=0,count=0;
  const client=P.createClient({now:()=>now,wait:async ms=>{now+=ms;},interval:10,ttl:20});
  const read=async()=>++count;
  assert.deepEqual(await Promise.all([client.get('a',read),client.get('a',read)]),[1,1]);
  assert.equal(await client.get('a',read),1);
  now=25; assert.equal(await client.get('a',read),2);
});
test('global queue spaces independent requests and honours cooldown after 429', async () => {
  assert.equal(typeof P.createClient, 'function');
  let now=0; const starts=[];
  const c=P.createClient({now:()=>now,wait:async ms=>{now+=ms;},interval:10,cooldown:100});
  await Promise.all(['a','b'].map(k=>c.get(k,async()=>{starts.push(now);return k;})));
  assert.deepEqual(starts,[0,10]);
  await assert.rejects(c.get('c',async()=>{throw Error('HTTP 429');}),/429/);
  await assert.rejects(c.get('d',async()=>assert.fail('must not run during cooldown')),/cooldown/i);
  now+=101; assert.equal(await c.get('d',async()=>4),4);
});
test('a cancelled queued request does not reach Steam', async () => {
  assert.equal(typeof P.createClient, 'function');
  let release; const c=P.createClient({interval:0});
  const first=c.get('a',()=>new Promise(r=>{release=r;}));
  await new Promise(r=>setImmediate(r));
  const ctrl=new AbortController(); const next=c.get('b',()=>assert.fail('cancelled'),{signal:ctrl.signal});
  ctrl.abort(); release(1); await first;
  await assert.rejects(next,{name:'AbortError'});
});

test('new selection can reuse the URL of an aborted queued selection', async () => {
  let release; const c=P.createClient({interval:0});
  const first=c.get('block',()=>new Promise(r=>{release=r;}));
  await new Promise(r=>setImmediate(r));
  const ctrl=new AbortController();
  const old=c.get('same',async()=>1,{signal:ctrl.signal});
  ctrl.abort();
  const current=c.get('same',async()=>2);
  release(0);await first;await assert.rejects(old,{name:'AbortError'});
  assert.equal(await current,2);
});

test('long scans recheck stale winners and reconsider other cheaper candidates',async()=>{
 assert.equal(typeof P.refreshSelection,'function');
 const names=[];
 const r=await P.refreshSelection({quantity:1,now:()=>100000,offers:[{...offer('Bat',6,'1'),verifiedAt:0},{...offer('Bottle',9,'2'),verifiedAt:0}],
   read:async name=>{names.push(name);return [{...offer(name,name==='Bat'?25:10,name),verifiedAt:100000}];}});
 assert.deepEqual(names,['Bat','Bottle']);assert.equal(r.offers[0].name,'Bottle');
});
test('unavailable stale winners never survive the final freshness check',async()=>{
 assert.equal(typeof P.refreshSelection,'function');
 const r=await P.refreshSelection({quantity:1,now:()=>100000,offers:[{...offer('Bat',6,'1'),verifiedAt:0}],read:async()=>[]});
 assert.equal(r.offers.length,0);
});

test('manual price refresh clears cached quotes while retaining the scheduler',async()=>{
 const c=P.createClient({interval:0});let calls=0;
 await c.get('a',async()=>++calls);assert.equal(typeof c.clear,'function');c.clear();
 assert.equal(await c.get('a',async()=>++calls),2);
});
