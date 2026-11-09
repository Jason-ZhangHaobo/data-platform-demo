const id=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const key=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(v);
export function checkedServiceGateWrite(value,{serviceId,requestId,bindingId,input}={}){
 const bad=()=>{throw Error('门禁原保存回执尚未确认；保留原编号，不采用当前新版本替代');};
 if(!value||typeof value!=='object'||value.protocol!=='shuduo-service-contract-gate-write/v1')bad();
 const r=value.receipt,c=value.current,v=r?.appliedVersion;
 if(!r||!c||!v||!id(r.id)||!id(r.serviceId)||!id(r.bindingId)||!key(r.requestId)||!id(v.id)||v.bindingId!==r.bindingId||c.id!==r.bindingId||c.serviceId!==r.serviceId||!['CREATE','VERSION'].includes(r.operation)||!Number.isSafeInteger(r.bindingRevisionAtApply)||r.bindingRevisionAtApply<1||!Number.isSafeInteger(v.versionNumber)||v.versionNumber<1||typeof value.currentMatches!=='boolean'||value.currentMatches!==(c.currentVersion?.id===v.id))bad();
 if(serviceId&&r.serviceId!==serviceId||requestId&&r.requestId!==requestId||bindingId&&r.bindingId!==bindingId)bad();
 if(input&&(v.contractVersionId!==input.contractVersionId||v.freshnessBasis!==(input.freshnessBasis??'SOURCE_ROWS')||input.contractId&&v.contractId!==input.contractId))bad();
 return value;
}
export async function submitServiceGateWrite(client,args){
 if(!id(args.serviceId)||args.bindingId!==undefined&&!id(args.bindingId)||!key(args.requestId))throw Error('需要数据服务、门禁与原请求编号');
 const path=`/data-services/${args.serviceId}/contract-gates`+(args.bindingId?`/${args.bindingId}/versions`:'');
 const result=await client.request(path,{method:'POST',body:args.input,idempotencyKey:args.requestId});return checkedServiceGateWrite(result,args);
}
export async function lookupServiceGateWrite(client,args){
 if(!id(args.serviceId)||!key(args.requestId))throw Error('需要数据服务与原门禁请求编号');
 return checkedServiceGateWrite(await client.request(`/data-services/${args.serviceId}/contract-gate-requests/${args.requestId}`),args);
}
