import test from 'node:test';
import assert from 'node:assert/strict';
import {loadApp} from './harness.mjs';
const html='<html><body><div id="inventory_more_dselect_container"></div></body></html>';
const stamp=(hour,minute)=>new Date(2026,9,27,hour,minute).toISOString();
async function setup(){
 const env=await loadApp(html);
 const rows=[
  {name:'Killstreak SMG',tier:'regular',status:'priced',price:0.48,checkedAtUTC:stamp(17,5)},
  {name:'Specialized Killstreak Bat',tier:'specialized',status:'priced',price:1.73,checkedAtUTC:stamp(17,29)},
  {name:'Killstreak Wrench',tier:'regular',status:'priced',price:2.50,checkedAtUTC:stamp(17,30)},
  {name:'Killstreak Unknown',tier:'regular',status:'unavailable',price:null,checkedAtUTC:null}
 ];
 env.app.priceDatabase.rows=new Map(rows.map(r=>[r.name,r]));
 env.app.priceDatabase.currency='USD';
 env.app.priceDatabase.status='ready';
 env.app.priceUpdateSchedule.status='ready';
 env.app.priceUpdateSchedule.data={attemptHistory:{'Killstreak SMG':{atUTC:stamp(18,0),result:'no_active_listings'}}};
 env.app.createInventoryPriceSettings();
 return env;
}
test('DB Stats button opens quote rows in newest-first local half-hour groups',async()=>{
 const {document,window}=await setup();
 const button=document.getElementById('tf2-price-db-stats-button');
 assert.equal(button.textContent,'DB Stats');
 button.dispatchEvent(new window.Event('click',{bubbles:true}));
 const dialog=document.getElementById('tf2-price-db-stats-dialog');assert.ok(dialog);
 const buckets=[...dialog.querySelectorAll('[data-bucket-start]')];
 assert.deepEqual(buckets.map(e=>e.getAttribute('data-bucket-start')),[stamp(17,30),stamp(17,0)]);
 assert.equal(buckets[0].querySelectorAll('tbody tr').length,1);
 assert.equal(buckets[1].querySelectorAll('tbody tr').length,2);
 assert.match(dialog.textContent,/USD 0\.48/);
 assert.match(dialog.textContent,/No active listings at last check/);
 assert.match(dialog.textContent,/No verified price/);
 assert.equal(dialog.querySelectorAll('tbody tr').length,4);
});
test('dialog reuses one instance, closes with Escape and can reopen',async()=>{
 const {document,window}=await setup();const button=document.getElementById('tf2-price-db-stats-button');
 button.click();button.click();
 assert.equal(document.querySelectorAll('#tf2-price-db-stats-dialog').length,1);
 const event=new window.Event('keydown',{bubbles:true});Object.defineProperty(event,'key',{value:'Escape'});
 document.dispatchEvent(event);
 assert.equal(document.getElementById('tf2-price-db-stats-dialog'),null);
 button.click();assert.ok(document.getElementById('tf2-price-db-stats-dialog'));
 document.getElementById('tf2-price-db-stats-close').click();
 assert.equal(document.getElementById('tf2-price-db-stats-dialog'),null);
});
test('stats render market names as text and use database currency',async()=>{
 const {app,document}=await setup();
 app.priceDatabase.currency='AUD';
 const name='<img src=x onerror=evil()>Killstreak';
 app.priceDatabase.rows=new Map([[name,{name,status:'priced',price:1.25,checkedAtUTC:stamp(0,0)}]]);
 document.getElementById('tf2-price-db-stats-button').click();
 const dialog=document.getElementById('tf2-price-db-stats-dialog');
 assert.equal(dialog.querySelector('img'),null);
 assert.ok(dialog.textContent.includes(name));assert.match(dialog.textContent,/AUD 1\.25/);
});
test('missing database shows an honest empty state',async()=>{
 const {app,document}=await setup();app.priceDatabase.rows=null;
 document.getElementById('tf2-price-db-stats-button').click();
 assert.match(document.getElementById('tf2-price-db-stats-dialog').textContent,/not loaded/i);
});
