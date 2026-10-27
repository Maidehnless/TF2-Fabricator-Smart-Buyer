import test from 'node:test';
import assert from 'node:assert/strict';
import {loadApp} from './harness.mjs';
const html='<html><body><div id="inventory_more_dselect_container"></div></body></html>';
const checkpoint=(status='retrying',date='2099-10-27T07:18:54Z')=>({
 schema:'maidehnless.tf2.price-updater-state.v1',status,
 cycle:{completed:status==='complete'?60:4,total:60},
 nextAttemptAtUTC:status==='retrying'?date:null,nextCycleAtUTC:status==='complete'?date:null,
 updatedAtUTC:'2026-10-27T07:00:00Z',lastError:status==='retrying'?'Steam HTTP 429':null
});
async function setup(data,status=200){
 const env=await loadApp(html);env.app.createInventoryPriceSettings();
 env.ctx.GM_xmlhttpRequest=opts=>{env.request=opts;opts.onload({status,responseText:JSON.stringify(data)});};
 await env.app.loadPriceUpdateSchedule(true);return env;
}
test('compact status shows publication age and previous issue without date sections',async()=>{
 const {document,app,run}=await setup(checkpoint());
 run("Date.now = () => Date.parse('2026-10-27T09:20:30Z')");
 app.priceDatabase.generatedAt='2026-10-27T09:09:00Z';
 app.updatePriceDatabaseSettingsUI();
 assert.equal(document.getElementById('tf2-price-db-last-updated').textContent,'DB Last Updated: 11 Mins Ago');
 assert.equal(document.getElementById('tf2-price-db-schedule-status').textContent,
  'GitHub scheduling and Steam limits can delay completion.\nPrevious issue: Steam HTTP 429');
 assert.equal(document.getElementById('tf2-price-db-next-update'),null);
 assert.equal(document.getElementById('tf2-price-db-status'),null);
});
test('publication age advances independently of checkpoint deadline and handles absent or future timestamps',async()=>{
 const {app,document,run}=await setup(checkpoint('complete'));
 run("Date.now = () => Date.parse('2026-10-27T09:20:00Z')");
 for(const [timestamp,text] of [['2026-10-27T09:25:00Z','DB Last Updated: 0 Mins Ago'],['','DB Last Updated: Not loaded']]){
  app.priceDatabase.generatedAt=timestamp;app.updatePriceDatabaseSettingsUI();
  assert.equal(document.getElementById('tf2-price-db-last-updated').textContent,text);
 }
 assert.match(document.getElementById('tf2-price-db-schedule-status').textContent,/Previous issue: None reported/);
 app.priceDatabase.generatedAt='2026-10-27T09:00:00Z';
 run("Date.now = () => Date.parse('2026-10-27T09:21:00Z')");app.updatePriceDatabaseSettingsUI();
 assert.equal(document.getElementById('tf2-price-db-last-updated').textContent,'DB Last Updated: 21 Mins Ago');
});
test('failed checkpoint loads report feedback without erasing the database age',async()=>{
 const {document,app,run}=await setup(checkpoint(),503);
 run("Date.now = () => Date.parse('2026-10-27T09:20:00Z')");
 app.priceDatabase.generatedAt='2026-10-27T09:00:00Z';app.updatePriceDatabaseSettingsUI();
 assert.equal(document.getElementById('tf2-price-db-last-updated').textContent,'DB Last Updated: 20 Mins Ago');
 assert.match(document.getElementById('tf2-price-db-schedule-status').textContent,/Previous issue: GitHub HTTP 503/);
});
test('schedule requests are cached and deduplicated; manual refresh can force a new read',async()=>{
 const env=await setup(checkpoint());let calls=0;
 env.ctx.GM_xmlhttpRequest=opts=>{calls++;opts.onload({status:200,responseText:JSON.stringify(checkpoint())});};
 await env.app.loadPriceUpdateSchedule();assert.equal(calls,0);
 await env.app.loadPriceUpdateSchedule(true);assert.equal(calls,1);
 let pending;env.ctx.GM_xmlhttpRequest=opts=>{calls++;pending=opts;};
 const first=env.app.loadPriceUpdateSchedule(true),second=env.app.loadPriceUpdateSchedule(true);
 assert.equal(calls,2);pending.ontimeout();await Promise.all([first,second]);
 assert.match(env.document.getElementById('tf2-price-db-schedule-status').textContent,/timed out/);
});
