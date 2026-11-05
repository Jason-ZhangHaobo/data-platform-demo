import {isDeepStrictEqual as same} from 'node:util';
import {localServiceSources} from './local-service-sources.mjs';
import {serviceVersionConfigValid} from './data-services.mjs';
import {getContext,validationFamilyForContext} from './context.mjs';
import {servicePlanSourceBinding} from './service-plan-request.mjs';
export {servicePlanSourceBinding,servicePlanSourceQuery,servicePlanSourcePath} from './service-plan-request.mjs';

const fail=(code,message,status=409)=>Object.assign(Error(message),{status,code});
const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
export function servicePlanVersionRef(service,version){
 return {serviceId:service.id,versionId:version.id,configHash:version.configHash,fields:[...version.fields]};
}
export function resolveServicePlanSource({store,project,binding,actorId,services}){
 binding=servicePlanSourceBinding(binding);
 const agent=store.get('agent',binding.taskId,project);
 if(!agent||agent.submittedBy!=='local-engineer'&&agent.submittedBy!==actorId)throw fail('SERVICE_PLAN_SOURCE_OWNER','规划来源不属于当前本机开发者',403);
 const runs=localServiceSources({store,project,selection:{taskId:binding.taskId,packageDigest:binding.packageDigest,releaseId:binding.releaseId}}),
  run=runs.find(value=>value.id===binding.sourceReleaseRunId);
 if(!run)throw fail('SERVICE_PLAN_SOURCE_UNAVAILABLE','原任务的确切发布批次尚未通过完整核验，不能改用其他来源');
 const published=[];
 for(const service of services){
  const version=service.publishedVersion;
  if(service.serviceType!=='DAPI'||service.status!=='PUBLISHED'||!version||version.sourceReleaseRunId!==run.id||
   version.sourceReleaseId!==binding.releaseId||version.sourcePackageDigest!==binding.packageDigest||version.scope!=='LOCAL_TEST_ONLY'||
   !serviceVersionConfigValid(version)||!Array.isArray(version.fields)||version.fields.length===0||version.fields.some(field=>!fields.includes(field)))continue;
  published.push({id:service.id,name:service.name,slug:service.slug,serviceType:'DAPI',status:'PUBLISHED',
   publishedVersion:{id:version.id,configHash:version.configHash,fields:[...version.fields]}});
 }
 const bounded=published.sort((a,b)=>a.id.localeCompare(b.id)).slice(0,100);
 const context=getContext(agent.contextId),family=validationFamilyForContext(agent.contextId);
 return {binding,sourceContext:{id:context.id,name:context.name,definition:context.definition,validationContractId:family.id,metricLabels:family.metricLabels},
  releaseRuns:[run],services:bounded,resourceVersions:bounded.map(service=>servicePlanVersionRef(service,service.publishedVersion)),resourcesTruncated:published.length>100};
}
export function assertServicePlanVersions({store,project,binding,refs,current=false}){
 if(!Array.isArray(refs)||refs.length>100||new Set(refs.map(ref=>ref?.serviceId)).size!==refs.length)throw fail('SERVICE_PLAN_VERSION_CHANGED','方案固定版本记录不完整');
 for(const ref of refs){
  const service=store.get('data_service',ref?.serviceId,project),version=store.get('data_service_version',ref?.versionId,project);
  if(!service||service.serviceType!=='DAPI'||!version||version.serviceId!==service.id||version.serviceType!=='DAPI'||!serviceVersionConfigValid(version)||
   version.scope!=='LOCAL_TEST_ONLY'||version.sourceReleaseRunId!==binding.sourceReleaseRunId||version.sourceReleaseId!==binding.releaseId||version.sourcePackageDigest!==binding.packageDigest||
   version.configHash!==ref.configHash||!same(version.fields,ref.fields)||current&&(service.status!=='PUBLISHED'||service.publishedVersionId!==ref.versionId))
   throw fail('SERVICE_PLAN_VERSION_CHANGED','方案中的DAPI版本或来源已变化，请核对原方案；未切换到最新版本');
 }
}
export function bindServicePlanProposal(proposal,context){
 if(proposal.serviceType==='DAPI'){
  if(proposal.sourceReleaseRunId!==context.binding.sourceReleaseRunId)throw fail('SERVICE_PLAN_SOURCE_MISMATCH','Agent方案未引用当前确切发布批次');
  return [];
 }
 const selected=proposal.steps.map(step=>context.resourceVersions.find(ref=>ref.serviceId===step.dapiId&&ref.versionId===step.dapiVersionId));
 if(selected.some(ref=>!ref))throw fail('SERVICE_PLAN_SOURCE_MISMATCH','XAPI方案必须使用当前来源的固定DAPI版本');
 return selected;
}
export function servicePlanDraftMatches(service,proposal,binding){
 const v=service?.currentVersion;
 return Boolean(service&&service.serviceType===proposal.serviceType&&service.name===proposal.name&&service.slug===proposal.slug&&v&&serviceVersionConfigValid(v)&&
  v.timeoutMs===proposal.timeoutMs&&v.rateLimitPerMinute===proposal.rateLimitPerMinute&&
  (proposal.serviceType==='DAPI'?v.sourceReleaseRunId===binding.sourceReleaseRunId&&v.sourceReleaseId===binding.releaseId&&v.sourcePackageDigest===binding.packageDigest&&same(v.fields,proposal.fields):same(v.steps,proposal.steps)));
}
export function publicServicePlan(plan){const {submittedBy,...visible}=plan;return visible;}
