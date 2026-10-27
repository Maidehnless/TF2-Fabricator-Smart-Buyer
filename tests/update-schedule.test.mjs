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
const localStamp=value=>{
 const date=new Date(value);
 const time=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',hour12:true}).format(date).toLowerCase().replace(/\s+/g,' ');
 const day=new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'2-digit',year:'numeric'}).format(date);
 return time+', '+day;
};
test('previous and next sections show local 12-hour timestamps and requested labels',async()=>{
 const date='2026-10-27T07:25:00Z';
 const {document,request,app}=await setup(checkpoint('retrying',date));
 app.priceDatabase.generatedAt='2026-10-27T09:09:37Z';
 app.updatePriceDatabaseSettingsUI();
 assert.match(request.url,/update-prices-state\.json/);
 assert.equal(document.getElementById('tf2-price-db-next-label').textContent,'Next DB Update');
 assert.equal(document.getElementById('tf2-price-db-previous-label').textContent,'Previous DB Update');
 assert.equal(document.getElementById('tf2-price-db-next-update').textContent,localStamp(date));
 assert.equal(document.getElementById('tf2-price-db-last-updated').textContent,localStamp('2026-10-27T09:09:37Z'));
 assert.equal(document.getElementById('tf2-price-db-schedule-status').textContent,
  'GitHub scheduling and Steam limits can delay completion.\nPrevious issue: Steam HTTP 429');
});
test('complete cycle uses next cycle timestamp and reports no previous issue',async()=>{
 const date='2026-10-27T22:05:00Z';
 const env=await setup(checkpoint('complete',date));
 assert.equal(env.document.getElementById('tf2-price-db-next-update').textContent,localStamp(date));
 assert.equal(env.document.getElementById('tf2-price-db-schedule-status').textContent,
  'GitHub scheduling and Steam limits can delay completion.\nPrevious issue: None reported.');
});
test('local timestamp formatter handles midnight, noon and a UTC day boundary',async()=>{
 const env=await loadApp(html);
 for(const date of ['2026-10-27T00:05:00Z','2026-10-27T12:05:00Z','2026-10-27T23:59:00Z']){
  env.app.priceDatabase.generatedAt=date;
  assert.equal(env.app.formatPublishedTimestamp(),localStamp(date));
 }
 if(process.env.TZ==='Australia/Perth'){
  env.app.priceDatabase.generatedAt='2026-10-27T23:59:00Z';
  assert.equal(env.app.formatPublishedTimestamp(),'07:59 am, 28/10/2026');
 }
});
test('invalid checkpoint deadline and failed fetch do not fabricate an update time',async()=>{
 for(const [data,status] of [[checkpoint('retrying','invalid'),200],[checkpoint(),503],[{...checkpoint(),status:'other'},200]]){
  const {document}=await setup(data,status);
  assert.match(document.getElementById('tf2-price-db-next-update').textContent,/Unavailable/);
 }
});
test('schedule requests are cached and deduplicated; manual refresh can force a new read',async()=>{
 const env=await setup(checkpoint());let calls=0;
 env.ctx.GM_xmlhttpRequest=opts=>{calls++;opts.onload({status:200,responseText:JSON.stringify(checkpoint())});};
 await env.app.loadPriceUpdateSchedule();assert.equal(calls,0);
 await env.app.loadPriceUpdateSchedule(true);assert.equal(calls,1);
 let pending;env.ctx.GM_xmlhttpRequest=opts=>{calls++;pending=opts;};
 const first=env.app.loadPriceUpdateSchedule(true),second=env.app.loadPriceUpdateSchedule(true);
 assert.equal(calls,2);pending.ontimeout();await Promise.all([first,second]);
 assert.match(env.document.getElementById('tf2-price-db-next-update').textContent,/Unavailable/);
});
