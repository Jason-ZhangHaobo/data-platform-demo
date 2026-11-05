import {servicePlanSourceBinding,servicePlanSourcePath} from './service-plan-request.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const scoped=plan=>{
 servicePlanSourceBinding(plan?.sourceBinding);
 if(!uuid(plan?.id)||plan.scope!=='LOCAL_TEST_ONLY'||plan.agentIndependentE2E!==false||plan.publicDeployed!==false||plan.completionScope!=='DATA_SERVICE_DESIGN')throw Error('同源规划回执尚未确认');
 return plan;
};
const draftMatches=(service,plan)=>{
 const p=plan.proposal,v=service?.currentVersion;
 return Boolean(p&&uuid(service?.id)&&uuid(v?.id)&&typeof v.configHash==='string'&&/^[a-f0-9]{64}$/.test(v.configHash)&&v.scope==='LOCAL_TEST_ONLY'&&
  service.serviceType===p.serviceType&&service.name===p.name&&service.slug===p.slug&&v.timeoutMs===p.timeoutMs&&v.rateLimitPerMinute===p.rateLimitPerMinute&&
  (p.serviceType==='DAPI'?v.sourceReleaseRunId===plan.sourceBinding.sourceReleaseRunId&&v.sourceReleaseId===plan.sourceBinding.releaseId&&
   v.sourcePackageDigest===plan.sourceBinding.packageDigest&&JSON.stringify(v.fields)===JSON.stringify(p.fields):
   Array.isArray(v.steps)&&v.steps.length===p.steps.length&&p.steps.every((step,index)=>['alias','dapiId','dapiVersionId'].every(key=>step[key]===v.steps[index][key]))));
};
export async function callServicePlan(client,operation,args){
 if(operation==='create'){
  if(!exact(args,['message','sourceBinding','requestId'])||typeof args.message!=='string'||args.message.trim().length<4||args.message.trim().length>2000||!uuid(args.requestId))throw Error('服务规划须提供原来源、需求和唯一请求UUID');
  const sourceBinding=servicePlanSourceBinding(args.sourceBinding),result=await client.request('/data-services/agent/plans',{method:'POST',idempotencyKey:args.requestId,body:{message:args.message.trim(),sourceBinding}});
  let same=false;try{same=JSON.stringify(servicePlanSourceBinding(result?.sourceBinding))===JSON.stringify(sourceBinding);}catch{}
  if(!uuid(result?.id)||result.requestId!==args.requestId||result.message!==args.message.trim()||!same||result.scope!=='LOCAL_TEST_ONLY'||
   result.agentIndependentE2E!==false||result.publicDeployed!==false||result.completionScope!=='DATA_SERVICE_DESIGN'||result.fullLifecycleE2E!==false||
   !['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED','APPLIED'].includes(result.status))
   throw Error(`原规划回执尚未确认，请查询请求编号 ${args.requestId}；未自动重新提交`);
  return result;
 }
 if(operation==='list'){
  if(!exact(args,['sourceBinding']))throw Error('方案列表须指定完整来源');
  const binding=servicePlanSourceBinding(args.sourceBinding),plans=await client.request(servicePlanSourcePath(binding));
  if(!Array.isArray(plans)||plans.some(plan=>JSON.stringify(servicePlanSourceBinding(scoped(plan).sourceBinding))!==JSON.stringify(binding)))throw Error('同源规划列表回执不一致');
  return plans;
 }
 const field=operation==='request'?'requestId':'planId';
 if(!['request','detail','apply','cancel'].includes(operation)||!exact(args,[field])||!uuid(args[field]))throw Error('规划操作须指定原任务或请求UUID，不接受执行者与覆盖字段');
 if(operation==='request'){
  const plan=scoped(await client.request('/data-services/agent/requests/'+args.requestId));if(plan.requestId!==args.requestId)throw Error('未取得原请求的规划任务');return plan;
 }
 if(operation==='cancel'){
  const plan=scoped(await client.request('/data-services/agent/plans/'+args.planId+'/cancel',{method:'POST',body:{sourceBoundOnly:true}}));
  if(plan.id!==args.planId||!['CANCELLED','SUCCEEDED','FAILED','INTERRUPTED','APPLIED'].includes(plan.status))throw Error('取消结果尚未确认，请沿原方案查询');return plan;
 }
 const path='/data-services/agent/plans/'+args.planId,plan=scoped(await client.request(path));
 if(plan.id!==args.planId)throw Error('原规划编号不一致');
 if(operation==='detail')return plan;
 if(plan.sourceCheck==='UNAVAILABLE')throw Error('原来源当前未通过复核，只能读取或取消原规划');
 if(!['SUCCEEDED','APPLIED'].includes(plan.status)||!plan.proposal)throw Error('原方案尚未核验通过，不能应用');
 const service=await client.request(path+'/apply',{method:'POST',body:{}});
 if(!draftMatches(service,plan))throw Error('草稿回执尚未与原规划对应，请查询原方案；未自动重试');
 return service;
}
