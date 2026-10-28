import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadApp,card} from './harness.mjs';

test('release, diagnostic and package versions stay synchronized',async()=>{
 const [header,config,pkg,lock]=await Promise.all(['src/header.txt','src/config.js','package.json','package-lock.json'].map(f=>readFile(f,'utf8')));
 const version=header.match(/@version\s+(\S+)/)[1];
 assert.equal(config.match(/const SCRIPT_VERSION = '([^']+)'/)[1],version);
 assert.equal(JSON.parse(pkg).version,version);
 assert.equal(JSON.parse(lock).version,version);
 assert.equal(JSON.parse(lock).packages[''].version,version);
});
test('inventory userscript matches paths without unsupported hash filters',async()=>{
 const header=await readFile('src/header.txt','utf8');
 const matches=[...header.matchAll(/@match\s+(\S+)/g)].map(m=>m[1]);
 assert.ok(matches.includes('https://steamcommunity.com/*/inventory*'));
 assert.ok(matches.includes('https://steamcommunity.com/market/multibuy*'));
 assert.ok(matches.every(pattern=>!pattern.includes('#')));
});
test('non-TF2 hash hides settings and skips inventory scans until TF2 is selected',async()=>{
 const {app,ctx,document}=await loadApp('<html><body><div id="inventory_more_dselect_container"></div></body></html>');
 let scans=0;app.setInventory(async()=>{scans++;throw Error('unexpected scan');});
 ctx.location.hash='#730_2';app.createInventoryPriceSettings();await app.ensureOwnedRobotInventory();
 assert.equal(document.getElementById('tf2-fabricator-settings'),null);assert.equal(scans,0);
 ctx.location.hash='#440_2_123';app.createInventoryPriceSettings();
 assert.ok(document.getElementById('tf2-fabricator-settings'));
 ctx.location.hash='#570_2';app.createInventoryPriceSettings();
 assert.equal(document.getElementById('tf2-fabricator-settings').hidden,true);
 ctx.location.hash='#440_2';app.createInventoryPriceSettings();
 assert.equal(document.getElementById('tf2-fabricator-settings').hidden,false);
});
test('switching away from TF2 removes stale fabricator controls without price requests',async()=>{
 const {app,ctx,document}=await loadApp('<html><body>'+card()+'<div id="tf2-fabricator-button-container"></div></body></html>');
 ctx.location.hash='#730_2';await app.updateMultiBuyButton();
 assert.equal(document.getElementById('tf2-fabricator-button-container'),null);
});
