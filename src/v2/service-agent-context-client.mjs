import {servicePlanSourceBinding,serviceAgentContextPath} from './service-plan-request.mjs';

// Portable metadata validation only. No store, model, fixture or filesystem.
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>=1&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value);
const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
const validFields=value=>Array.isArray(value)&&value.length>=1&&value.length<=5&&new Set(value).size===value.length&&value.every(field=>fields.includes(field));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function checkedServiceAgentContext(value,source){
 const binding=servicePlanSourceBinding(source),fail=()=>{throw Error('规划上下文回执未与当前私有发布来源对应；未调用模型');};
 try{
  if(!exact(value,['protocol','scope','sourceBinding','sourceKind',...(value?.sourceKind==='MANUAL'?['sourceAttribution']:[]),'sourceContext','releaseRuns','services','resourceVersions','resourcesTruncated','unavailableServiceCount','planning','agentIndependentE2E','publicDeployed'])||
   value.protocol!=='shuduo-service-agent-context/v1'||value.scope!=='PRIVATE_CLOUD_TEST'||!['AGENT','MANUAL'].includes(value.sourceKind)||binding.manualDeliveryTaskId!==undefined&&value.sourceKind!=='MANUAL'||
   value.sourceKind==='MANUAL'&&value.sourceAttribution!==(binding.manualDeliveryTaskId?'ENGINEER_AUTHORED':'ENGINEER_ASSISTED')||!same(servicePlanSourceBinding(value.sourceBinding),binding)||
   value.agentIndependentE2E!==false||value.publicDeployed!==false||!exact(value.planning,['enabled','code'])||value.planning.enabled!==false||value.planning.code!=='PRIVATE_SERVICE_AGENT_EXECUTION_NOT_ENABLED')fail();
  const context=value.sourceContext,run=value.releaseRuns?.[0];
  if(!exact(context,['id','name','definition','validationContractId','metricLabels'])||!text(context.id,100)||!text(context.name,160)||!text(context.definition,2000)||
   !text(context.validationContractId,160)||!exact(context.metricLabels,fields)||fields.some(field=>!text(context.metricLabels[field],160))||
   !Array.isArray(value.releaseRuns)||value.releaseRuns.length!==1||!exact(run,['id','releaseId','packageDigest',binding.manualDeliveryTaskId?'manualDeliveryTaskId':'sourceAgentTaskId','sourceRevisionId','sourceRunId','scope','sourceKind','status','published','schedulerTriggered','engine','engineVersion'])||
   run.id!==binding.sourceReleaseRunId||run.releaseId!==binding.releaseId||run.packageDigest!==binding.packageDigest||(binding.manualDeliveryTaskId?run.manualDeliveryTaskId!==binding.manualDeliveryTaskId||run.sourceAgentTaskId!==undefined:run.sourceAgentTaskId!==binding.taskId||run.manualDeliveryTaskId!==undefined)||
   !uuid(run.sourceRevisionId)||!uuid(run.sourceRunId)||run.scope!==value.scope||run.sourceKind!==value.sourceKind||run.status!=='SUCCEEDED'||run.published!==true||run.schedulerTriggered!==true||run.engine!=='Apache Spark'||!text(run.engineVersion,40))fail();
  if(!Array.isArray(value.services)||value.services.length>100||new Set(value.services.map(item=>item?.id)).size!==value.services.length||
   !Array.isArray(value.resourceVersions)||value.resourceVersions.length!==value.services.length||typeof value.resourcesTruncated!=='boolean'||
   !Number.isSafeInteger(value.unavailableServiceCount)||value.unavailableServiceCount<0)fail();
  for(const [index,item] of value.services.entries()){
   const version=item.publishedVersion,ref=value.resourceVersions[index];
   if(!exact(item,['id','name','slug','serviceType','status','publishedVersion'])||!uuid(item.id)||!text(item.name,100)||!text(item.slug,48)||!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(item.slug)||
    item.serviceType!=='DAPI'||item.status!=='PUBLISHED'||!exact(version,['id','configHash','fields'])||!uuid(version.id)||!digest(version.configHash)||!validFields(version.fields)||
    !exact(ref,['serviceId','versionId','configHash','fields'])||ref.serviceId!==item.id||ref.versionId!==version.id||ref.configHash!==version.configHash||!same(ref.fields,version.fields))fail();
  }
 }catch{fail();}
 return value;
}
export async function readServiceAgentContext(client,args){
 if(!exact(args,['sourceBinding']))throw Error('上下文核对只接受完整来源，不接受执行者、模型或写入参数');
 const source=servicePlanSourceBinding(args.sourceBinding);
 return checkedServiceAgentContext(await client.request(serviceAgentContextPath(source)),source);
}
