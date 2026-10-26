import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadApp,card,part,listing} from './harness.mjs';
function quote(url,dropWeapons=false) {
 const p=new URL(url).searchParams;const names=p.getAll('items[]'),qty=p.getAll('qty[]');
 return '<html><body><table>'+names.map((name,i)=>dropWeapons&&name.includes('Killstreak')?'':`<tr><td><a href="/market/listings/440/${encodeURIComponent(name)}">${name}</a><input class="market_multi_price" data-nameid="${i}" value="A$ 0.05"><input id="buy_${i}_qty" value="${qty[i]}"></td></tr>`).join('')+'</table></body></html>';
}
async function setup(dropWeapons=false) {
 const h=await loadApp('<html><body>'+card('Specialized',1)+'</body></html>');
 h.window.g_steamID='76561198000000001';h.window.g_rgWalletInfo={wallet_currency:21};
 Object.assign(h.app.ownedRobotInventory,{status:'ready',steamID:h.window.g_steamID,counts:new Map([[part,2]])});
 h.app.priceDatabase.priority={regular:['Killstreak Bat'],specialized:['Specialized Killstreak Bat']};
 const signals=[];
 h.app.setHTML(async(url,options)=>{signals.push(options?.signal);return url.includes('/multibuy')?quote(url,dropWeapons):`<html><body><script>Market_LoadOrderSpread(123); var info={"wallet_currency":21};</script></body></html>`;});
 h.app.setJSON(async(url,referer,options)=>{signals.push(options?.signal);return url.includes('histogram')?{success:1,highest_buy_order:'100',buy_order_price:'A$ 1.00'}:listing('Killstreak Bat',[6]);});
 return {...h,signals};
}
test('full controller deducts parts, prices weapon and kit, and builds ordered manual checkout',async()=>{
 const {app,document,signals}=await setup();await app.updateMultiBuyButton();
 const button=document.getElementById('tf2-fabricator-multibuy-button');
 assert.match(button.textContent,/Buy All/);
 const p=new URL(button.href).searchParams;
 assert.deepEqual(p.getAll('items[]'),['Killstreak Bat',part,'Reinforced Robot Bomb Stabilizer']);
 assert.deepEqual(p.getAll('qty[]'),['1','4','2']);
 assert.match(document.getElementById('tf2-fabricator-kit-buyorder-button').textContent,/0.85/);
 assert.ok(signals.length>=5);assert.ok(signals.every(Boolean),'all selection-dependent requests carry a cancellation signal');
});
test('unsupported weapon rows keep the robot checkout and separate weapon link',async()=>{
 const {app,document}=await setup(true);await app.updateMultiBuyButton();
 const button=document.getElementById('tf2-fabricator-multibuy-button');
 assert.ok(!new URL(button.href).searchParams.getAll('items[]').includes('Killstreak Bat'));
 assert.match(document.getElementById('tf2-fabricator-cheapest-weapon').textContent,/Killstreak Bat/);
 assert.match(button.title,/separate|could not price/i);
});
