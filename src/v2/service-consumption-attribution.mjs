import {isDeepStrictEqual as same} from 'node:util';
import {consumerCanonical,consumerDigest,consumerParametersDigest} from './consumer-source.mjs';
import {privateServiceAgentMode} from './private-service-agent-policy.mjs';
import {storedAgentConsumptionCall} from './agent-consumption-wake.mjs';

const protocol='shuduo-service-call-attribution/v1';
const hash=value=>consumerDigest(consumerCanonical(value));
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const id=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hasOnly=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const invalid=()=>Object.assign(Error('原授权调用来源或凭证签发记录不一致'),{status:409,code:'SERVICE_CALL_ATTRIBUTION_MISMATCH'});

function reviewedServiceDesign(store,project,version,source) {
  const plans=store.list('service_agent_plan',project).filter(plan=>plan.appliedVersionId===version.id);
  if (!plans.length) return {kind:'UNRECORDED'};
  const [plan]=plans, sourceBinding={...(source.taskId?{taskId:source.taskId}:{manualDeliveryTaskId:source.manualDeliveryTaskId}),
    packageDigest:source.packageDigest,releaseId:source.releaseId,sourceReleaseRunId:source.sourceReleaseRunId};
  const expectedApply=hash({actorId:plan.submittedBy,sourceBinding,proposalHash:plan.proposalHash});
  if(plans.length!==1||plan.executionMode!==privateServiceAgentMode||plan.status!=='APPLIED'||plan.sourceKind!==source.sourceKind||
     plan.serviceId!==version.serviceId||plan.appliedConfigHash!==version.configHash||!same(plan.sourceBinding,sourceBinding)||
     !id(plan.requestId)||typeof plan.message!=='string'||!plan.proposal||!digest(plan.proposalHash)||hash(plan.proposal)!==plan.proposalHash||
     store.deduplicatedId(`${project}:private-service-agent-plan:${plan.submittedBy}:${plan.requestId}`,hash({message:plan.message,sourceBinding}))!==plan.id||
     store.deduplicatedId(`${project}:private-service-agent-apply:${plan.id}`,expectedApply)!==version.serviceId) throw invalid();
  return {kind:'REVIEWED_AGENT_PLAN',requestDigest:consumerDigest(plan.requestId),proposalDigest:plan.proposalHash};
}

export function storedServiceCallAttribution({store,project,call,version,source}) {
  const invocation=call.invocationEvidence,app=store.get('service_app',call.applicationId,project);
  const issuance=app?.issuanceEvidence;
  if ((!invocation?.issuanceDigest && !issuance) || !source) return;
  if (!invocation || !issuance || app.scope!==source.scope || call.serviceVersionId!==version.id || call.serviceId!==version.serviceId ||
      !call.parameters || invocation.parametersDigest!==consumerParametersDigest(call.parameters) || invocation.issuanceDigest!==hash(issuance)) throw invalid();
  const value={protocol,channel:invocation.channel,queryDigest:invocation.queryDigest,
    issuanceMode:issuance.mode,issuanceRequestDigest:issuance.requestDigest,credentialProofDigest:issuance.credentialProofDigest,
    serviceDesign:reviewedServiceDesign(store,project,version,source)};
  if(invocation.channel==='SIGNED_AGENT_CONSUMPTION'){
    const delegation=invocation.delegation,wake=typeof delegation?.wakeId==='string'&&store.get('agent_consumption_wake',delegation.wakeId,project);
    const binding=wake?.binding,selected=binding?.sourceBinding;
    if(!binding||!selected||binding.actorId!==app.createdBy||selected.taskId!==source.taskId||selected.releaseId!==source.releaseId||
      selected.packageDigest!==source.packageDigest||selected.sourceReleaseRunId!==source.sourceReleaseRunId||
      storedAgentConsumptionCall(store,project,binding,wake.id,call.serviceType)?.id!==call.id)throw invalid();
    value.delegation={wakeId:wake.id,requestDigest:consumerDigest(binding.requestId)};
  }
  if (!validServiceCallAttribution(value)) throw invalid();
  return value;
}

export function validServiceCallAttribution(value) {
  const delegated=value?.channel==='SIGNED_AGENT_CONSUMPTION';
  if(!hasOnly(value,['protocol','channel','queryDigest','issuanceMode','issuanceRequestDigest','credentialProofDigest','serviceDesign',...(delegated?['delegation']:[])])||
     value.protocol!==protocol||!['BEARER_HTTP','BEARER_PRIVATE_BRIDGE','SIGNED_AGENT_CONSUMPTION'].includes(value.channel)||
     delegated&&(!hasOnly(value.delegation,['wakeId','requestDigest'])||!id(value.delegation.wakeId)||!digest(value.delegation.requestDigest))||
     value.issuanceMode!=='AUTHENTICATED_SESSION'||![value.queryDigest,value.issuanceRequestDigest,value.credentialProofDigest].every(digest))return false;
  const design=value.serviceDesign;
  return design?.kind==='UNRECORDED'?hasOnly(design,['kind']):hasOnly(design,['kind','requestDigest','proposalDigest'])&&
    design.kind==='REVIEWED_AGENT_PLAN'&&digest(design.requestDigest)&&digest(design.proposalDigest);
}

export function validBatchConsumptionAttribution(value,proof) {
  if (!hasOnly(value,['batchId','dapi','xapi'])||value.batchId!==proof.batchId) return false;
  return ['dapi','xapi'].every(kind=>hasOnly(value[kind],['callIdDigest','evidence'])&&digest(value[kind].callIdDigest)&&value[kind].callIdDigest===proof[`${kind}CallIdDigest`]&&
    validServiceCallAttribution(value[kind].evidence)) &&
    value.dapi.evidence.issuanceRequestDigest===value.xapi.evidence.issuanceRequestDigest &&
    value.dapi.evidence.credentialProofDigest===value.xapi.evidence.credentialProofDigest;
}
