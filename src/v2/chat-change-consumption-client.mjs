import {chatChangeResourcePath,digest,sameSource,uuid,validSource} from './chat-change-resource.mjs';

const fields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
const appStatuses=['ACTIVE','EXPIRED','REVOKED'];
const bad=()=>Error('接口、调用或分页回执与所选发布批次不一致，请重新读取原批次。');
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;

function checkedService(entry,batch) {
  if (!uuid(entry?.serviceId)||!uuid(entry.versionId)||!digest(entry.configHash)||
      !['DAPI','XAPI'].includes(entry.serviceType)||!text(entry.name,200)||!text(entry.slug,100)||
      !integer(entry.versionNumber,1,Number.MAX_SAFE_INTEGER)||!['PUBLISHED','RETIRED'].includes(entry.versionStatus)||
      !Array.isArray(entry.sourceRunIds)||entry.sourceRunIds.length!==1||entry.sourceRunIds[0]!==batch.id||
      typeof entry.fullAssetComposition!=='boolean'||!Array.isArray(entry.sourceVersions)) throw bad();
  const refs=entry.sourceVersions;
  if (!refs.length||refs.length>5||new Set(refs.map(ref=>ref.versionId)).size!==refs.length||
      refs.some(ref=>!uuid(ref?.serviceId)||!uuid(ref.versionId)||!digest(ref.configHash)||ref.sourceReleaseRunId!==batch.id||
        !Array.isArray(ref.fields)||!ref.fields.length||ref.fields.some(f=>!fields.includes(f))||
        new Set(ref.fields).size!==ref.fields.length)) throw bad();
  if (entry.serviceType==='DAPI' &&
      (refs.length!==1||refs[0].serviceId!==entry.serviceId||refs[0].versionId!==entry.versionId||refs[0].configHash!==entry.configHash)) throw bad();
  if (entry.serviceType==='XAPI'&&refs.length<2) throw bad();
  const complete=entry.serviceType==='XAPI'&&fields.every(f=>refs.some(ref=>ref.fields.includes(f)));
  if (entry.fullAssetComposition!==complete) throw bad();
  const call=entry.call;
  if (call!==undefined && (!digest(call?.callIdDigest)||!uuid(call.applicationId)||!appStatuses.includes(call.applicationStatus)||
      !Number.isFinite(Date.parse(call.finishedAt))||!digest(call.resultHash)||!integer(call.rowCount,1,batch.rowCount))) throw bad();
  const p=entry.pagination;
  if (p!==undefined && (!call||!uuid(p?.applicationId)||!appStatuses.includes(p.applicationStatus)||
      p.applicationId!==call.applicationId||p.applicationStatus!==call.applicationStatus||
      !['COMPLETE','INCOMPLETE'].includes(p.status)||!integer(p.pageSize,1,100)||!integer(p.totalPages,1,1000)||
      Math.ceil(batch.rowCount/p.pageSize)!==p.totalPages||!Array.isArray(p.verifiedPages)||!p.verifiedPages.length||
      p.verifiedPages.some((page,i)=>!integer(page,1,p.totalPages)||(i>0&&page<=p.verifiedPages[i-1]))||
      (p.status==='COMPLETE')!==(p.verifiedPages.length===p.totalPages))) throw bad();
}

export function checkedChatChangeConsumption(receipt,input) {
  if (receipt?.protocol!=='shuduo-chat-batch-consumption/v1'||receipt.scope!=='LOCAL_TEST_ONLY'||
      receipt.evidenceScope!=='LOCAL_OR_MANUAL_CONSISTENCY_ONLY'||receipt.publicDeployed!==false||
      receipt.externalSystemVerified!==false||receipt.agentIndependentE2E!==false||
      receipt.intentId!==input.intentId||receipt.changeRequestId!==input.changeRequestId||
      !validSource(receipt.parent)||!validSource(receipt.source)||receipt.source.taskId===receipt.parent.taskId||
      receipt.source.revisionId===receipt.parent.revisionId||receipt.source.runId===receipt.parent.runId||
      !uuid(receipt.packageId)||!digest(receipt.packageDigest)||!uuid(receipt.verificationId)||!uuid(receipt.releaseId)||
      !uuid(receipt.batch?.id)||receipt.batch.id!==input.batchId||!integer(receipt.batch.sequence,1,2)||
      !['SCHEDULED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(receipt.batch.status)||
      typeof receipt.truncated!=='boolean'||!['PENDING','MATCHED_ONLY'].includes(receipt.status)||
      !Array.isArray(receipt.services)||receipt.services.length>20) throw bad();
  if (['releaseId','packageId','packageDigest','verificationId'].some(key=>input[key]!==undefined&&input[key]!==receipt[key])||
      (input.sourceRunId!==undefined&&input.sourceRunId!==receipt.source.runId)||
      (input.sourceTaskId!==undefined&&input.sourceTaskId!==receipt.source.taskId)||
      (input.expectedSource&&!sameSource(input.expectedSource,receipt.source))||
      (input.expectedParent&&!sameSource(input.expectedParent,receipt.parent))||
      (input.sequence!==undefined&&input.sequence!==receipt.batch.sequence)) throw bad();
  const entries=receipt.services;
  if (entries.length && (receipt.batch.status!=='SUCCEEDED'||!integer(receipt.batch.rowCount,0,1000))) throw bad();
  for (const entry of entries) checkedService(entry,receipt.batch);
  if (new Set(entries.map(entry=>entry.versionId)).size!==entries.length) throw bad();
  const calls=entries.filter(e=>e.call).map(e=>e.call.callIdDigest);
  if (new Set(calls).size!==calls.length) throw bad();
  if (receipt.status==='MATCHED_ONLY') {
    const complete=entries.filter(e=>e.pagination?.status==='COMPLETE'&&e.pagination.applicationStatus==='REVOKED'&&
      (receipt.batch.rowCount===1||e.pagination.totalPages>=2));
    const matched=complete.some(x=>{
      if (!x.fullAssetComposition) return false;
      return complete.some(d=>{
        if (d.serviceType!=='DAPI'||d.pagination.applicationId!==x.pagination.applicationId) return false;
        const holding=x.sourceVersions.find(ref=>ref.serviceId===d.serviceId&&ref.versionId===d.versionId&&
          ref.configHash===d.configHash&&['client_id','holding_market_value','security_count'].every(f=>ref.fields.includes(f)));
        return holding && x.sourceVersions.some(ref=>ref.serviceId!==holding.serviceId&&
          ['client_id','available_cash','total_assets'].every(f=>ref.fields.includes(f)));
      });
    });
    if (receipt.truncated||!matched) throw bad();
  }
  return receipt;
}

export async function readChatChangeConsumption(client,input) {
  if (!uuid(input.batchId)) throw bad();
  const path=chatChangeResourcePath(input,'publication')+'/batches/'+input.batchId+'/consumption';
  return checkedChatChangeConsumption(await client.request(path),input);
}
