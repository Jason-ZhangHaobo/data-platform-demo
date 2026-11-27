import { consumerDigest } from './consumer-source.mjs';
import { localTaskConsumption } from './local-task-consumption.mjs';
import { syncSqlPageShape } from './sync-sql-service-source.mjs';

const conflict=()=>Object.assign(Error('接口版本或调用记录与所选发布批次不一致，请重新核对原记录'),{status:409,code:'CHAT_CONSUMPTION_UNCONFIRMED'});
const maxCalls=100;
const holdingsFields=['client_id','holding_market_value','security_count'];
const missingBatch=()=>Object.assign(Error('当前发布中没有此批次'),{status:404,code:'CHAT_CONSUMPTION_BATCH_NOT_FOUND'});

function registeredVersion(entry,publication,batch,store,project) {
  const service=store.get('data_service',entry.serviceId,project), version=store.get('data_service_version',entry.versionId,project);
  const origin=entry.source;
  if (!origin || origin.scope!=='LOCAL_TEST_ONLY' || origin.taskId!==publication.source.taskId ||
      origin.revisionId!==publication.source.revisionId || origin.revisionHash!==publication.source.revisionHash ||
      origin.developmentRunId!==publication.source.runId || origin.contextId!==publication.source.contextId ||
      origin.releaseId!==publication.release.id || origin.packageDigest!==publication.packageDigest || origin.sourceReleaseRunId!==batch.id ||
      entry.sourceRunIds.length!==1 || entry.sourceRunIds[0]!==batch.id ||
      !service || !version || !Array.isArray(entry.sourceVersions) || !entry.sourceVersions.length) throw conflict();
  const test=typeof version.testId==='string' && store.get('data_service_test',version.testId,project);
  if (!test || test.serviceId!==service.id || test.versionId!==version.id || test.configHash!==version.configHash ||
      entry.configHash!==version.configHash || version.serviceId!==service.id || version.serviceType!==service.serviceType ||
      test.status!=='PASSED' || !['PUBLISHED','RETIRED'].includes(version.status)) throw conflict();
  const sourceVersions=entry.sourceVersions.map(v=>{
    if (v.sourceReleaseRunId!==batch.id || v.releaseId!==publication.release.id || v.packageDigest!==publication.packageDigest) throw conflict();
    return {serviceId:v.serviceId,versionId:v.versionId,configHash:v.configHash,sourceReleaseRunId:v.sourceReleaseRunId,fields:v.fields};
  });
  return {serviceId:service.id,versionId:version.id,configHash:version.configHash,serviceType:entry.serviceType,
    name:service.name,slug:service.slug,versionNumber:version.versionNumber,versionStatus:version.status,
    sourceRunIds:[batch.id],sourceVersions,fullAssetComposition:entry.fullAssetComposition===true};
}

// A version can have been queried with different grants or page sizes. Preserve
// that separation until a pair of compatible DAPI/XAPI grants has been found.
async function inspectCalls(entry,logs,apps,rowCount,manager) {
  const groups=new Map();
  let single;
  for (const saved of logs) {
    const app=apps.get(saved.applicationId);
    if (!app || app.scope!=='LOCAL_TEST_ONLY' || !app.serviceIds?.includes(entry.serviceId) ||
        !['ACTIVE','EXPIRED','REVOKED'].includes(app.status)) continue;
    const shape=(!app.customerAccess && !saved.customerAccessHash && saved.parameters &&
      Object.keys(saved.parameters).every(key=>key==='page'||key==='pageSize'))
      ? syncSqlPageShape(rowCount,saved.parameters) : undefined;
    const key=shape ? app.id+':'+shape.pageSize : undefined;
    if (single && (!shape || saved.rowCount!==shape.rowCount || groups.get(key)?.pages.has(shape.page))) continue;
    let proof;
    try { proof=await manager.recheckCall(entry.serviceId,saved.id,{pinnedVersionId:entry.versionId}); }
    catch(error) { if ([400,403,404,409,422,504].includes(error.status)) continue; throw error; }
    if (!proof.verified || proof.callId!==saved.id || proof.versionId!==entry.versionId || proof.configHash!==entry.configHash ||
        proof.rowCount!==saved.rowCount || proof.resultHash!==saved.resultHash) continue;
    const call={callIdDigest:consumerDigest(saved.id),applicationId:app.id,applicationStatus:app.status,finishedAt:saved.finishedAt,
      resultHash:saved.resultHash,rowCount:saved.rowCount};
    single??=call;
    if (!shape || saved.rowCount!==shape.rowCount || proof.coverage!==undefined) continue;
    const group=groups.get(key)??{app,pageSize:shape.pageSize,totalPages:shape.totalPages,pages:new Map()};
    group.pages.set(shape.page,call);
    groups.set(key,group);
  }
  const coverage=[...groups.values()].map(({app,pageSize,totalPages,pages})=>{
    const verifiedPages=[...pages.keys()].sort((a,b)=>a-b);
    return {app,call:pages.get(verifiedPages[0]),pagination:{status:verifiedPages.length===totalPages?'COMPLETE':'INCOMPLETE',
      applicationId:app.id,applicationStatus:app.status,pageSize,totalPages,verifiedPages}};
  });
  const rank=g=>g.pagination.verifiedPages.length/g.pagination.totalPages;
  coverage.sort((a,b)=>rank(b)-rank(a) || b.pagination.verifiedPages.length-a.pagination.verifiedPages.length);
  return {entry,single,coverage,chosen:coverage[0]};
}

function complete(group,rowCount) {
  return group.pagination.status==='COMPLETE' && group.app.status==='REVOKED' &&
    (rowCount===1 || group.pagination.totalPages>1);
}
function selectMatchedPair(results,rowCount) {
  for (const x of results.filter(item=>item.entry.serviceType==='XAPI' && item.entry.fullAssetComposition)) {
    for (const group of x.coverage.filter(g=>complete(g,rowCount) && g.app.serviceIds?.length===2)) {
      for (const ref of x.entry.sourceVersions) {
        if (!holdingsFields.every(field=>ref.fields.includes(field)) ||
            !x.entry.sourceVersions.some(cash=>cash.serviceId!==ref.serviceId &&
              ['client_id','available_cash','total_assets'].every(field=>cash.fields.includes(field)))) continue;
        const d=results.find(({entry})=>entry.serviceType==='DAPI' && entry.serviceId===ref.serviceId && entry.versionId===ref.versionId);
        const matching=d?.coverage.find(g=>g.app.id===group.app.id && complete(g,rowCount));
        if (matching) { d.chosen=matching; x.chosen=group; return true; }
      }
    }
  }
  return false;
}

export async function readChatBatchConsumption({store,project,manager,agent,publication,batchId}) {
  const batch=publication.runs.find(run=>run.id===batchId);
  if (!batch || publication.phase!=='PUBLISHED') throw missingBatch();
  const base={protocol:'shuduo-chat-batch-consumption/v1',scope:'LOCAL_TEST_ONLY',evidenceScope:'LOCAL_OR_MANUAL_CONSISTENCY_ONLY',
    publicDeployed:false,externalSystemVerified:false,agentIndependentE2E:false,intentId:publication.intentId,
    changeRequestId:publication.changeRequestId,parent:publication.parent,source:publication.source,packageId:publication.packageId,
    packageDigest:publication.packageDigest,verificationId:publication.verificationId,releaseId:publication.release.id,
    batch:{id:batchId,sequence:batch.sequence,status:batch.status,...(batch.rowCount!==undefined?{rowCount:batch.rowCount}:{})}};
  if (!publication.monitoringVerified || batch.status!=='SUCCEEDED')
    return {...base,status:'PENDING',truncated:false,services:[]};
  const report=await localTaskConsumption({store,project,agent,packageDigest:base.packageDigest,releaseId:base.releaseId,
    batchId,nativeVersionHistory:true,manager});
  const entries=report.services.map(entry=>registeredVersion(entry,publication,batch,store,project));
  if (!report.truncated) {
    for (const x of entries.filter(entry=>entry.serviceType==='XAPI')) {
      if (x.sourceVersions.some(ref=>!entries.some(e=>e.serviceType==='DAPI' && e.serviceId===ref.serviceId &&
          e.versionId===ref.versionId && e.configHash===ref.configHash))) throw conflict();
    }
  }
  const versions=new Set(entries.map(e=>e.versionId));
  const apps=new Map(manager.listApplications().map(app=>[app.id,app]));
  const logs=manager.listCalls().filter(call=>versions.has(call.serviceVersionId) && call.statusCode===200 &&
      call.outcome==='SUCCEEDED' && call.rowCount>0)
    .sort((a,b)=>String(b.finishedAt).localeCompare(String(a.finishedAt)) || b.id.localeCompare(a.id));
  const truncated=report.truncated || logs.length>maxCalls;
  const selected=logs.slice(0,maxCalls),results=[];
  for (const entry of entries) {
    results.push(await inspectCalls(entry,selected.filter(call=>call.serviceId===entry.serviceId&&call.serviceVersionId===entry.versionId),
      apps,batch.rowCount,manager));
  }
  const matched=selectMatchedPair(results,batch.rowCount);
  const services=results.map(({entry,chosen,single})=>({...entry,...(chosen?{call:chosen.call,pagination:chosen.pagination}:single?{call:single}:{})}));
  return {...base,status:matched&&!truncated?'MATCHED_ONLY':'PENDING',truncated,services};
}
