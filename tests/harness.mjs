import vm from 'node:vm';
import {parseHTML,DOMParser} from 'linkedom';
import {bundle} from '../scripts/build.mjs';
export async function loadApp(html='<html><head></head><body></body></html>') {
  const {window,document}=parseHTML(html);
  const location={pathname:'/profiles/76561198000000001/inventory',href:'https://steamcommunity.com/profiles/76561198000000001/inventory',origin:'https://steamcommunity.com'};
  window.location=location;
  // Linkedom exposes select.value without a setter; emulate the browser property.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{
    configurable:true,
    get(){const opts=[...this.querySelectorAll('option')];return (opts.find(o=>o.hasAttribute('selected'))||opts[0])?.value;},
    set(value){for(const o of this.querySelectorAll('option'))o.toggleAttribute('selected',o.value===value);}
  });
  window.getComputedStyle=e=>({display:e.style?.display||'block',visibility:'visible'});
  window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden], [style*="display:none"], [style*="display: none"]')?[]:[{}];};
  const logs=[];
  const ctx=vm.createContext({window,document,location,DOMParser,URL,URLSearchParams,AbortController,DOMException,
    console:{log:(...x)=>logs.push(x),warn:(...x)=>logs.push(x),error:(...x)=>logs.push(x)},
    GM_getValue:(_,fallback)=>fallback,GM_setValue:()=>{},GM_xmlhttpRequest:()=>{throw Error('Unexpected live network request');},
    setTimeout,clearTimeout,setInterval,requestAnimationFrame:f=>f(),MutationObserver:window.MutationObserver});
  const exports=['parseSteamPrice','formatSteamCurrency','findFabricatorParts','findRequiredKillstreakWeapon',
    'findFinishedKitName','buildMultiBuyURL','extractIndividualOffers','parseRobotPartInventoryPage',
    'missingRobotParts','isViewedInventoryOwn','getMultiBuyTotal','validatePublishedPriceDatabase',
    'redactDiagnosticText','ownedRobotInventory','createInventoryPriceSettings','updateMultiBuyButton',
    'decodeSteamMarketResponse','getCheapestInputWeapon','priceDatabase','SmartPricing','walletContext'];
  const source=await bundle({bootstrap:false});
  const declaration=source.includes('function decodeSteamMarketResponse(')?'':'const decodeSteamMarketResponse=undefined;';
  const code=source.replace(/\n\}\)\(\);\s*$/,`\n${declaration}\nglobalThis.app={${exports.join(',')},setHTML:fn=>requestHTML=fn,setJSON:fn=>requestJSON=fn,setInventory:fn=>requestInventoryJSON=fn,refreshOwnedRobotInventory};\n})();`);
  vm.runInContext(code,ctx);
  return {app:ctx.app,ctx,document,window,logs,run:s=>vm.runInContext(s,ctx)};
}
export const part='Battle-Worn Robot Money Furnace';
export const card=(tier='Professional',qty=2)=>`<div data-featuretarget="iteminfo" data-props='{"steamidOwner":"76561198000000001"}'>
<h1>${tier} Killstreak Bat Kit Fabricator</h1><div class="recipe">
<div>The following are the inputs that must be fulfilled.</div>
<div>Unique ${tier==='Professional'?'Specialized ':''}Killstreak Item x ${qty}</div>
<div>${part} x 6</div><div>Reinforced Robot Bomb Stabilizer x 2</div>
<div>You will receive all of the following outputs</div><div>${tier} Killstreak Bat Kit</div></div></div>`;
export function listing(name='Killstreak Bat',prices=[6,25],currency=2021) {
  return {success:true,total_count:prices.length,listinginfo:Object.fromEntries(prices.map((p,i)=>[String(i+1),
    {listingid:String(i+1),price:999,fee:111,converted_currencyid:currency,asset:{appid:440,id:String(i+1),amount:'1'}}])),
    results_html:prices.map((p,i)=>`<div class="market_listing_row" id="listing_${i+1}"><span class="market_listing_price_with_fee">A$ ${(p/100).toFixed(2)}</span></div>`).join('')};
}
