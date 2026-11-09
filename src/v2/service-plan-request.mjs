// Shared request syntax only: no store, model, filesystem or execution imports.
const common=['packageDigest','releaseId','sourceReleaseRunId'];
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const invalid=()=>Object.assign(Error('规划来源须包含确切任务或手工交付、包、发布与成功批次'),{status:422,code:'INVALID_SERVICE_PLAN_SOURCE'});
const identity=input=>Object.hasOwn(input,'manualDeliveryTaskId')?'manualDeliveryTaskId':'taskId';
const names=key=>({[key]:key==='manualDeliveryTaskId'?'manual_delivery_task_id':'agent_task_id',packageDigest:'package_digest',releaseId:'release_id',sourceReleaseRunId:'source_release_run_id'});
export function servicePlanSourceBinding(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw invalid();const key=identity(input),keys=[key,...common];
 if(Object.keys(input).length!==4||!keys.every(k=>Object.hasOwn(input,k))||![input[key],input.releaseId,input.sourceReleaseRunId].every(uuid)||typeof input.packageDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.packageDigest))throw invalid();
 return Object.fromEntries(keys.map(k=>[k,input[k]]));
}
export function servicePlanSourceQuery(query){
 if([...query.keys()].length===0)return;
 const key=query.has('manual_delivery_task_id')?'manualDeliveryTaskId':'taskId',fields=names(key);
 if([...query.keys()].length!==4||Object.values(fields).some(name=>query.getAll(name).length!==1))throw invalid();
 return servicePlanSourceBinding(Object.fromEntries(Object.entries(fields).map(([k,name])=>[k,query.get(name)])));
}
export function servicePlanSourcePath(binding){
 const value=servicePlanSourceBinding(binding);return '/data-services/agent/plans?'+new URLSearchParams(Object.entries(names(identity(value))).map(([k,name])=>[name,value[k]]));
}
export function serviceAgentContextPath(binding){return servicePlanSourcePath(binding).replace('/agent/plans?','/agent/context?');}
