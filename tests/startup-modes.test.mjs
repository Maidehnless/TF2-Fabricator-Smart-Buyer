import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadApp,listing,part} from './harness.mjs';
const db=JSON.parse(await readFile('data/killstreak-prices.json','utf8'));
const page={success:1,descriptions:[{classid:'a',market_hash_name:part}],assets:[{assetid:'1',classid:'a',amount:'6'}],more_items:0};

test('all four saved verification modes use the requested entry budgets without forcing wallet USD',async()=>{
 for(const [mode,count] of [['fast',10],['balanced',25],['long',50],['exhaustive',275]]) {
  const {app,window}=await loadApp(undefined,{values:{'tf2-fabricator-verify-mode-v1':mode}});
  window.g_rgWalletInfo={wallet_currency:21};app.priceDatabase.priority=db.priority;
  const urls=[];app.setJSON(async url=>{urls.push(url);return listing();});
  const result=await app.getCheapestInputWeapon('regular',2);
  assert.equal(result.checked,count,mode);assert.equal(urls.length,count,mode);
  assert.ok(urls.every(u=>new URL(u).searchParams.get('currency')==='21'),'purchase checks stay in AUD wallet currency');
 }
});
test('settings use Killstreak entries and include Long mode',async()=>{
 const {app,document}=await loadApp('<html><body><div id="inventory_more_dselect_container"></div></body></html>');app.createInventoryPriceSettings();
 const labels=Array.from(document.querySelectorAll('select option'),x=>x.textContent);
 assert.deepEqual(labels,['Fast — 10 Killstreak entries','Balanced — 25 Killstreak entries','Long — 50 Killstreak entries','Exhaustive — all Killstreak entries']);
});
test('USD database schema is accepted while legacy AUD ranking can still be loaded during migration',async()=>{
 const {app}=await loadApp();app.validatePublishedPriceDatabase({...db,currency:'USD'});app.validatePublishedPriceDatabase({...db,currency:'AUD'});
 assert.throws(()=>app.validatePublishedPriceDatabase({...db,currency:'EUR'}));
});
test('owned parts retry automatically once late signed-in identity appears',async()=>{
 const {app,window,ctx}=await loadApp();let calls=0;const timers=[];
 ctx.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};ctx.clearTimeout=()=>{};
 app.setInventory(async()=>{calls++;return page;});
 await app.refreshOwnedRobotInventory(true);assert.equal(app.ownedRobotInventory.status,'unavailable');
 assert.equal(typeof app.ensureOwnedRobotInventory,'function');app.ensureOwnedRobotInventory();
 window.g_steamID='76561198000000001';await app.runUpdateSafely();await new Promise(r=>setImmediate(r));
 assert.equal(calls,1);assert.equal(app.ownedRobotInventory.status,'ready');assert.equal(app.ownedRobotInventory.counts.get(part),6);
 await app.ensureOwnedRobotInventory();assert.equal(calls,1,'fresh inventory is not repeatedly scanned');
});
test('transient startup failure schedules a bounded retry instead of requiring the Refresh button',async()=>{
 const {app,window,ctx}=await loadApp();window.g_steamID='76561198000000001';let calls=0;const timers=[];
 let now=100000;ctx.Date=class extends Date {static now(){return now;}};
 ctx.setTimeout=(fn,ms)=>{timers.push({fn,ms});return timers.length;};ctx.clearTimeout=()=>{};
 app.setInventory(async()=>{calls++;if(calls===1)throw Error('temporary failure');return page;});
 assert.equal(typeof app.ensureOwnedRobotInventory,'function');await app.ensureOwnedRobotInventory();
 assert.equal(calls,1);assert.equal(app.ownedRobotInventory.status,'error');assert.ok(timers.length>0);
 now+=30000;await app.ensureOwnedRobotInventory();
 assert.equal(calls,2);assert.equal(app.ownedRobotInventory.status,'ready');
});
test('auto refresh never requests another account inventory',async()=>{
 const {app,window,ctx}=await loadApp();window.g_steamID='76561198000000002';ctx.setTimeout=()=>1;ctx.clearTimeout=()=>{};
 app.setInventory(async()=>assert.fail('wrong account'));
 assert.equal(typeof app.ensureOwnedRobotInventory,'function');await app.ensureOwnedRobotInventory();
 assert.notEqual(app.ownedRobotInventory.status,'ready');
});

test('startup retries stop after three failed requests and do not hammer Steam',async()=>{
 const {app,window,ctx}=await loadApp();window.g_steamID='76561198000000001';let calls=0,now=100000;
 ctx.Date=class extends Date{static now(){return now;}};ctx.setTimeout=()=>1;ctx.clearTimeout=()=>{};
 app.setInventory(async()=>{calls++;throw Error('timeout');});
 for(let i=0;i<6;i++){now+=10000;await app.ensureOwnedRobotInventory();}
 assert.equal(calls,3);assert.equal(app.ownedRobotInventory.status,'error');
});

test('successful auto refreshes do not consume the temporary-failure retry budget',async()=>{
 const {app,window,ctx}=await loadApp();window.g_steamID='76561198000000001';let now=100000,calls=0;
 ctx.Date=class extends Date{static now(){return now;}};ctx.setTimeout=()=>1;ctx.clearTimeout=()=>{};
 app.setInventory(async()=>{calls++;return page;});
 for(let i=0;i<4;i++){now+=310000;await app.ensureOwnedRobotInventory();}
 assert.equal(calls,4);assert.equal(app.ownedRobotInventory.status,'ready');
});
