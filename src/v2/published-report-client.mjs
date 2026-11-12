import {distributionReportTemplate,fundReportContractId} from './distribution-report-contract.mjs';
import {publishedReportInput,publishedReportSource,reportRequestId} from './published-report-request.mjs';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function checkedPublishedReportReceipt(value,{requestId,source,name,metricIds}={}){
 const bad=()=>{throw Error('原报表请求的来源或产物回执尚未确认；保留原编号，不重新创建');};
 if(!value||typeof value!=='object'||Array.isArray(value)||value.protocol!=='shuduo-published-report-creation/v1'||value.scope!=='LOCAL_TEST_ONLY'||!['PREPARING','PARTIAL','SUCCEEDED'].includes(value.status)||value.agentIndependentE2E!==false||value.publicDeployed!==false||typeof value.name!=='string'||!value.name||!hash(value.sourceEvidenceHash))bad();
 try{reportRequestId(value.id);reportRequestId(value.requestId);publishedReportSource(value.source);for(const k of ['datasetId','snapshotId','reportId','reportVersionId','reportRunId'])if(value[k]!==undefined)reportRequestId(value[k]);}catch{bad();}
 if(requestId&&value.requestId!==requestId||name!==undefined&&value.name!==name||source&&JSON.stringify(publishedReportSource(value.source))!==JSON.stringify(publishedReportSource(source)))bad();
 if(metricIds&&JSON.stringify([...metricIds].sort())!==JSON.stringify([...(value.metricIds??[])].sort()))bad();
 if(typeof value.stage!=='string'||!['SOURCE_CONFIRMED','dataset','snapshot','report','reportRun','COMPLETE'].includes(value.stage)||value.status==='PARTIAL'&&(!value.error||typeof value.error.code!=='string'||typeof value.error.message!=='string'))bad();
 if(value.status==='SUCCEEDED'&&(!['datasetId','snapshotId','reportId','reportVersionId','reportRunId'].every(k=>typeof value[k]==='string')||value.stage!=='COMPLETE'||!hash(value.resultHash)||!Number.isSafeInteger(value.rowCount)||value.rowCount<0||!Number.isSafeInteger(value.widgetCount)||value.widgetCount<1||value.widgetCount>8))bad();
 if(value.outputContractId!==undefined){const template=distributionReportTemplate(value.outputContractId);if(!template||!Array.isArray(value.metricIds)||!value.metricIds.length||new Set(value.metricIds).size!==value.metricIds.length||value.metricIds.some(id=>!template.widgets.some(w=>w.id===id))||value.status==='SUCCEEDED'&&value.widgetCount!==value.metricIds.length)bad();}
 return value;
}
export async function submitPublishedReport(client,args){
 const body=publishedReportInput({name:args.name,source:args.source,...(args.metricIds===undefined?{}:{metricIds:args.metricIds})}),requestId=reportRequestId(args.requestId);
 return checkedPublishedReportReceipt(await client.request('/reports/published',{method:'POST',body,idempotencyKey:requestId}),{requestId,source:body.source,name:body.name,metricIds:body.metricIds});
}
export async function lookupPublishedReport(client,args){
 const requestId=reportRequestId(args.requestId);
 return checkedPublishedReportReceipt(await client.request('/reports/published/requests/'+requestId),{requestId,source:args.source,name:args.name});
}
export async function resumePublishedReport(client,args){
 const id=reportRequestId(args.id);
 const value=checkedPublishedReportReceipt(await client.request(`/reports/published/${id}/advance`,{method:'POST',body:{}}),{requestId:args.requestId,source:args.source});
 if(value.id!==id)throw Error('续接回执不是原报表任务，未采用其他结果');return value;
}

export function checkedPublishedReportResult(value, expected) {
 const bad=()=>{throw Error("原报表、版本、快照与运行未能对应，保留原编号");};
 if(!value||value.protocol!=="shuduo-published-report-result/v1")bad();
 const receipt=checkedPublishedReportReceipt(value.receipt,expected), overview=value.overview;
 if(receipt.status!=="SUCCEEDED"||overview?.scope!=="LOCAL_AGGREGATED_REPORTING"||overview.publicDeployed!==false||
    !Array.isArray(overview.datasets)||overview.datasets.length!==1||!Array.isArray(overview.reports)||overview.reports.length!==1)bad();
 const [dataset]=overview.datasets,[report]=overview.reports;
 if(dataset?.id!==receipt.datasetId||report?.id!==receipt.reportId||
    !Array.isArray(dataset.snapshots)||dataset.snapshots.length!==1||!Array.isArray(report.versions)||report.versions.length!==1||
    !Array.isArray(report.runs)||report.runs.length!==1)bad();
 const [snapshot]=dataset.snapshots,[version]=report.versions,[run]=report.runs;
 if(!snapshot||!version||!run||snapshot.id!==receipt.snapshotId||snapshot.datasetId!==dataset.id||
    snapshot.assetVersionId!==receipt.source.batchId||snapshot.assetEvidenceHash!==receipt.sourceEvidenceHash||
    snapshot.rowCount!==receipt.rowCount||!hash(snapshot.contentHash)||version.id!==receipt.reportVersionId||version.reportId!==report.id||
    version.datasetId!==dataset.id||version.datasetSnapshotId!==snapshot.id||!hash(version.configHash)||
    run.id!==receipt.reportRunId||run.reportId!==report.id||run.reportVersionId!==version.id||run.datasetId!==dataset.id||
    run.datasetSnapshotId!==snapshot.id||run.reportConfigHash!==version.configHash||run.datasetContentHash!==snapshot.contentHash||
    run.resultHash!==receipt.resultHash||run.status!=="SUCCEEDED"||run.actualExecution!==true||
    run.fullLifecycleE2E!==false||run.publicDeployed!==false||!Array.isArray(run.widgets)||run.widgets.length!==receipt.widgetCount||
    [dataset,snapshot,version,run].some(item=>item.outputContractId!==receipt.outputContractId)||
    JSON.stringify(publishedReportSource(dataset.publishedSource))!==JSON.stringify(publishedReportSource(receipt.source)))bad();
 return value;
}

export async function readPublishedReportResult(client,args) {
 const requestId=reportRequestId(args.requestId);
 return checkedPublishedReportResult(await client.request('/reports/published/requests/'+requestId+'/result'),{requestId,source:args.source});
}

export function checkedPublishedReportLineage(value, expected={}) {
 const bad=()=>{throw Error("原报表、固定快照和同批次运维证据未能对应");};
 if(!value||value.protocol!=="shuduo-fund-report-lineage/v1"||value.scope!=="LOCAL_TEST_ONLY"||value.publicDeployed!==false)bad();
 const {requestId,source,report,snapshot,release,batch}=value;
 try {
  reportRequestId(requestId);
  for(const id of [report?.id,report?.versionId,report?.runId,snapshot?.id,snapshot?.datasetId,batch?.monitorEvent?.id])reportRequestId(id);
 }catch{bad();}
 const normalized=publishedReportSource(source);
 if(normalized.kind!=="MANUAL"||expected.requestId&&requestId!==expected.requestId||
    expected.source&&JSON.stringify(normalized)!==JSON.stringify(publishedReportSource(expected.source)))bad();
 const event=batch.monitorEvent, dates=[batch.scheduledAt,batch.startedAt,batch.finishedAt,event.observedAt].map(Date.parse);
 if(release?.id!==normalized.releaseId||release.packageDigest!==normalized.packageDigest||batch.id!==normalized.batchId||
    !["ACTIVE_LOCAL","SUPERSEDED_LOCAL","CANCELLED"].includes(release.status)||
    release.activeForConsumption!==(release.status==="ACTIVE_LOCAL")||release.engineClassification!=="LOCAL_SPARK_PROCESS"||
    !/^\d{4}-\d{2}-\d{2}$/.test(release.businessDate)||
    ![1,2].includes(batch.sequence)||batch.status!=="SUCCEEDED"||event.type!=="BATCH_SUCCEEDED"||event.status!=="SUCCEEDED"||
    dates.some((date,index)=>!Number.isFinite(date)||index>0&&date<dates[index-1])||
    ![report.resultHash,snapshot.contentHash,release.resultDigest,release.assertionDigest].every(hash)||
    snapshot.contractId!==fundReportContractId||snapshot.assetId!=="dataset:"+snapshot.contractId||
    !Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<1||snapshot.rowCount>1000||
    !Array.isArray(snapshot.fields)||snapshot.fields.map(field=>field?.name).join(",")!=="portfolio_id,trade_date,asset_class,exposure_amount,exposure_ratio"||
    snapshot.fields.some(field=>typeof field.label!=="string"||!field.label.trim()))bad();
 if(expected.receipt){
  const receipt=checkedPublishedReportReceipt(expected.receipt,{requestId,source:normalized});
  if(receipt.reportId!==report.id||receipt.reportVersionId!==report.versionId||receipt.reportRunId!==report.runId||
     receipt.resultHash!==report.resultHash||receipt.snapshotId!==snapshot.id||receipt.datasetId!==snapshot.datasetId||
     receipt.sourceEvidenceHash!==snapshot.contentHash||receipt.rowCount!==snapshot.rowCount||receipt.outputContractId!==snapshot.contractId)bad();
 }
 return value;
}
export async function readPublishedReportLineage(client,args) {
 const requestId=reportRequestId(args.requestId);
 return checkedPublishedReportLineage(await client.request('/reports/published/requests/'+requestId+'/lineage'),{...args,requestId});
}

export async function checkedPublishedReportDevelopment(value, expected={}) {
 const bad=()=>{throw Error("原开发版本或独立核验与固定报表来源不一致");};
 if(!value||value.protocol!=="shuduo-fund-report-development/v1")bad();
 const lineage=checkedPublishedReportLineage(value.lineage,expected);
 const {revision,run,verification}=value;
 const original=expected.lineage;
 if(original&&(original.report.runId!==lineage.report.runId||original.snapshot.id!==lineage.snapshot.id||
    original.batch.monitorEvent.id!==lineage.batch.monitorEvent.id||original.snapshot.contentHash!==lineage.snapshot.contentHash||
    original.release.resultDigest!==lineage.release.resultDigest||original.release.assertionDigest!==lineage.release.assertionDigest))bad();
 if(revision?.id!==lineage.source.revisionId||revision.source!=="ENGINEER_AUTHORED"||!hash(revision.hash)||
    typeof revision.sql!=="string"||!revision.sql.trim()||revision.sql.length>100000||
    run?.id!==lineage.source.runId||run.revisionId!==revision.id||run.revisionHash!==revision.hash||run.status!=="SUCCEEDED"||
    run.engine!=="Apache Spark"||typeof run.engineVersion!=="string"||!/^\d+\.\d+\.\d+$/.test(run.engineVersion)||
    !Number.isFinite(Date.parse(run.finishedAt))||!Number.isSafeInteger(run.durationMs)||run.durationMs<0||run.rowCount!==lineage.snapshot.rowCount||
    verification?.status!=="PASSED"||verification.assertionDigest!==lineage.release.assertionDigest||
    ![verification.inputDigest,verification.testSqlDigest].every(hash)||verification.verifierRevision!=="fund-lookthrough-v1"||
    !Array.isArray(verification.assertions)||verification.assertions.length!==4||
    new Set(verification.assertions).size!==4||verification.assertions.some(item=>typeof item!=="string"||!item.trim()))bad();
 try{reportRequestId(verification.rehearsalId);}catch{bad();}
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(revision.sql));
 if([...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("")!==revision.hash)bad();
 return value;
}

export async function readPublishedReportDevelopment(client,args) {
 const requestId=reportRequestId(args.requestId);
 return checkedPublishedReportDevelopment(await client.request('/reports/published/requests/'+requestId+'/development'),{...args,requestId});
}
