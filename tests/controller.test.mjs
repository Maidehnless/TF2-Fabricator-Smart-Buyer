import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadApp,card,part,listing} from './harness.mjs';
function quote(url,dropWeapons=false) {
 const p=new URL(url).searchParams;const names=p.getAll('items[]'),qty=p.getAll('qty[]');
 return '<html><body><table>'+names.map((name,i)=>dropWeapons&&name.includes('Killstreak')?'':`<tr><td><a href="/market/listings/440/${encodeURIComponent(name)}">${name}</a><input class="market_multi_price" data-nameid="${i}" value="A$ 0.05"><input id="buy_${i}_qty" value="${qty[i]}"></td></tr>`).join('')+'</table></body></html>';
}
async function setup(dropWeapons=false,quantity=1) {
 const h=await loadApp('<html><body>'+card('Specialized',quantity)+'</body></html>');
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

test('current verified weapon is immediately usable while search continues, with progress confirmation',async()=>{
 const {app,document,window}=await setup();let finish;
 const selected=[{name:'Killstreak Bat',price:6,priceText:'A$ 0.06',listingID:'11',fromDetail:true,verifiedAt:Date.now()}];
 app.setWeaponSearch(async(tier,quantity,{onProgress})=>{
  onProgress({offers:selected,attempted:1,checked:1,budget:10});
  return new Promise(r=>{finish=()=>r({offers:selected,checked:10,total:275,failures:0});});
 });
 const work=app.updateMultiBuyButton();await new Promise(r=>setImmediate(r));
 const button=document.getElementById('tf2-fabricator-multibuy-button');
 assert.ok(new URL(button.href).searchParams.getAll('items[]').includes('Killstreak Bat'));
 assert.match(button.textContent,/search/i);
 let message;window.confirm=text=>{message=text;return false;};
 const e=new window.Event('click',{cancelable:true});button.dispatchEvent(e);
 assert.match(message,/1\/10/);assert.equal(e.defaultPrevented,true);
 window.confirm=()=>true;const accept=new window.Event('click',{cancelable:true});button.dispatchEvent(accept);assert.equal(accept.defaultPrevented,false);
 finish();await work;
 window.confirm=()=>assert.fail('completed search must not show progress popup');button.dispatchEvent(new window.Event('click',{cancelable:true}));
});
test('partial weapon quantity remains purchasable and is labelled as partial',async()=>{
 const {app,document}=await setup(false,2);let finish;
 const offers=[{name:'Killstreak Bat',price:6,priceText:'A$ 0.06',verifiedAt:Date.now()}];
 app.setWeaponSearch(async(t,q,{onProgress})=>{onProgress({offers,attempted:1,checked:1,budget:10});return new Promise(r=>{finish=()=>r({offers,checked:10,total:275,failures:0});});});
 const work=app.updateMultiBuyButton();await new Promise(r=>setImmediate(r));
 const b=document.getElementById('tf2-fabricator-multibuy-button');
 assert.ok(new URL(b.href).searchParams.getAll('items[]').includes('Killstreak Bat'));assert.match(b.textContent,/1\/2/);
 finish();await work;
});

test('finished partial selections still validate native rows and use robot-only fallback when unsupported',async()=>{
 const {app,document}=await setup(true,2);
 app.setWeaponSearch(async()=>({offers:[{name:'Killstreak Bat',price:6,priceText:'A$ 0.06',verifiedAt:Date.now()}],checked:10,total:275,failures:0}));
 await app.updateMultiBuyButton();
 const button=document.getElementById('tf2-fabricator-multibuy-button');
 assert.ok(!new URL(button.href).searchParams.getAll('items[]').includes('Killstreak Bat'));
 assert.match(button.title,/separate|could not price/i);
 assert.match(document.getElementById('tf2-fabricator-cheapest-weapon').textContent,/1.*need 2/);
});
