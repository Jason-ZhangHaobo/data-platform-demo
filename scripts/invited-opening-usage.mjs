// One serial, durable request ledger for the proposed invited opening. The
// owner coordinator hands its checkpoint to the protected workflow, then takes
// back the authenticated encrypted result before cleanup. Never run two writers
// or reset the ledger at a code/entry/IAM boundary. This module makes no calls.
import {openingScope} from './invited-opening-scopes.mjs';
const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const reads=['IDENTITY','BILL_PAGE','FC_READ','DOMAIN_READ','OSS_METADATA','RAM_READ'];
const probes=['PRIVATE_PROBE','HTTP_PROBE'];
const writes=['CODE_WRITE','ENTRY_WRITE','RAM_WRITE'];
const names=[...reads,...probes,...writes,'OBJECT_GET','OBJECT_PUT'];
const sum=(usage,keys)=>keys.reduce((total,key)=>total+usage[key],0);

export function createOpeningUsage({authorization,operationId,operatorSource,issuedAt,expiresAt,load,save,now=Date.now}){
 const scope=openingScope(authorization);
 check(/^[a-f0-9]{32}$/.test(operationId??'')&&/^[a-f0-9]{40}$/.test(operatorSource??''),'OPENING_USAGE_IDENTITY_INVALID');
 check(Number.isSafeInteger(issuedAt)&&Number.isSafeInteger(expiresAt)&&issuedAt<=now()&&expiresAt>issuedAt&&expiresAt-issuedAt<=3600000,'OPENING_USAGE_WINDOW_INVALID');
 check(typeof load==='function'&&typeof save==='function','OPENING_USAGE_STORAGE_REQUIRED');
 const binding={authorization,operationId,operatorSource,issuedAt,expiresAt};
 let cp=load(),poisoned=false;
 const persist=value=>{
  try{const result=save(structuredClone(value));check(!result||typeof result.then!=='function','OPENING_SYNCHRONOUS_SAVE_REQUIRED');cp=value;}
  catch(error){poisoned=true;throw error;}
 };
 if(cp){
  check(Object.entries(binding).every(([key,value])=>cp[key]===value)&&cp.version===1&&cp.historicalRequests===scope.historicalRequests&&(cp.historicalConfigurationReads??0)===scope.historicalConfigurationReads,'OPENING_USAGE_CHECKPOINT_MISMATCH');
  check(['ACTIVE','CLEANUP'].includes(cp.phase)&&cp.usage&&Object.keys(cp.usage).sort().join()===names.slice().sort().join()&&names.every(key=>Number.isSafeInteger(cp.usage[key])&&cp.usage[key]>=0),'OPENING_USAGE_CHECKPOINT_INVALID');
  check(sum(cp.usage,reads)<=80&&sum(cp.usage,probes)<=60&&cp.usage.OBJECT_GET<=8&&cp.usage.OBJECT_PUT<=2,'OPENING_USAGE_LIMIT_INVALID');
  cp=structuredClone(cp);
 }else persist({...binding,version:1,historicalRequests:scope.historicalRequests,...(scope.filingRepair?{historicalConfigurationReads:58}:{}),phase:'ACTIVE',usage:Object.fromEntries(names.map(name=>[name,0]))});
 const active=()=>{check(!poisoned,'OPENING_USAGE_STORAGE_UNCONFIRMED');check(now()<expiresAt,'OPENING_USAGE_EXPIRED');};
 return{
  reserve(name){
   active();check(names.includes(name),'OPENING_USAGE_KIND_INVALID');
   const configurationReads=sum(cp.usage,reads),newRequests=sum(cp.usage,probes);
   if(reads.includes(name))check(configurationReads<(cp.phase==='CLEANUP'?80:60),'OPENING_CONFIGURATION_READ_LIMIT');
   if(probes.includes(name))check(cp.phase==='ACTIVE'&&newRequests<60,'OPENING_APPLICATION_REQUEST_LIMIT');
   if(writes.includes(name)&&cp.phase==='ACTIVE')check(now()<expiresAt-300000,'OPENING_CLEANUP_TIME_RESERVE');
   // Individual engines enforce exact target and one-write limits. These
   // bounds additionally stop unbounded binary transfers at the shared layer.
   if(name==='OBJECT_PUT')check(cp.usage[name]<2,'OPENING_OBJECT_PUT_LIMIT');
   if(name==='OBJECT_GET')check(cp.usage[name]<8,'OPENING_OBJECT_GET_LIMIT');
   const next=structuredClone(cp);next.usage[name]++;persist(next);
  },
  beginCleanup(){active();if(cp.phase!=='CLEANUP')persist({...structuredClone(cp),phase:'CLEANUP'});},
  snapshot:()=>structuredClone(cp),
  counts:()=>({configurationReads:sum(cp.usage,reads),newRequests:sum(cp.usage,probes),cumulativeRequests:scope.historicalRequests+sum(cp.usage,probes),...(scope.filingRepair?{cumulativeConfigurationReads:58+sum(cp.usage,reads)}:{})}),
 };
}
