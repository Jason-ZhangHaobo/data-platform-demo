import {createAgentSubmission} from './agent-submission.ts';

export type ServicePlanSource={taskId:string;packageDigest:string;releaseId:string;sourceReleaseRunId:string};
export type SourcePlan={id:string;status:string;message:string;requestId?:string;sourceBinding?:ServicePlanSource;scope?:string;
 sourceCheck?:'VERIFIED'|'UNAVAILABLE';
 sourceContext?:{name:string;definition:string};
 completionScope?:string;fullLifecycleE2E?:boolean;agentIndependentE2E?:boolean;publicDeployed?:boolean;proposal?:{serviceType:string;name:string;slug:string;timeoutMs:number;rateLimitPerMinute:number;sourceReleaseRunId?:string;fields?:string[];steps?:{alias:string;dapiId:string;dapiVersionId:string}[]};
 error?:string;explanation?:string;serviceId?:string;appliedVersionId?:string;appliedConfigHash?:string};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const keys=['taskId','packageDigest','releaseId','sourceReleaseRunId'] as const;
export function validServicePlanSource(value:unknown):value is ServicePlanSource{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const source=value as ServicePlanSource;
 return Object.keys(source).length===4&&keys.every(key=>Object.hasOwn(source,key))&&[source.taskId,source.releaseId,source.sourceReleaseRunId].every(uuid)&&/^[a-f0-9]{64}$/.test(source.packageDigest);
}
export function sameServicePlanSource(a:unknown,b:unknown){return validServicePlanSource(a)&&validServicePlanSource(b)&&keys.every(key=>a[key]===b[key]);}
export function boundServicePlansPath(source:ServicePlanSource){
 if(!validServicePlanSource(source))throw Error('服务规划来源不完整');
 return '/data-services/agent/plans?'+new URLSearchParams({agent_task_id:source.taskId,package_digest:source.packageDigest,release_id:source.releaseId,source_release_run_id:source.sourceReleaseRunId});
}
export function sourcePlanReceiptValid(plan:SourcePlan|undefined,source:ServicePlanSource){
 if(!plan||!uuid(plan.id)||!sameServicePlanSource(plan.sourceBinding,source)||!uuid(plan.requestId)||plan.scope!=='LOCAL_TEST_ONLY'||
  plan.completionScope!=='DATA_SERVICE_DESIGN'||plan.fullLifecycleE2E!==false||plan.agentIndependentE2E!==false||plan.publicDeployed!==false||
  !['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','APPLIED'].includes(plan.status)||typeof plan.message!=='string'||plan.message.length>2000||
  [plan.error,plan.explanation].some(value=>value!==undefined&&(typeof value!=='string'||value.length>8000)))return false;
 if(plan.sourceCheck!==undefined&&!['VERIFIED','UNAVAILABLE'].includes(plan.sourceCheck))return false;
 if(plan.sourceContext&&(typeof plan.sourceContext.name!=='string'||typeof plan.sourceContext.definition!=='string'))return false;
 const p=plan.proposal;
 if(['SUCCEEDED','APPLIED'].includes(plan.status)&&!p)return false;
 if(p&&(!['DAPI','XAPI'].includes(p.serviceType)||typeof p.name!=='string'||p.name.length>80||typeof p.slug!=='string'||p.slug.length>48||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(p.slug)||
  !Number.isSafeInteger(p.timeoutMs)||p.timeoutMs<100||p.timeoutMs>5000||!Number.isSafeInteger(p.rateLimitPerMinute)||p.rateLimitPerMinute<1||p.rateLimitPerMinute>600))return false;
 if(p?.serviceType==='DAPI'&&(p.sourceReleaseRunId!==source.sourceReleaseRunId||!Array.isArray(p.fields)||!p.fields.includes('client_id')||p.fields.length>5||new Set(p.fields).size!==p.fields.length||
  p.fields.some(field=>!['client_id','holding_market_value','available_cash','total_assets','security_count'].includes(field))))return false;
 if(p?.serviceType==='XAPI'&&(!Array.isArray(p.steps)||p.steps.length<2||p.steps.length>5||p.steps.some(step=>!uuid(step.dapiId)||!uuid(step.dapiVersionId)||!/^[a-z][a-z0-9_]{1,29}$/.test(step.alias))))return false;
 return plan.status!=='APPLIED'||uuid(plan.serviceId)&&uuid(plan.appliedVersionId)&&typeof plan.appliedConfigHash==='string'&&/^[a-f0-9]{64}$/.test(plan.appliedConfigHash);
}
export function servicePlanMarker(href:string){
 const query=new URL(href).searchParams,requestId=query.get('service_plan_request')??undefined,planId=query.get('service_plan')??undefined,batchId=query.get('service_plan_batch')??undefined;
 if(['service_plan_request','service_plan','service_plan_batch'].some(key=>query.getAll(key).length>1)||requestId&&planId||
  [requestId,planId,batchId].some(value=>value!==undefined&&!uuid(value))||(requestId||planId)&&!batchId)return{invalid:true} as const;
 return {invalid:false,requestId,planId,batchId} as const;
}
// Historical navigation only. This tuple never substitutes for a verified
// release source when creating a model task or applying its proposal.
export function servicePlanRecoverySource(binding:{taskId:string;packageDigest:string;releaseId:string}|undefined,href:string|undefined):ServicePlanSource|undefined{
 if(!binding||!href)return;
 const marker=servicePlanMarker(href);if(marker.invalid||!marker.requestId&&!marker.planId)return;
 const candidate={taskId:binding.taskId,packageDigest:binding.packageDigest,releaseId:binding.releaseId,sourceReleaseRunId:marker.batchId};
 return validServicePlanSource(candidate)?candidate:undefined;
}
export function servicePlanLocation(href:string,{batchId,requestId,planId}:{batchId:string;requestId?:string;planId?:string}){
 if(!uuid(batchId)||requestId!==undefined&&!uuid(requestId)||planId!==undefined&&!uuid(planId)||requestId&&planId)throw Error('服务规划恢复编号不合法');
 const url=new URL(href);url.username='';url.password='';
 for(const key of ['service_plan_request','service_plan','service_plan_batch'])url.searchParams.delete(key);
 url.searchParams.set('service_plan_batch',batchId);if(requestId)url.searchParams.set('service_plan_request',requestId);if(planId)url.searchParams.set('service_plan',planId);return url;
}
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export function createServicePlanSubmission<T extends {id:string}>(options:{api:Api;initialKey?:string;onPending:(key:string|undefined)=>void;makeKey?:()=>string}){
 return createAgentSubmission<T>({...options,api:<R,>(path:string,body?:unknown,requestOptions?:{idempotencyKey?:string})=>{
  if(path==='/agent/tasks')return options.api<R>('/data-services/agent/plans',body,requestOptions);
  if(path.startsWith('/agent/requests/'))return options.api<R>('/data-services/agent/requests/'+path.slice('/agent/requests/'.length));
  throw Error('服务规划恢复只允许原创建和查询路径');
 }});
}
