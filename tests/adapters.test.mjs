import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadApp,card,part,listing} from './harness.mjs';

test('parses only the selected visible item, excluding unrelated ingredient text',async()=>{
 const {app}=await loadApp('<html><body><div><div>'+part+' x 999</div><div>Pristine Robot Brainstorm Bulb x 3</div><div>Pristine Robot Currency Digester x 9</div></div>'+card()+'</body></html>');
 const r=app.findFabricatorParts(); assert.equal(r.parts.get(part),6);
 assert.equal(app.findRequiredKillstreakWeapon(r).quantity,2);
 assert.equal(app.findFinishedKitName(),'Professional Killstreak Bat Kit');
});
test('hidden duplicate card cannot supply the kit or recipe',async()=>{
 const {app}=await loadApp('<html><body><div hidden>'+card('Specialized',1)+'</div>'+card()+'</body></html>');
 const r=app.findFabricatorParts(); assert.equal(app.findRequiredKillstreakWeapon(r).tier,'specialized');
 assert.equal(app.findFinishedKitName(),'Professional Killstreak Bat Kit');
});
test('specialized recipes use exact regular weapon count including synthetic x3',async()=>{
 const {app}=await loadApp('<html><body>'+card('Specialized',3)+'</body></html>');
 const r=app.findFabricatorParts();assert.equal(app.findRequiredKillstreakWeapon(r).quantity,3);
 assert.equal(app.findRequiredKillstreakWeapon(r).tier,'regular');
});
test('Multi-Buy preserves input order and combines same-name weapon copies',async()=>{
 const {app}=await loadApp('<html><body>'+card()+'</body></html>');
 const r=app.findFabricatorParts(); const u=new URL(app.buildMultiBuyURL(new Map([[part,4]]),[{name:'Specialized Killstreak Bat'},{name:'Specialized Killstreak Bat'}],r.orderedInputs));
 assert.deepEqual(u.searchParams.getAll('items[]'),['Specialized Killstreak Bat',part]);
 assert.deepEqual(u.searchParams.getAll('qty[]'),['2','4']);
});
test('inventory pages deduplicate assets and ignore owned weapons',async()=>{
 const {app}=await loadApp();const counts=new Map(),seen=new Set();
 const page={descriptions:[{classid:'a',name:part},{classid:'b',name:'Killstreak Bat'}],assets:[{assetid:'1',classid:'a',amount:'4'},{assetid:'2',classid:'b',amount:'1'}]};
 app.parseRobotPartInventoryPage(page,counts,seen);app.parseRobotPartInventoryPage(page,counts,seen);
 app.parseRobotPartInventoryPage({...page,assets:[{assetid:'3',classid:'a',amount:'2'}]},counts,seen);
 assert.equal(counts.get(part),6);assert.equal(counts.has('Killstreak Bat'),false);
});
test('owned robot parts only deducted from confirmed signed-in inventory',async()=>{
 const {app,window}=await loadApp();window.g_steamID='76561198000000001';
 Object.assign(app.ownedRobotInventory,{status:'ready',steamID:window.g_steamID,counts:new Map([[part,9]])});
 assert.equal(app.missingRobotParts(new Map([[part,6]])).get(part),0);
 window.g_steamID='76561198000000002';
 assert.equal(app.missingRobotParts(new Map([[part,6]])).get(part),6);
});
test('localized prices include fees and never use raw seller currency',async()=>{
 const {app}=await loadApp();const data=listing();
 assert.deepEqual(Array.from(app.extractIndividualOffers(data,'Killstreak Bat',2,21),o=>o.price),[6,25]);
 data.results_html='';assert.throws(()=>app.extractIndividualOffers(data,'Killstreak Bat',2,21),/localized/i);
});
test('different response currency fails even if price magnitude is plausible',async()=>{
 const {app}=await loadApp();assert.throws(()=>app.extractIndividualOffers(listing('Killstreak Bat',[6],2001),'Killstreak Bat',2,21),/currency/i);
});
test('database rejects duplicate rows even when priority arrays are valid',async()=>{
 const {app}=await loadApp();const db=JSON.parse(await readFile('data/killstreak-prices.json','utf8'));
 app.validatePublishedPriceDatabase(db);db.prices[1]=db.prices[0];assert.throws(()=>app.validatePublishedPriceDatabase(db),/duplicate|invalid/i);
});
test('Multi-Buy rejects same row count with wrong quantity or identity',async()=>{
 const {app,run,ctx}=await loadApp();
 const html=`<table><tr><td><a href="https://steamcommunity.com/market/listings/440/Wrong">Wrong</a><input class="market_multi_price" data-nameid="1" value="A$ 0.05"><input id="buy_1_qty" value="99"></td></tr></table>`;
 app.setHTML(async()=>html);
 await assert.rejects(app.getMultiBuyTotal('https://steamcommunity.com/market/multibuy?appid=440&items[]=Killstreak%20Bat&qty[]=2',1),/quantity|identity|match/i);
});
test('currency parsing supports AUD, euro and zero-decimal yen',async()=>{
 const {app}=await loadApp();for(const [text,minor] of [['A$ 1,234.56',123456],['1.234,56€',123456],['¥120',120]]) assert.equal(app.parseSteamPrice(text).minorUnits,minor);
});
test('diagnostics redact session tokens',async()=>{
 const {app}=await loadApp();const value=app.redactDiagnosticText('sessionid=SECRET&access_token=TOKEN steamLoginSecure=COOKIE');
 assert.ok(!/SECRET|TOKEN|COOKIE/.test(value));
});

test('complete two-page inventory commits only after the final page',async()=>{
 const {app,window}=await loadApp();window.g_steamID='76561198000000001';
 const page={success:1,descriptions:[{classid:'a',name:part}],assets:[{assetid:'1',classid:'a',amount:'4'}],more_items:1,last_assetid:'1'};
 let count=0;
 app.setInventory(async()=>{count++;return count===1?page:{...page,assets:[{assetid:'2',classid:'a',amount:'2'}],more_items:0};});
 const result=await app.refreshOwnedRobotInventory(true);
 assert.equal(count,2);assert.equal(result.get(part),6);assert.equal(app.ownedRobotInventory.status,'ready');
});
test('partial inventory failure never commits first-page counts',async()=>{
 const {app,window}=await loadApp();window.g_steamID='76561198000000001';let count=0;
 app.setInventory(async()=>{if(count++)throw Error('page two timeout');return {success:1,descriptions:[{classid:'a',name:part}],assets:[{assetid:'1',classid:'a',amount:'4'}],more_items:1,last_assetid:'1'};});
 assert.equal(await app.refreshOwnedRobotInventory(true),null);
 assert.equal(app.ownedRobotInventory.status,'error');assert.equal(app.ownedRobotInventory.counts.size,0);
});
test('valid native Multi-Buy identities and quantities produce exact integer total',async()=>{
 const {app}=await loadApp();
 app.setHTML(async()=>`<table><tr><td><a href="/market/listings/440/Killstreak%20Bat">Bat</a><input class="market_multi_price" data-nameid="1" value="A$ 0.06"><input id="buy_1_qty" value="2"></td></tr></table>`);
 assert.equal((await app.getMultiBuyTotal('https://steamcommunity.com/market/multibuy?appid=440&items[]=Killstreak%20Bat&qty[]=2',1)).minorUnits,12);
});
test('fast scan uses ten direct listing requests and reuses successful result cache',async()=>{
 const {app,window}=await loadApp();window.g_rgWalletInfo={wallet_currency:21};
 const db=JSON.parse(await readFile('data/killstreak-prices.json','utf8'));
 app.priceDatabase.priority=db.priority;app.priceDatabase.generatedAt=db.generatedAtUTC;
 const urls=[];app.setJSON(async url=>{urls.push(url);return listing();});
 // Set mode through the actual settings control.
 const {document}=window; const more=document.createElement('div');more.id='inventory_more_dselect_container';document.body.append(more);
 app.createInventoryPriceSettings();const select=document.querySelector('select');select.value='fast';select.dispatchEvent(new window.Event('change'));
 const first=await app.getCheapestInputWeapon('regular',2);
 const second=await app.getCheapestInputWeapon('regular',2);
 assert.equal(urls.length,10);assert.ok(urls.every(u=>u.includes('/listings/440/') && !u.includes('/search/')));
 assert.equal(first.checked,10);assert.equal(second.offers[0].price,6);
});

test('missing wallet metadata and different dollar currencies cannot be combined',async()=>{
 const {app}=await loadApp();const data=listing();delete data.listinginfo['1'].converted_currencyid;
 assert.throws(()=>app.extractIndividualOffers(data,'Killstreak Bat',2,21),/currency/i);
 const usd=listing('Killstreak Bat',[6],2001),nzd=listing('Killstreak Bottle',[7],2020);
 usd.results_html=usd.results_html.replace('A$','$');nzd.results_html=nzd.results_html.replace('A$','$').replace('listing_1','listing_9');nzd.listinginfo['9']={...nzd.listinginfo['1'],listingid:'9'};delete nzd.listinginfo['1'];
 const a=app.extractIndividualOffers(usd,'Killstreak Bat',1,null),b=app.extractIndividualOffers(nzd,'Killstreak Bottle',1,null);
 assert.throws(()=>app.SmartPricing.selectOffers([...a,...b],2),/currency/i);
});
test('robot purchase link stays disabled while owned parts are loading',async()=>{
 const {app,document}=await loadApp('<html><body>'+card()+'</body></html>');
 app.ownedRobotInventory.status='loading';await app.updateMultiBuyButton();
 assert.equal(document.getElementById('tf2-fabricator-multibuy-button').hasAttribute('href'),false);
});
test('Multi-Buy adapter passes the selection signal to the request queue',async()=>{
 const {app}=await loadApp();const ctrl=new AbortController();let received;
 app.setHTML(async(url,opts)=>{received=opts?.signal;throw new DOMException('changed','AbortError');});
 await assert.rejects(app.getMultiBuyTotal('https://steamcommunity.com/market/multibuy?appid=440',0,{signal:ctrl.signal}),{name:'AbortError'});
 assert.equal(received,ctrl.signal);
});
test('bare rendered card fragment can still be scoped by its Fabricator heading',async()=>{
 const {app}=await loadApp('<html><body>'+card().replace('data-featuretarget="iteminfo"','class="renderedCard"')+'</body></html>');
 assert.equal(app.findFabricatorParts()?.parts.get(part),6);
});
