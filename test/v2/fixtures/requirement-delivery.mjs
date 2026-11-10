import {getContext,validationFamilyForContext,referenceSqlForContext} from '../../../src/v2/context.mjs';
import {sha256,createDeliveryPackage} from '../../../src/v2/delivery.mjs';
import {sqlRequirementReport,bindSqlRequirementRevision,sqlRequirementBinding} from '../../../src/v2/sql-requirements.mjs';
import {syntheticSqlRequirement} from './sql-requirement.mjs';
// All provider/Worker receipts here are synthetic, including live-shaped model
// names needed to exercise publication guards. Never count as actual acceptance.
export function requirementDeliverySource(store,project,{contextId='stock-cash-t1',assisted=false,isolation='FUNCTION_PROCESS',message='【合成回执验收】按登记证券口径计算客户日资产'}={}){
 const actor='synthetic-owner',context=getContext(contextId),family=validationFamilyForContext(contextId),sql=referenceSqlForContext(contextId);
 let revision=store.create('revision',project,{contextId,sql,hash:sha256(sql),source:'LIVE_MODEL',author:actor});
 let agent=store.create('agent',project,{contextId,message,language:'SPARK_SQL',mode:'LIVE_MODEL',
  executionMode:'DURABLE_SQL_AGENT_V1',executionEvidenceMode:'TEST_HARNESS',submittedBy:actor,status:'SUCCEEDED',stage:'SUCCEEDED',sql,revisionId:revision.id,validationContractId:family.id,attempts:[]});
 const validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};
 const run=store.create('run',project,{contextId,agentTaskId:agent.id,revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
  mainSqlExecuted:true,isolation,executionEvidenceMode:'TEST_HARNESS',validationContractId:family.id,validation,rows:context.expected});
 agent=store.update('agent',agent.id,project,{runId:run.id,attempts:[{attempt:1,model:'qwen3.7-plus',status:'SUCCEEDED',revisionId:revision.id,runId:run.id}]});
 const generated={model:'qwen3.7-plus',...syntheticSqlRequirement({message:agent.message,context})};
 const requirements=bindSqlRequirementRevision(sqlRequirementReport({task:agent,message:agent.message,context,generated,attempt:1}),revision);
 revision=store.update('revision',revision.id,project,{requirementBinding:sqlRequirementBinding(requirements)});
 agent=store.update('agent',agent.id,project,{requirements});
 if(assisted){
  const attribution={kind:'ENGINEER_ASSISTED',originAgentTaskId:agent.id,actorId:actor,sourceRunId:run.id,agentIndependentE2E:false};
  for(const [kind,item] of [['agent',agent],['revision',revision],['run',run]])store.update(kind,item.id,project,{sourceKind:'MANUAL',sourceAttribution:attribution,agentIndependentE2E:false});
  agent=store.get('agent',agent.id,project);revision=store.get('revision',revision.id,project);
 }
 return {agent,run:store.get('run',run.id,project),revision,actor,family,validation};
}
export async function requirementPublicationFixture({store,project,artifactStore,contextId}){
 const f=requirementDeliverySource(store,project,{contextId});
 const bundle=createDeliveryPackage(f),artifact=await artifactStore.put('delivery-package',bundle.digest,bundle);
 const item=store.create('delivery_package',project,{...bundle,artifact,sourceRunId:f.run.id});
 const verification=store.create('delivery_verification',project,{packageId:item.id,packageDigest:item.digest,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
  mainSqlExecuted:true,testSqlValidation:{passed:true,sqlHash:sha256(item.files['tests.sql'])},validation:f.validation});
 const delivery=store.create('agent_delivery_task',project,{mode:'DURABLE_AGENT_DELIVERY_V1',sourceAgentTaskId:f.agent.id,sourceRunId:f.run.id,sourceRevisionId:f.revision.id,
  sourceSqlHash:f.revision.hash,sourceRequirementBinding:item.manifest.source.requirement,status:'SUCCEEDED',stage:'AWAITING_ENGINEER_REVIEW',actualExecution:true,
  packageId:item.id,packageDigest:item.digest,verificationId:verification.id});
 return {...f,bundle,item,verification,delivery};
}
