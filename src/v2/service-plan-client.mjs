import {servicePlanSourceBinding,servicePlanSourcePath} from './service-plan-request.mjs';
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const scoped=plan=>{
 servicePlanSourceBinding(plan?.sourceBinding);
 const privatePlan=plan?.scope==='PRIVATE_CLOUD_TEST'&&plan.executionMode==='DURABLE_PRIVATE_SERVICE_AGENT_V1'&&['EXPLICIT_ADVANCE','OSS_EVENTS'].includes(plan.recovery?.driver)&&plan.recovery?.supported===true&&plan.recovery?.backgroundDispatcherVerified===false&&
  (!plan.recovery.background||plan.recovery.driver==='OSS_EVENTS'&&plan.recovery.background.protocol==='shuduo-service-agent-event-driver/v1'&&plan.recovery.background.taskId===plan.id&&plan.recovery.background.cloudDriverVerified===false&&plan.recovery.background.publicationAutomatic!==true);
 if(!uuid(plan?.id)||plan.scope!=='LOCAL_TEST_ONLY'&&!privatePlan||plan.agentIndependentE2E!==false||plan.publicDeployed!==false||plan.completionScope!=='DATA_SERVICE_DESIGN')throw Error('同源规划回执尚未确认');
 return plan;
};
const draftMatches=(service,plan)=>{
 const p=plan.proposal,v=service?.currentVersion;
 return Boolean(p&&uuid(service?.id)&&uuid(v?.id)&&typeof v.configHash==='string'&&/^[a-f0-9]{64}$/.test(v.configHash)&&v.scope===plan.scope&&
  service.serviceType===p.serviceType&&service.name===p.name&&service.slug===p.slug&&v.timeoutMs===p.timeoutMs&&v.rateLimitPerMinute===p.rateLimitPerMinute&&
  (p.serviceType==='DAPI'?v.sourceReleaseRunId===plan.sourceBinding.sourceReleaseRunId&&v.sourceReleaseId===plan.sourceBinding.releaseId&&
   v.sourcePackageDigest===plan.sourceBinding.packageDigest&&JSON.stringify(v.fields)===JSON.stringify(p.fields):
   Array.isArray(v.steps)&&v.steps.length===p.steps.length&&p.steps.every((step,index)=>['alias','dapiId','dapiVersionId'].every(key=>step[key]===v.steps[index][key]))));
};
export async function callServicePlan(client,operation,args){
 if(operation==='create'){
  if(!exact(args,['message','sourceBinding','requestId'])||typeof args.message!=='string'||args.message.trim().length<4||args.message.trim().length>2000||!uuid(args.requestId))throw Error('服务规划须提供原来源、需求和唯一请求UUID');
  const sourceBinding=servicePlanSourceBinding(args.sourceBinding),result=await client.request('/data-services/agent/plans',{method:'POST',idempotencyKey:args.requestId,body:{message:args.message.trim(),sourceBinding}});
  let same=false,validScope=false;try{same=JSON.stringify(servicePlanSourceBinding(result?.sourceBinding))===JSON.stringify(sourceBinding);scoped(result);validScope=true;}catch{}
  if(!uuid(result?.id)||result.requestId!==args.requestId||result.message!==args.message.trim()||!same||!validScope||
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
 if(operation==='advance'){
  if(!args||Object.keys(args).some(key=>!['planId','expectedVersion','confirmModelRetry'].includes(key))||!uuid(args.planId)||!Number.isSafeInteger(args.expectedVersion)||args.expectedVersion<1||args.confirmModelRetry!==undefined&&typeof args.confirmModelRetry!=='boolean')throw Error('推进须指定原规划和已读取的版本，未知模型重试须明确确认');
  const path='/data-services/agent/plans/'+args.planId,plan=scoped(await client.request(path));
  if(plan.id!==args.planId||plan.scope!=='PRIVATE_CLOUD_TEST'||plan.version!==args.expectedVersion)throw Error('仅可推进已读取的原持久私有规划版本');
  const result=scoped(await client.request(path+'/advance',{method:'POST',body:{expectedVersion:args.expectedVersion,...(args.confirmModelRetry===undefined?{}:{confirmModelRetry:args.confirmModelRetry})},timeoutMs:105000}));
  if(result.id!==plan.id||result.requestId!==plan.requestId||JSON.stringify(result.sourceBinding)!==JSON.stringify(plan.sourceBinding))throw Error('推进回执尚未对应原任务，请查询原编号，不要重复调用模型');return result;
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
 if(plan.scope==='PRIVATE_CLOUD_TEST'&&!/^[a-f0-9]{64}$/.test(plan.proposalHash??''))throw Error('原私有规划摘要尚未确认');
 const service=await client.request(path+'/apply',{method:'POST',body:plan.scope==='PRIVATE_CLOUD_TEST'?{proposalHash:plan.proposalHash}:{}});
 if(!draftMatches(service,plan))throw Error('草稿回执尚未与原规划对应，请查询原方案；未自动重试');
 return service;
}
