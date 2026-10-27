// Deterministic scheduling model, not a live Steam latency benchmark.
import assert from 'node:assert/strict';
import {SmartPricing} from '../src/pricing.js';
const output=[];
for(const [mode,names] of [['Fast',10],['Balanced',25],['Long',50]]) {
  let clock=0,calls=0,first=null;
  const client=SmartPricing.createClient({now:()=>clock,wait:async ms=>{clock+=ms;},interval:3400});
  await SmartPricing.scan({names:Array.from({length:275},(_,i)=>'Weapon '+i),limit:names,quantity:2,
    read:name=>client.get(name,async()=>{calls++;clock+=100;return [0,1].map(i=>({name,
      price:6+i,listingID:name+':'+i,currency:'AUD',fromDetail:true}));}),
    onProgress:r=>{if(first===null&&r.offers.length===2)first=clock;}});
  assert.equal(calls,names);
  output.push({mode,listingRequests:calls,firstTwoOffersMs:first,finishedMs:clock});
}
console.log(JSON.stringify({method:'Virtual clock, 100ms responses, 3400ms pacing, warm ranking; excludes inventory, kit and checkout traffic. No live speed claim.',
  baseline:'Balanced searched 25 names before seller checks: minimum 85000ms to start the first seller request under these assumptions.',results:output},null,2));
