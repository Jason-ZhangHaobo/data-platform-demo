import {isDeepStrictEqual as same} from 'node:util';
import {uuid} from './live-lifecycle-checkpoint.mjs';
import {consumerCanonical,consumerDigest,consumerWireQueryDigest,validateConsumerSource} from './consumer-source.mjs';
import {agentConsumptionQuery} from './agent-consumption-request.mjs';
import {independentConsumerResponse} from './external-consumption-binding.mjs';
import {validServiceCallAttribution,validBatchConsumptionAttribution} from './service-consumption-attribution.mjs';

const id=value=>typeof value==='string'&&uuid.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const hash=value=>consumerDigest(consumerCanonical(value));
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const kinds=['dapi','xapi'];
const jobProtocol='shuduo-agent-consumption-wake/v1';

export function agentConsumptionPair(job,requestId,source,plan,external,externalEntries) {
  if(!exact(job,['protocol','requestId','wakeId','state','sourceBinding','applicationId','dapiVersionId','xapiVersionId','calls','agentInitiated','externalSystemVerified'])||
    job.protocol!==jobProtocol||job.state!=='COMPLETED'||job.agentInitiated!==true||job.externalSystemVerified!==false||job.requestId!==requestId||
    ![requestId,job.wakeId,job.applicationId].every(id)||!Array.isArray(job.calls)||job.calls.length!==2||
    !same(job.sourceBinding,{taskId:source.taskId,packageDigest:source.packageDigest,releaseId:source.releaseId,sourceReleaseRunId:source.sourceReleaseRunId})||
    !validBatchConsumptionAttribution(external.attribution,external))return;
  const proof={requestId,wakeId:job.wakeId,batchId:source.sourceReleaseRunId,sourceDigest:external.sourceDigest,applicationId:job.applicationId};
  for(const [index,kind] of kinds.entries()) {
    const type=kind.toUpperCase(),call=job.calls[index],entry=externalEntries[kind];
    const service=kind==='xapi'?plan.xapi:plan.dapis.find(item=>item.granted&&item.id===entry.serviceId);
    if(!service||entry.call.applicationId!==job.applicationId||service.id!==entry.serviceId||service.versionId!==entry.versionId||
      job[`${kind}VersionId`]!==service.versionId||
      !exact(call,['type','serviceId','versionId','callIdDigest','rowsDigest','paginationDigest','rowCount'])||
      call.type!==type||call.serviceId!==service.id||call.versionId!==service.versionId||!digest(call.callIdDigest))return;
    const expected=independentConsumerResponse(plan,{...service,type},{page:Number(agentConsumptionQuery.page),page_size:Number(agentConsumptionQuery.page_size)});
    if(call.rowCount!==expected.data.length||call.rowsDigest!==hash(expected.data)||call.paginationDigest!==hash(expected.pagination))return;
    proof[kind]={serviceId:call.serviceId,versionId:call.versionId,callIdDigest:call.callIdDigest,rowsDigest:call.rowsDigest,
      paginationDigest:call.paginationDigest,rowCount:call.rowCount};
  }
  return validStoredAgentConsumption(proof,external)?proof:undefined;
}

export function verifyAgentConsumptionCall(evidence,kind,agent,externalEntry,externalProof,source) {
  const [entry]=Array.isArray(evidence?.services)?evidence.services:[],call=entry?.call,proof=agent[kind],attribution=call?.attribution;
  if(evidence?.protocol!=='shuduo-private-task-consumption/v1'||evidence.scope!==source.scope||evidence.taskId!==source.taskId||
    evidence.releaseId!==source.releaseId||evidence.packageDigest!==source.packageDigest||evidence.matchingCount!==1||evidence.truncated!==false||
    !Array.isArray(evidence.services)||evidence.services.length!==1||evidence.sourceKind!=='AGENT'||entry?.status!=='VERIFIED'||entry.serviceType!==kind.toUpperCase()||
    entry.serviceId!==proof.serviceId||entry.versionId!==proof.versionId||entry.releaseId!==source.releaseId||
    !same(entry.sourceRunIds,[source.sourceReleaseRunId])||entry.configHash!==externalEntry.configHash||
    !same(entry.sourceVersions,externalEntry.sourceVersions)||
    !validServiceCallAttribution(attribution)||attribution.channel!=='SIGNED_AGENT_CONSUMPTION'||
    attribution.delegation.wakeId!==agent.wakeId||attribution.delegation.requestDigest!==consumerDigest(agent.requestId)||
    attribution.queryDigest!==consumerWireQueryDigest(agentConsumptionQuery)||
    attribution.credentialProofDigest!==externalProof.attribution[kind].evidence.credentialProofDigest||
    attribution.issuanceRequestDigest!==externalProof.attribution[kind].evidence.issuanceRequestDigest||
    call.verified!==true||!id(call.callId)||consumerDigest(call.callId)!==proof.callIdDigest||call.configHash!==entry.configHash||
    call.versionId!==proof.versionId||call.applicationId!==agent.applicationId||call.applicationStatus!==externalEntry.call.applicationStatus||
    call.rowCount!==proof.rowCount||call.resultHash!==proof.rowsDigest)return false;
  try{return same(validateConsumerSource(entry.source),source);}catch{return false;}
}

export function validStoredAgentConsumption(agent,external) {
  return exact(agent,['requestId','wakeId','batchId','sourceDigest','applicationId','dapi','xapi'])&&
    [agent.requestId,agent.wakeId,agent.batchId,agent.applicationId].every(id)&&agent.batchId===external.batchId&&
    digest(agent.sourceDigest)&&agent.sourceDigest===external.sourceDigest&&['MATCHED','MATCHED_ONLY'].includes(external.status)&&
    validBatchConsumptionAttribution(external.attribution,external)&&
    kinds.every(kind=>external.attribution[kind].evidence.channel==='BEARER_HTTP'&&
      exact(agent[kind],['serviceId','versionId','callIdDigest','rowsDigest','paginationDigest','rowCount'])&&
      [agent[kind].serviceId,agent[kind].versionId].every(id)&&
      [agent[kind].callIdDigest,agent[kind].rowsDigest,agent[kind].paginationDigest].every(digest)&&
      Number.isSafeInteger(agent[kind].rowCount)&&agent[kind].rowCount>0&&agent[kind].rowCount<=100)&&
    new Set([agent.dapi.callIdDigest,agent.xapi.callIdDigest,external.dapiCallIdDigest,external.xapiCallIdDigest]).size===4&&
    agent.dapi.serviceId!==agent.xapi.serviceId&&agent.dapi.versionId!==agent.xapi.versionId;
}

export function storedAgentConsumptionProofs(item) {
  const batches=item.actions?.publication?.batchIds, records=Object.entries(item.consumption??{});
  const withAgent=records.filter(([,proof])=>proof?.agent!==undefined);
  if(!withAgent.length)return [];
  if(!Array.isArray(batches)||batches.length!==2||new Set(batches).size!==2||!batches.every(id)||
    !withAgent.every(([batchId,proof])=>batches.includes(batchId)&&proof.batchId===batchId&&validStoredAgentConsumption(proof.agent,proof)))return;
  const agent=batches.flatMap(batchId=>item.consumption[batchId]?.agent??[]);
  const callDigests=[...records.flatMap(([,proof])=>[proof?.dapiCallIdDigest,proof?.xapiCallIdDigest]).filter(digest),
    ...agent.flatMap(proof=>[proof.dapi.callIdDigest,proof.xapi.callIdDigest])];
  const jobIds=agent.flatMap(proof=>[proof.wakeId,proof.requestId]);
  if(new Set(callDigests).size!==callDigests.length||new Set(jobIds).size!==jobIds.length)return;
  return agent;
}
