import test from 'node:test';
import assert from 'node:assert/strict';
import {createOpeningUsage} from '../../scripts/invited-opening-usage.mjs';
import {READONLY_ENTRY_SCOPE} from '../../scripts/invited-readonly-entry.mjs';
import {READONLY_FILING_SCOPE,READONLY_RUNTIME_SCOPE} from '../../scripts/invited-opening-scopes.mjs';
const time=Date.UTC(2026,9,26);
const input={authorization:READONLY_ENTRY_SCOPE,operationId:'a'.repeat(32),operatorSource:'b'.repeat(40),issuedAt:time,expiresAt:time+3600000};
function fixture(){let cp;const options={...input,load:()=>cp,save:v=>{cp=structuredClone(v);},now:()=>time};return{options,get:()=>cp,set:v=>{cp=v;},open:()=>createOpeningUsage(options)};}
test('runtime and HTTP probes share twenty new requests while preserving 131 metadata and 69 probe history',()=>{
 let cp;const options={...input,authorization:READONLY_RUNTIME_SCOPE,load:()=>cp,save:value=>{cp=value;},now:()=>time};const usage=createOpeningUsage(options);
 for(let i=0;i<9;i++)usage.reserve('PRIVATE_PROBE');for(let i=0;i<11;i++)usage.reserve('HTTP_PROBE');
 usage.reserve('FC_READ');assert.deepEqual(usage.counts(),{configurationReads:1,newRequests:20,cumulativeRequests:89,cumulativeConfigurationReads:132});
 assert.throws(()=>usage.reserve('PRIVATE_PROBE'),/REQUEST_LIMIT/);assert.throws(()=>createOpeningUsage({...options,authorization:READONLY_FILING_SCOPE}),/CHECKPOINT_MISMATCH/);
});
test('new filing grant retains both historical counters and cannot adopt the old 55-request grant ledger',()=>{
 let cp;const options={...input,authorization:READONLY_FILING_SCOPE,load:()=>cp,save:v=>{cp=v;},now:()=>time};
 const u=createOpeningUsage(options);u.reserve('FC_READ');u.reserve('HTTP_PROBE');
 assert.deepEqual(u.counts(),{configurationReads:1,newRequests:1,cumulativeRequests:62,cumulativeConfigurationReads:59});
 cp.historicalRequests=55;assert.throws(()=>createOpeningUsage(options),/CHECKPOINT_MISMATCH/);
});
test('all metadata readers share one write-ahead ledger, preserving 55 historical requests on restart',()=>{
 const f=fixture(),usage=f.open();
 for(const name of ['IDENTITY','BILL_PAGE','FC_READ','DOMAIN_READ','OSS_METADATA','RAM_READ'])usage.reserve(name);
 for(let i=0;i<6;i++)usage.reserve('PRIVATE_PROBE');
 assert.deepEqual(usage.counts(),{configurationReads:6,newRequests:6,cumulativeRequests:61});
 const restored=f.open();restored.reserve('HTTP_PROBE');restored.reserve('OBJECT_GET');
 assert.deepEqual(restored.counts(),{configurationReads:6,newRequests:7,cumulativeRequests:62});
 assert.equal(f.get().usage.OBJECT_GET,1);
});
test('normal steps cannot consume the 20-read cleanup reserve or reset it at another stage',()=>{
 const f=fixture(),usage=f.open();for(let i=0;i<60;i++)usage.reserve('FC_READ');
 assert.throws(()=>usage.reserve('RAM_READ'),/CONFIGURATION_READ_LIMIT/);
 const resumed=f.open();assert.throws(()=>resumed.reserve('BILL_PAGE'),/CONFIGURATION_READ_LIMIT/);
 resumed.beginCleanup();for(let i=0;i<20;i++)resumed.reserve('RAM_READ');
 assert.throws(()=>resumed.reserve('FC_READ'),/CONFIGURATION_READ_LIMIT/);
 assert.throws(()=>resumed.reserve('HTTP_PROBE'),/APPLICATION_REQUEST_LIMIT/);
 assert.equal(resumed.counts().configurationReads,80);
});
test('unknown responses stay charged, failed durable saves poison the writer, and no async save is accepted',()=>{
 const f=fixture(),usage=f.open();usage.reserve('HTTP_PROBE');
 assert.equal(f.open().counts().newRequests,1);
 const bad=createOpeningUsage({...f.options,save:()=>{throw Error('disk full');}});
 assert.throws(()=>bad.reserve('FC_READ'),/disk full/);
 assert.throws(()=>bad.reserve('FC_READ'),/STORAGE_UNCONFIRMED/);
 assert.equal(f.get().usage.FC_READ,0);
 assert.throws(()=>createOpeningUsage({...input,load:()=>undefined,save:async()=>{},now:()=>time}),/SYNCHRONOUS_SAVE_REQUIRED/);
});
test('expired, changed identity, old scope, malformed counts and unbounded binary requests are rejected',()=>{
 const f=fixture();f.open();
 for(const patch of [{authorization:'INVITED_READ_ONLY_OPENING'},{operationId:'c'.repeat(32)},{operatorSource:'c'.repeat(40)},{expiresAt:time+3599000}])assert.throws(()=>createOpeningUsage({...f.options,...patch}));
 assert.throws(()=>createOpeningUsage({...f.options,now:()=>time+3600000}).reserve('FC_READ'),/EXPIRED/);
 const original=structuredClone(f.get());f.set({...original,historicalRequests:0});assert.throws(()=>f.open());
 f.set({...original,usage:{...original.usage,FC_READ:-1}});assert.throws(()=>f.open());
 f.set(original);const usage=f.open();
 for(let i=0;i<2;i++)usage.reserve('OBJECT_PUT');assert.throws(()=>usage.reserve('OBJECT_PUT'),/PUT_LIMIT/);
 for(let i=0;i<8;i++)usage.reserve('OBJECT_GET');assert.throws(()=>usage.reserve('OBJECT_GET'),/GET_LIMIT/);
 for(let i=0;i<60;i++)usage.reserve('HTTP_PROBE');assert.throws(()=>usage.reserve('PRIVATE_PROBE'),/REQUEST_LIMIT/);
 assert.throws(()=>usage.reserve('ARBITRARY_ACTION'),/KIND_INVALID/);
});
