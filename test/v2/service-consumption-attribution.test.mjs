import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {serviceHash} from '../../src/v2/data-services.mjs';
import {consumerDigest,consumerParametersDigest,consumerWireQueryDigest} from '../../src/v2/consumer-source.mjs';
import {privateServiceAgentMode} from '../../src/v2/private-service-agent-policy.mjs';
import {storedServiceCallAttribution} from '../../src/v2/service-consumption-attribution.mjs';

test('same-source reviewed service design is resolved from the original plan and apply ledgers', t=>{
  const store=new MetadataStore(':memory:'),project='fictional';
  t.after(()=>store.close());
  const sourceBinding={taskId:randomUUID(),releaseId:randomUUID(),sourceReleaseRunId:randomUUID(),packageDigest:'a'.repeat(64)};
  const version={id:randomUUID(),serviceId:randomUUID(),configHash:'b'.repeat(64)};
  const submittedBy=randomUUID(),requestId=randomUUID(),message='为虚构客户资产批次设计只读查询';
  const proposal={serviceType:'DAPI',sourceReleaseRunId:sourceBinding.sourceReleaseRunId};
  const proposalHash=serviceHash(proposal);
  const {id:planId}=store.deduplicate(`${project}:private-service-agent-plan:${submittedBy}:${requestId}`,
    serviceHash({message,sourceBinding}),()=>store.create('service_agent_plan',project,{executionMode:privateServiceAgentMode,
      status:'APPLIED',sourceKind:'AGENT',sourceBinding,submittedBy,requestId,message,proposal,proposalHash,
      serviceId:version.serviceId,appliedVersionId:version.id,appliedConfigHash:version.configHash}));
  store.deduplicate(`${project}:private-service-agent-apply:${planId}`,serviceHash({actorId:submittedBy,sourceBinding,proposalHash}),()=>({id:version.serviceId}));
  const issuanceEvidence={mode:'AUTHENTICATED_SESSION',requestDigest:'c'.repeat(64),credentialProofDigest:'d'.repeat(64)};
  const app=store.create('service_app',project,{scope:'PRIVATE_CLOUD_TEST',issuanceEvidence});
  const call={serviceId:version.serviceId,serviceVersionId:version.id,applicationId:app.id,parameters:{page:1,pageSize:2},
    invocationEvidence:{channel:'BEARER_HTTP',queryDigest:consumerWireQueryDigest({page:'1',page_size:'2'}),
      parametersDigest:consumerParametersDigest({page:1,pageSize:2}),issuanceDigest:serviceHash(issuanceEvidence)}};
  const input={store,project,call,version,source:{...sourceBinding,scope:'PRIVATE_CLOUD_TEST',sourceKind:'AGENT'}};
  assert.deepEqual(storedServiceCallAttribution(input).serviceDesign,{kind:'REVIEWED_AGENT_PLAN',requestDigest:consumerDigest(requestId),proposalDigest:proposalHash});
  assert.throws(()=>storedServiceCallAttribution({...input,source:{...input.source,sourceReleaseRunId:randomUUID()}}),{code:'SERVICE_CALL_ATTRIBUTION_MISMATCH'});
  assert.throws(()=>storedServiceCallAttribution({...input,call:{...call,parameters:{page:2,pageSize:2}}}),{code:'SERVICE_CALL_ATTRIBUTION_MISMATCH'});
  store.update('service_app',app.id,project,{issuanceEvidence:{...issuanceEvidence,requestDigest:'e'.repeat(64)}});
  assert.throws(()=>storedServiceCallAttribution(input),{code:'SERVICE_CALL_ATTRIBUTION_MISMATCH'});
});
