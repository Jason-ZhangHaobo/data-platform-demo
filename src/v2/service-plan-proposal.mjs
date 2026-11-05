import {isDeepStrictEqual as same} from 'node:util';
import {serviceVersionConfigValid} from './data-services.mjs';
const fail=message=>Object.assign(Error(message),{status:409,code:'SERVICE_PLAN_SOURCE_MISMATCH'});
export function bindServicePlanProposal(proposal,context){
 if(proposal.serviceType==='DAPI'){
  if(proposal.sourceReleaseRunId!==context.binding.sourceReleaseRunId)throw fail('Agent方案未引用当前确切发布批次');
  return [];
 }
 const selected=proposal.steps.map(step=>context.resourceVersions.find(ref=>ref.serviceId===step.dapiId&&ref.versionId===step.dapiVersionId));
 if(selected.some(ref=>!ref))throw fail('XAPI方案必须使用当前来源的固定DAPI版本');
 return selected;
}
export function servicePlanDraftMatches(service,proposal,binding){
 const v=service?.currentVersion;
 return Boolean(service&&service.serviceType===proposal.serviceType&&service.name===proposal.name&&service.slug===proposal.slug&&v&&serviceVersionConfigValid(v)&&
  v.timeoutMs===proposal.timeoutMs&&v.rateLimitPerMinute===proposal.rateLimitPerMinute&&
  (proposal.serviceType==='DAPI'?v.sourceReleaseRunId===binding.sourceReleaseRunId&&v.sourceReleaseId===binding.releaseId&&v.sourcePackageDigest===binding.packageDigest&&same(v.fields,proposal.fields):same(v.steps,proposal.steps)));
}
