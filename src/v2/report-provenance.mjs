import {isDeepStrictEqual as same} from 'node:util';
import {publishedReportHash as digest} from './published-report-source.mjs';
import {reportProposalHash} from './report-clarification.mjs';

export const reportProvenanceProtocol = 'shuduo-report-provenance/v1';
const fail = (status=409,code='REPORT_PROVENANCE_CHANGED') => Object.assign(Error(status===404?'此运行尚无已冻结的需求与审阅溯源；不会从当前聊天补造':'报表需求、审阅或固定产物不一致；未重算或切换版本'),{status,code});
const usage = p => ({model:p.model??'UNRECORDED',mode:p.planningMode??'UNRECORDED',usage:p.usage?Object.fromEntries(['prompt_tokens','completion_tokens','total_tokens'].filter(k=>Number.isSafeInteger(p.usage[k])&&p.usage[k]>=0).map(k=>[k,p.usage[k]])):null,estimated:p.usageEstimated??true,unknown:p.usageUnknown??true});

// Called only after the server has checked the exact proposal, owner, creation ledger and ancestry.
export function reviewedReportBasis(plan,actorId,reviewedHash) {
 if(plan.submittedBy!==actorId||plan.proposal?.kind!=='PUBLISHED_REPORT'||reviewedHash!==plan.proposalHash||reportProposalHash(plan,plan.proposal)!==reviewedHash||!['SUCCEEDED','APPLYING','APPLIED'].includes(plan.status))throw fail();
 const c=plan.clarification;
 return {protocol:'shuduo-report-review-basis/v1',planId:plan.id,requestId:plan.requestId,
  originalRequest:c?.originalRequest??plan.message,finalRequest:plan.message,
  clarificationDigest:c?.digest??null,turns:(c?.turns??[]).map(t=>({question:t.question,answer:t.answer,provider:usage(t)})),
  source:plan.sourceBinding,sourceEvidenceHash:plan.sourceEvidenceHash,contextHash:plan.contextHash,
  proposal:structuredClone(plan.proposal),proposalHash:reviewedHash,provider:usage(plan),
  captureMode:plan.status==='APPLIED'?'EXISTING_APPLICATION_RECHECK':'AT_APPLICATION',
  originalAppliedAt:plan.appliedAt??null};
}

export function checkedFixedReportArtifacts({store,project,reportStore,reportId,runId}) {
 const read=(kind,id)=>{const value=store.get(kind,id,project);if(!value||value.projectId!==project)throw fail();return value;};
  const report=read('report',reportId),run=read('report_run',runId),version=read('report_version',run.reportVersionId),snapshot=read('report_snapshot',run.datasetSnapshotId),dataset=read('report_dataset',run.datasetId),data=reportStore.read(snapshot.dataSnapshotId);
  const config={datasetId:version.datasetId,...(version.outputContractId?{outputContractId:version.outputContractId}:{}),datasetSnapshotId:version.datasetSnapshotId,widgets:version.widgets,description:version.description};
  if(run.reportId!==report.id||version.reportId!==report.id||version.datasetId!==dataset.id||run.datasetId!==dataset.id||snapshot.datasetId!==dataset.id||run.reportVersionId!==version.id||run.datasetSnapshotId!==snapshot.id||version.datasetSnapshotId!==snapshot.id||run.status!=='SUCCEEDED'||run.actualExecution!==true||run.publicDeployed!==false||run.fullLifecycleE2E!==false||version.configHash!==digest(config)||run.reportConfigHash!==version.configHash||run.resultHash!==digest(run.widgets)||run.datasetContentHash!==snapshot.contentHash||data.contentHash!==snapshot.contentHash||digest(data.rows)!==snapshot.contentHash||data.rowCount!==snapshot.rowCount||data.rows.length!==snapshot.rowCount||data.assetId!==snapshot.assetId)throw fail();
 return {report,version,run,snapshot,dataset,data};
}

export function checkedPublishedReportArtifacts({store,project,reportStore,record:r}) {
 const artifacts=checkedFixedReportArtifacts({store,project,reportStore,reportId:r.reportId,runId:r.reportRunId});
 const {version,run,snapshot,dataset}=artifacts;
 if(version.id!==r.reportVersionId||snapshot.id!==r.snapshotId||dataset.id!==r.datasetId||snapshot.assetVersionId!==r.input.source.batchId||
    snapshot.assetEvidenceHash!==r.sourceEvidenceHash||!same(dataset.publishedSource,r.input.source)||dataset.sourceActorId!==r.actorId)throw fail();
 if(r.outputContractId&&(run.outputContractId!==r.outputContractId||version.outputContractId!==r.outputContractId||snapshot.outputContractId!==r.outputContractId||run.distributionValidation?.passed!==true))throw fail();
 return artifacts;
}

export function createReportProvenance({store,project,reportStore}) {
 const kind='report_provenance', key=id=>`${project}:report-provenance:v1:${id}`;
 const read=(kind,id)=>{const r=store.get(kind,id,project);if(!r)throw fail();return r;};
 function artifacts(r){
  const {report,version,run,snapshot,dataset}=checkedPublishedReportArtifacts({store,project,reportStore,record:r});
  return {reportId:report.id,reportVersionId:version.id,versionNumber:version.versionNumber,reportRunId:run.id,datasetId:dataset.id,snapshotId:snapshot.id,sourceBatchId:snapshot.assetVersionId,contentHash:snapshot.contentHash,configHash:version.configHash,resultHash:run.resultHash,outputContractId:version.outputContractId??null,rowCount:snapshot.rowCount};
 }
 function verify(record,actorId){
  if(record.actorId!==actorId)throw fail(404,'REPORT_PROVENANCE_NOT_FOUND');
  const e=record.evidence,{digest:claimed,...body}=e,ledger=store.db.prepare('SELECT signature,result_id FROM idempotency WHERE key=?').get(key(e.creationId));
  if(e.protocol!==reportProvenanceProtocol||e.scope!=='LOCAL_TEST_ONLY'||e.agentIndependentE2E!==false||e.publicDeployed!==false||digest(body)!==claimed||ledger?.result_id!==record.id||ledger?.signature!==claimed)throw fail();
  const r=read('published_report_creation',e.creationId);
  if(r.actorId!==actorId||r.status!=='SUCCEEDED'||r.requestId!==e.review.planId||!same(r.reviewBasis,e.review)||!same(e.artifacts,artifacts(r))||!same(e.review.source,r.input.source)||e.review.sourceEvidenceHash!==r.sourceEvidenceHash)throw fail();
  return structuredClone(e);
 }
 return {
  freeze(r){
   if(!r.reviewBasis)return;
   const existing=store.deduplicatedId(key(r.id));if(existing)return verify(read(kind,existing),r.actorId);
   if(r.status!=='SUCCEEDED'||r.requestId!==r.reviewBasis.planId||!same(r.reviewBasis.source,r.input.source)||r.reviewBasis.sourceEvidenceHash!==r.sourceEvidenceHash||r.reviewBasis.proposal.name!==r.input.name||!same(r.reviewBasis.proposal.metricIds,r.input.metricIds))throw fail();
   const body={protocol:reportProvenanceProtocol,scope:'LOCAL_TEST_ONLY',creationId:r.id,capturedAt:new Date().toISOString(),review:r.reviewBasis,artifacts:artifacts(r),agentIndependentE2E:false,publicDeployed:false,integrity:'SHA256_LOCAL_RECORD_NOT_THIRD_PARTY_SIGNATURE'},evidence={...body,digest:digest(body)};
   const d=store.deduplicate(key(r.id),evidence.digest,()=>store.create(kind,project,{actorId:r.actorId,evidence}));return verify(read(kind,d.id),r.actorId);
  },
  read(reportId,runId,actorId){
   const matches=store.list(kind,project).filter(r=>r.actorId===actorId&&r.evidence?.artifacts.reportId===reportId&&r.evidence?.artifacts.reportRunId===runId);
   if(matches.length===0)throw fail(404,'REPORT_PROVENANCE_NOT_FOUND');if(matches.length!==1)throw fail();return verify(matches[0],actorId);
  }
 };
}
