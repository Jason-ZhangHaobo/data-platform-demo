// Shared request syntax only: no store, model, filesystem or execution imports.
const keys=['taskId','packageDigest','releaseId','sourceReleaseRunId'];
const names={taskId:'agent_task_id',packageDigest:'package_digest',releaseId:'release_id',sourceReleaseRunId:'source_release_run_id'};
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const invalid=()=>Object.assign(Error('规划来源须包含确切任务、交付包、发布与成功批次'),{status:422,code:'INVALID_SERVICE_PLAN_SOURCE'});
export function servicePlanSourceBinding(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==4||!keys.every(key=>Object.hasOwn(input,key))||
  ![input.taskId,input.releaseId,input.sourceReleaseRunId].every(uuid)||typeof input.packageDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.packageDigest))throw invalid();
 return Object.fromEntries(keys.map(key=>[key,input[key]]));
}
export function servicePlanSourceQuery(query){
 if([...query.keys()].length===0)return;
 if([...query.keys()].length!==4||Object.values(names).some(name=>query.getAll(name).length!==1))throw invalid();
 return servicePlanSourceBinding(Object.fromEntries(Object.entries(names).map(([key,name])=>[key,query.get(name)])));
}
export function servicePlanSourcePath(binding){
 const value=servicePlanSourceBinding(binding);return '/data-services/agent/plans?'+new URLSearchParams(Object.entries(names).map(([key,name])=>[name,value[key]]));
}
