import {isDeepStrictEqual as same} from 'node:util';
import {validateDeliveryPackage,sha256} from './delivery.mjs';
import {assertDistributionRelease} from './distribution-publication.mjs';
import {assertSqlRequirementPackageSource} from './sql-requirements.mjs';
import {verifyOutputRows,outputContractForContext} from './output-contracts.mjs';
import {getContext} from './context.mjs';
const fail=(reason='SOURCE_UNCONFIRMED')=>Object.assign(Error('分布服务来源未确认：'+reason),{status:409,code:'DISTRIBUTION_SERVICE_SOURCE_UNPROVEN'});
export function certifiedDistributionSource({store,project,run}){
 const get=(kind,id)=>{const value=typeof id==='string'?store.get(kind,id,project):undefined;return value?.projectId===project?value:undefined;};
 const release=get('release',run?.releaseId),bundle=get('delivery_package',run?.packageId??release?.packageId);
 if(!bundle?.manifest?.source?.outputContract)return undefined;
 const source=bundle.manifest.source,c=outputContractForContext(source.contextId),plan=validateDeliveryPackage(bundle,bundle.digest),approval=get('release_approval',release?.approvalId),verification=get('delivery_verification',approval?.rehearsalId),review=get('delivery_review',approval?.reviewId);
 if(!c||!plan||!release||release.projectId!==project||release.status!=='ACTIVE_LOCAL'||release.health!=='HEALTHY'||release.publicDeployed!==false||release.packageId!==bundle.id||release.packageDigest!==bundle.digest||approval?.consumedByReleaseId!==release.id||!same(release.outputContract,source.outputContract))throw fail('RELEASE_BINDING');
 assertDistributionRelease({bundle,verification,review,approval,spec:release.scheduleSpec,local:true,schedulerMode:'LOCAL_TIMER'});
 const development=get('run',source.runId),revision=get('revision',source.revisionId),agent=get('agent',source.requirement?.taskId??development?.agentTaskId);
 assertSqlRequirementPackageSource(bundle,{agent,run:development,revision});
 if(!development||development.revisionHash!==source.sqlHash||revision?.hash!==source.sqlHash||!verifyOutputRows(development.rows,getContext(source.contextId)))throw fail('DEVELOPMENT_BINDING');
 const candidates=store.list('release_run',project).filter(r=>r.releaseId===release.id&&(!release.currentRollbackId||r.rollbackId===release.currentRollbackId));
 const hashes=Object.fromEntries(Object.entries(bundle.manifest.files).map(([name,value])=>[name,value.sha256]));
 if(candidates.length!==2||new Set(candidates.map(r=>r.sequence)).size!==2||!candidates.some(r=>r.id===run?.id))throw fail('BATCH_COUNT');
 for(const r of candidates){
  const checks={project:r.projectId===project,package:r.packageId===bundle.id&&r.packageDigest===bundle.digest,
   status:[1,2].includes(r.sequence)&&r.status==='SUCCEEDED',engine:r.engine==='Apache Spark'&&r.mainSqlExecuted===true&&r.testDouble!==true,
   scope:r.published===true&&r.publicDeployed===false&&r.schedulerTriggered===true&&r.clockMode==='WALL_CLOCK_TIMER'&&r.mode==='LOCAL_SCHEDULED_RELEASE',
   version:r.engineVersion===plan.deployment.runtime.version,validation:r.validation?.passed===true,
   tests:r.testSqlValidation?.passed===true&&r.testSqlValidation.sqlHash===sha256(bundle.files['tests.sql']),
   files:same(r.fileHashes,hashes),source:same(r.source,source),rows:verifyOutputRows(r.rows,getContext(source.contextId)),
   regressions:plan.fixtures.validationContexts.every(ctx=>r.validation?.regressions?.some(v=>v.contextId===ctx.id&&v.passed))};
  const missing=Object.entries(checks).filter(([,ok])=>!ok).map(([key])=>key);if(missing.length)throw fail('BATCH_'+missing.join('_').toUpperCase());
 }
 if(release.currentRollbackId&&get('release_rollback',release.currentRollbackId)?.status!=='VERIFIED')throw fail('ROLLBACK_STATE');
 const events=store.list('monitor_event',project),time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
 for(const r of candidates){if(!time(r.scheduledTriggerAt)||!time(r.triggeredAt)||!time(r.startedAt)||!time(r.finishedAt)||Date.parse(r.triggeredAt)<Date.parse(r.scheduledTriggerAt)||Date.parse(r.finishedAt)<Date.parse(r.startedAt)||!events.some(e=>e.releaseId===release.id&&e.releaseRunId===r.id&&e.packageDigest===bundle.digest&&e.type==='BATCH_SUCCEEDED'&&e.status==='SUCCEEDED'))throw fail('MONITORING_TIMESTAMPS');}
 const model=agent?.attempts?.at(-1)?.model,synthetic=typeof model==='string'&&/synthetic|fixture|test.?double|mock|stub/i.test(model);
 return {outputContractId:c.id,outputContract:c,sourceEvidence:{protocol:'shuduo-distribution-consumption-source/v1',scope:'LOCAL_TEST_ONLY',releaseId:release.id,packageDigest:bundle.digest,sourceTaskId:agent?.id??null,sourceRevisionId:source.revisionId,sourceRunId:source.runId,sourceReleaseRunId:run.id,outputContractId:c.id,metadataHash:source.outputContract.metadataHash,upstreamKind:source.attribution?.kind??'AGENT',modelClassification:synthetic?'SYNTHETIC_UPSTREAM':model?'MODEL_NAME_RECORDED':'NOT_USED',model:model??null,engineClassification:run.executionEvidenceMode==='TEST_HARNESS'?'TEST_HARNESS':'LOCAL_SPARK_RECEIPTS',agentIndependentE2E:false}};
}
export function distributionServiceSources({store,project,selection={}}){
 const rows=[];
 for(const run of store.list('release_run',project)){
  if(selection.releaseId&&run.releaseId!==selection.releaseId||selection.packageDigest&&run.packageDigest!==selection.packageDigest)continue;
  try{const proof=certifiedDistributionSource({store,project,run});if(!proof||selection.taskId&&proof.sourceEvidence.sourceTaskId!==selection.taskId)continue;
   rows.push({id:run.id,releaseId:run.releaseId,sourceAgentTaskId:proof.sourceEvidence.sourceTaskId,sourceRevisionId:proof.sourceEvidence.sourceRevisionId,sourceRunId:proof.sourceEvidence.sourceRunId,packageDigest:run.packageDigest,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',agentIndependentE2E:false,publicDeployed:false,status:'SUCCEEDED',published:true,schedulerTriggered:true,clockMode:'WALL_CLOCK_TIMER',sequence:run.sequence,engine:run.engine,engineVersion:run.engineVersion,mainSqlExecuted:true,validation:{passed:true},testSqlValidation:{passed:true},rowCount:run.rows.length,createdAt:run.createdAt,outputContractId:proof.outputContractId,outputContract:proof.outputContract,sourceEvidence:proof.sourceEvidence});
  }catch(e){if(![409,422].includes(e.status))throw e;}
 }
 return rows.sort((a,b)=>a.releaseId.localeCompare(b.releaseId)||a.sequence-b.sequence);
}
