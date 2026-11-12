import {distributionReportTemplate,fundReportContractId} from './distribution-report-contract.mjs';
import {publishedReportInput,publishedReportSource,reportRequestId} from './published-report-request.mjs';
import {sqlValueLineageShapeValid} from './sql-value-lineage-view.mjs';
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
 const {requestId,source,report,snapshot,release,batch,columnLineage}=value;
 try {
  reportRequestId(requestId);
  for(const id of [report?.id,report?.versionId,report?.runId,snapshot?.id,snapshot?.datasetId,batch?.monitorEvent?.id])reportRequestId(id);
 }catch{bad();}
 const normalized=publishedReportSource(source);
 if(expected.requestId&&requestId!==expected.requestId||
    expected.source&&JSON.stringify(normalized)!==JSON.stringify(publishedReportSource(expected.source)))bad();
 const event=batch.monitorEvent, dates=[batch.scheduledAt,batch.startedAt,batch.finishedAt,event.observedAt].map(Date.parse);
 if(release?.id!==normalized.releaseId||release.packageDigest!==normalized.packageDigest||batch.id!==normalized.batchId||
    !["ACTIVE_LOCAL","SUPERSEDED_LOCAL","CANCELLED"].includes(release.status)||
    release.activeForConsumption!==(release.status==="ACTIVE_LOCAL")||release.engineClassification!=="LOCAL_SPARK_PROCESS"||
    (normalized.kind==="AGENT"&&(release.upstreamKind!=="FUND_AGENT_GENERATED"||!["LIVE_MODEL","SYNTHETIC_MODEL"].includes(release.modelMode)))||
    !/^\d{4}-\d{2}-\d{2}$/.test(release.businessDate)||
    ![1,2].includes(batch.sequence)||batch.status!=="SUCCEEDED"||event.type!=="BATCH_SUCCEEDED"||event.status!=="SUCCEEDED"||
    dates.some((date,index)=>!Number.isFinite(date)||index>0&&date<dates[index-1])||
    ![report.resultHash,snapshot.contentHash,release.resultDigest,release.assertionDigest].every(hash)||
    snapshot.contractId!==fundReportContractId||snapshot.assetId!=="dataset:"+snapshot.contractId||
    !Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<1||snapshot.rowCount>1000||
    !Array.isArray(snapshot.fields)||snapshot.fields.map(field=>field?.name).join(",")!=="portfolio_id,trade_date,asset_class,exposure_amount,exposure_ratio"||
    snapshot.fields.some(field=>typeof field.label!=="string"||!field.label.trim()))bad();
 if(columnLineage!==undefined&&(!sqlValueLineageShapeValid(columnLineage,snapshot.fields)||!hash(release.sourceSqlHash)||
    columnLineage.assetId!==snapshot.assetId||columnLineage.runId!==batch.id||
    (columnLineage.status==='UNAVAILABLE' ? columnLineage.conditionReferences!==undefined||columnLineage.revisionId!==undefined||columnLineage.sourceSqlHash!==undefined :
      columnLineage.revisionId!==normalized.revisionId||columnLineage.sourceSqlHash!==release.sourceSqlHash)))bad();
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

export async function checkedSyncReportLineage(value, expected={}) {
 const bad=()=>{throw Error("冻结持仓报表、原批次或授权回执未能对应");};
 if(value?.protocol!=="shuduo-sync-sql-report-lineage/v1"||value.scope!=="LOCAL_TEST_ONLY"||
    value.publicDeployed!==false||value.agentIndependentE2E!==false)bad();
 const {requestId,source,report,snapshot,release,batch,calls,digest,...rest}=value;
 const normalized=publishedReportSource(source);
 try{
  for(const id of [requestId,report.id,report.versionId,report.runId,snapshot.id,snapshot.datasetId,release.syncRunId,release.metadataVersionId,release.approvalId])
   reportRequestId(id);
 }catch{bad();}
 if(expected.requestId&&expected.requestId!==requestId||
    expected.source&&JSON.stringify(publishedReportSource(expected.source))!==JSON.stringify(normalized)||
    release.protocol!=="shuduo-sync-sql-consumption-source/v1"||release.scope!==value.scope||release.agentIndependentE2E!==false||
    release.releaseId!==source.releaseId||release.packageDigest!==source.packageDigest||release.sourceRevisionId!==source.revisionId||
    release.sourceRunId!==source.runId||release.sourceReleaseRunId!==source.batchId||batch?.id!==source.batchId||
    (source.kind==="AGENT"?release.sourceTaskId!==source.taskId||!["LIVE_MODEL","SYNTHETIC_MODEL"].includes(release.developmentMode):release.developmentMode!=="MANUAL")||
    !Array.isArray(release.batchIds)||release.batchIds.length!==2||new Set(release.batchIds).size!==2||
    ![1,2].includes(batch.sequence)||release.batchIds[batch.sequence-1]!==batch.id||batch.status!=="SUCCEEDED"||
    snapshot.assetId!=="dataset:sync-holdings:"+batch.id||!Number.isInteger(snapshot.rowCount)||snapshot.rowCount<1||
    !/^\d{4}-\d{2}-\d{2}$/.test(release.businessDate)||![snapshot.contentHash,report.resultHash,release.snapshotHash,digest].every(hash)||
    !Array.isArray(calls)||calls.length>20||new Set(calls.map(call=>call?.callId)).size!==calls.length)bad();
 if(expected.receipt){
  const receipt=checkedPublishedReportReceipt(expected.receipt,{requestId,source});
  if(receipt.reportId!==report.id||receipt.reportVersionId!==report.versionId||receipt.reportRunId!==report.runId||
     receipt.resultHash!==report.resultHash||receipt.snapshotId!==snapshot.id||receipt.datasetId!==snapshot.datasetId||
     receipt.sourceEvidenceHash!==snapshot.contentHash||receipt.rowCount!==snapshot.rowCount)bad();
 }
 for(const call of calls){
  try{for(const id of [call.callId,call.serviceId,call.versionId])reportRequestId(id);}catch{bad();}
  if(!["DAPI","XAPI"].includes(call.serviceType)||!["ACTIVE","REVOKED","EXPIRED"].includes(call.applicationStatus)||
     call.verified!==true||call.independentResultVerified!==true||!Number.isInteger(call.rowCount)||
     call.rowCount<1||call.rowCount>snapshot.rowCount||![call.configHash,call.resultHash,call.paginationHash].every(hash))bad();
 }
 const body={requestId,source,report,snapshot,release,batch,calls,...rest};
 const json=JSON.stringify(body,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?
  Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
 const actual=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(json))),byte=>byte.toString(16).padStart(2,"0")).join("");
 if(actual!==digest)bad();
 return value;
}

export async function readPublishedReportEvidence(client,args) {
 const requestId=reportRequestId(args.requestId);
 const value=await client.request('/reports/published/requests/'+requestId+'/lineage');
 return value?.protocol==="shuduo-sync-sql-report-lineage/v1"
  ? checkedSyncReportLineage(value,{...args,requestId}) : checkedPublishedReportLineage(value,{...args,requestId});
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
 if(revision?.id!==lineage.source.revisionId||
    revision.source!==(lineage.source.kind==="AGENT"?"FUND_AGENT_GENERATED":"ENGINEER_AUTHORED")||!hash(revision.hash)||
    [lineage.release.sourceSqlHash,original?.release.sourceSqlHash].some(digest=>digest!==undefined&&digest!==revision.hash)||
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

export function checkedPublishedReportConsumption(value, expected = {}) {
 const bad = () => { throw Error("基金报表与原接口调用的固定批次不一致"); };
 if (!value || value.protocol !== "shuduo-fund-report-consumption/v1" || value.scope !== "LOCAL_TEST_ONLY" ||
     !["VERIFIED", "PENDING", "UNAVAILABLE"].includes(value.status)) bad();
 const { requestId, report, consumption } = value, source = publishedReportSource(value.source);
 try { for (const id of [requestId, report?.id, report?.versionId, report?.runId]) reportRequestId(id); } catch { bad(); }
 const original = expected.lineage;
 if (source.kind !== "AGENT" || !hash(report.resultHash) || expected.requestId && requestId !== expected.requestId ||
     (expected.source || original) && JSON.stringify(source) !== JSON.stringify(publishedReportSource(expected.source ?? original.source)) ||
     original && (requestId !== original.requestId || ["id", "versionId", "runId", "resultHash"].some(key => report[key] !== original.report[key]))) bad();
 if (value.status === "UNAVAILABLE") {
  if (consumption !== undefined) bad();
  return value;
 }
 if (!consumption || consumption.protocol !== "shuduo-local-fund-agent-consumption/v1" || consumption.scope !== value.scope ||
     consumption.taskId !== source.taskId || consumption.releaseId !== source.releaseId || consumption.batchId !== source.batchId ||
     consumption.packageDigest !== source.packageDigest || consumption.outputContractId !== fundReportContractId ||
     consumption.publicDeployed !== false || consumption.externalSystemVerified !== false || consumption.agentIndependentE2E !== false ||
     consumption.status !== value.status || !Array.isArray(consumption.services) || consumption.services.length > 20 ||
     typeof consumption.truncated !== "boolean" || value.status === "VERIFIED" && consumption.truncated) bad();
 for (const entry of consumption.services) {
  if (!entry || !["DAPI", "XAPI"].includes(entry.serviceType) || !["PENDING", "NEEDS_ATTENTION", "VERIFIED"].includes(entry.status) ||
      typeof entry.name !== "string" || !Array.isArray(entry.sourceRunIds) || entry.sourceRunIds.some(id => id !== source.batchId)) bad();
  try { reportRequestId(entry.serviceId); reportRequestId(entry.versionId); if (entry.call) reportRequestId(entry.call.callId); } catch { bad(); }
  if (entry.status === "VERIFIED" && (entry.sourceRunIds.length !== 1 ||
      entry.source?.revisionId !== source.revisionId || entry.source.developmentRunId !== source.runId ||
      (original && (entry.source.modelMode !== original.release.modelMode || entry.source.resultDigest !== original.release.resultDigest)) ||
      entry.call?.versionId !== entry.versionId || entry.call?.verified !== true || entry.call.independentResultVerified !== true ||
      !hash(entry.call.resultHash) || !Number.isSafeInteger(entry.call.rowCount) || entry.call.rowCount < 1 ||
      !["ACTIVE", "REVOKED", "EXPIRED"].includes(entry.call.applicationStatus))) bad();
 }
 if (value.status === "VERIFIED" && ["DAPI", "XAPI"].some(type =>
   !consumption.services.some(entry => entry.serviceType === type && entry.status === "VERIFIED"))) bad();
 return value;
}

export async function readPublishedReportConsumption(client, args) {
 const requestId = reportRequestId(args.requestId);
 return checkedPublishedReportConsumption(await client.request("/reports/published/requests/" + requestId + "/consumption"), { ...args, requestId });
}
