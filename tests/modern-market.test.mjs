import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadApp,listing} from './harness.mjs';
const html=await readFile(new URL('./fixtures/steam-ssr-specialized-bat.html',import.meta.url),'utf8');
function ssrHTML(queries) {
 return '<html><head><script id="valve-ssr-data" type="application/json">'+JSON.stringify({renderContext:{queryData:JSON.stringify({queries})}})+'</script></head><body></body></html>';
}
function query(name,rows) {
 return {queryKey:['market_item_search',{appid:440,strItemName:name,start:0}],state:{data:{pages:[{listings:rows,total_count:rows.length,start:0,more:false}]}}};
}
const row=(id,price=6,currency=21,name='Specialized Killstreak Bat')=>({listingid:id,unPrice:price,unFee:2,eCurrency:currency,
 strSubtotal:'A$ '+((price+2)/100).toFixed(2),description:{appid:440,market_hash_name:name,name_color:'7D6D00'},asset:{appid:440,amount:1}});

test('HTTP 200 modern Steam HTML decodes actual embedded individual seller offers',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 const data=app.decodeSteamMarketResponse(html);
 const offers=app.extractIndividualOffers(data,'Specialized Killstreak Bat',2,null);
 assert.equal(offers.length,2);assert.ok(offers.every(o=>o.fromDetail&&o.price>0));
 assert.equal(new Set(offers.map(o=>o.listingID)).size,2);
 const expected=JSON.parse(JSON.parse(html.match(/id="valve-ssr-data">(.*?)<\/script>/s)[1]).renderContext.queryData)
  .queries[0].state.data.pages[0].listings.map(r=>r.unPrice+r.unFee).sort((a,b)=>a-b).slice(0,2);
 assert.deepEqual(Array.from(offers,o=>o.price),expected);
});
test('modern adapter matches the exact app and queried item instead of unrelated cached queries',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 const data=app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bottle',[row('99',1,21,'Specialized Killstreak Bottle')]),query('Specialized Killstreak Bat',[row('11',6)])]));
 assert.equal(app.extractIndividualOffers(data,'Specialized Killstreak Bat',1,21)[0].listingID,'11:0');
 assert.throws(()=>app.extractIndividualOffers(data,'Specialized Killstreak Wrench',1,21),/query|item|missing/i);
});
test('modern subtotal must agree with integer base and buyer fee',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 const r={...row('11'),strSubtotal:'A$ 9.99'};
 assert.throws(()=>app.extractIndividualOffers(app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[r])])),'Specialized Killstreak Bat',1,21),/subtotal|fee|price/i);
});
test('modern wallet mismatch never mixes USD into an AUD quote',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 assert.throws(()=>app.extractIndividualOffers(app.decodeSteamMarketResponse(html),'Specialized Killstreak Bat',2,21),/currency/i);
});
test('modern parser rejects wrong item descriptions and unsafe listing IDs',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 for(const r of [{...row('11'),description:{appid:440,market_hash_name:'Specialized Killstreak Bottle'}},row('not-an-id')]) {
  assert.throws(()=>app.extractIndividualOffers(app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[r])])),'Specialized Killstreak Bat',1,21),/offer|listing|price/i);
 }
});
test('Steam login/challenge HTML gives a response-format error without evaluating scripts',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 assert.throws(()=>app.decodeSteamMarketResponse('<html><title>Sign In</title><script>throw Error("executed")</script></html>'),/HTML|embedded|Market data/i);
});
test('legacy listing JSON remains supported by the same response decoder',async()=>{
 const {app}=await loadApp();assert.equal(typeof app.decodeSteamMarketResponse,'function');
 const offers=app.extractIndividualOffers(app.decodeSteamMarketResponse(JSON.stringify(listing('Killstreak Bat',[6,7]))),'Killstreak Bat',2,21);
 assert.deepEqual(Array.from(offers,o=>o.price),[6,7]);
});
test('candidate failures retain the item and actual parser error and distinguish rate limits',async()=>{
 const {app}=await loadApp();const reports=[];
 const r=await app.SmartPricing.scan({names:['Bat','Bottle','Wrench'],quantity:2,limit:3,
  read:async()=>{throw Error('Steam returned HTML instead of JSON');},onFailure:f=>reports.push(f)});
 assert.equal(reports.length,3);assert.equal(reports[0].name,'Bat');assert.match(reports[0].message,/HTML/);
 assert.equal(r.stopReason,'failure_limit');assert.equal(r.failureDetails.length,3);
});

test('HTTP transport and full weapon scan accept the modern response end to end',async()=>{
 const {app,ctx}=await loadApp();let calls=0;
 app.priceDatabase.priority={specialized:['Specialized Killstreak Bat']};
 ctx.GM_xmlhttpRequest=options=>{calls++;options.onload({status:200,responseText:html});};
 const result=await app.getCheapestInputWeapon('specialized',2);
 assert.equal(calls,1);assert.equal(result.checked,1);assert.equal(result.failures,0);
 assert.deepEqual(Array.from(result.offers,o=>o.price),[173,174]);
});
test('modern empty successful listings are recorded as unavailable instead of errors',async()=>{
 const {app}=await loadApp();const data=app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[])]));
 assert.equal(app.extractIndividualOffers(data,'Specialized Killstreak Bat',2,21).length,0);
});
test('modern listing stacks use proven per-unit buyer prices',async()=>{
 const {app}=await loadApp();const r={...row('11',12),unFee:4,strSubtotal:'A$ 0.16',asset:{appid:440,amount:2},unPricePerUnit:6,unFeePerUnit:2};
 const data=app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[r])]));
 assert.deepEqual(Array.from(app.extractIndividualOffers(data,'Specialized Killstreak Bat',2,21),o=>o.price),[8,8]);
});

test('signed-in users own sell listings are excluded from buy recommendations',async()=>{
 const {app}=await loadApp();
 const data=app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[{...row('11',1),bMine:true},row('12',8)])]));
 const offers=app.extractIndividualOffers(data,'Specialized Killstreak Bat',2,21);
 assert.deepEqual(Array.from(offers,o=>o.listingID),['12:0']);
});

test('a modern page containing only own listings has no purchasable offers',async()=>{
 const {app}=await loadApp();
 const data=app.decodeSteamMarketResponse(ssrHTML([query('Specialized Killstreak Bat',[{...row('11'),bMine:true}])]));
 assert.equal(app.extractIndividualOffers(data,'Specialized Killstreak Bat',2,21).length,0);
});
