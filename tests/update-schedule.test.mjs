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
test('retry schedule shows viewer-local deadline, cycle progress and rate-limit issue',async()=>{
 const {document,request}=await setup(checkpoint());
 assert.match(request.url,/update-prices-state\.json/);
 const text=document.getElementById('tf2-price-db-next-update').textContent;
 assert.match(text,/Next retry eligible/);
 assert.ok(text.includes(new Date('2099-10-27T07:18:54Z').toLocaleString(undefined,{timeZoneName:'short'})));
 assert.match(document.getElementById('tf2-price-db-schedule-status').textContent,/4\/60.*Steam HTTP 429/);
});
test('completed cycle shows next scheduled update and overdue times avoid promising completion',async()=>{
 const env=await setup(checkpoint('complete','2000-01-01T00:00:00Z'));
 assert.match(env.document.getElementById('tf2-price-db-next-update').textContent,/Next update eligible/);
 assert.match(env.document.getElementById('tf2-price-db-schedule-status').textContent,/awaiting.*workflow/i);
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
