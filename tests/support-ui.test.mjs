import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadApp} from './harness.mjs';
test('all generated Multi-Buy links start with the signature before items',async()=>{
 const {app}=await loadApp();
 const url=app.buildMultiBuyURL(new Map([['Battle-Worn Robot Money Furnace',2]]));
 assert.ok(url.startsWith('https://steamcommunity.com/market/multibuy?appid=440&maidehn=less&'));
});
test('settings no longer include the removed wallet/ranking paragraph',async()=>{
 const {app,document}=await loadApp('<html><body><div id="inventory_more_dselect_container"></div></body></html>');app.createInventoryPriceSettings();
 assert.doesNotMatch(document.getElementById('tf2-fabricator-settings').textContent,/Live checks use|AUD prices determine/);
});
test('signed Multi-Buy header shows one support link to the specified trade URL',async()=>{
 const {app,window,document}=await loadApp('<html><body><div class="market_header_bg"><div id="BG_top"><h1>Community Market</h1></div></div></body></html>');
 window.location.pathname='/market/multibuy';window.location.search='?appid=440&maidehn=less';
 assert.equal(typeof app.initMultiBuySupportMessage,'function');app.initMultiBuySupportMessage();app.initMultiBuySupportMessage();
 const nodes=document.querySelectorAll('#tf2-fabricator-support');assert.equal(nodes.length,1);
 assert.ok(nodes[0].closest('.market_header_bg'));assert.match(nodes[0].textContent,/Making profit/);
 assert.equal(nodes[0].querySelector('a').getAttribute('href'),'https://steamcommunity.com/tradeoffer/new/?partner=360423137&token=fnw5189U');
});
test('unsigned or different-app Market pages get no support message',async()=>{
 const {app,window,document}=await loadApp('<html><body><div class="market_header_bg"></div></body></html>');
 assert.equal(typeof app.initMultiBuySupportMessage,'function');window.location.pathname='/market/multibuy';
 for(const search of ['?appid=440','?appid=730&maidehn=less','?appid=440&maidehn=other']) {window.location.search=search;app.initMultiBuySupportMessage();assert.equal(document.getElementById('tf2-fabricator-support'),null);}
});
