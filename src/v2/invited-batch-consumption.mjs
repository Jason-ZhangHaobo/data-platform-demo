import { inspectBatchServiceCalls } from './batch-service-pages.mjs';
import { consumerDigest } from './consumer-source.mjs';
import { serviceHash } from './data-services.mjs';
import { independentConsumerResponse } from './external-consumption-binding.mjs';
import { storedServiceCallAttribution } from './service-consumption-attribution.mjs';
import { getContext } from './context.mjs';

export async function invitedBatchPages({store,project,manager,entry,calls,owner}) {
  if (entry.status!=='VERIFIED' || !entry.source || !entry.call || entry.call.coverage) return;
  const app=manager.application(entry.call.applicationId);
  if (app.scope!=='PRIVATE_CLOUD_TEST' || app.createdBy!==owner) return;
  const version=store.get('data_service_version',entry.versionId,project);
  const expectedRows=getContext(entry.source.contextId).expected;
  const dapis=version.serviceType==='XAPI'
    ? version.steps.map((step,index)=>({alias:step.alias,fields:entry.sourceVersions[index].fields})) : [];
  const service={type:version.serviceType,fields:version.fields};

  // Both the saved call's immutable snapshot and the independently registered
  // business expectation must match each page. Never mix applications or count
  // the Agent's single delegated query as bearer HTTP pagination.
  const checkPage=(call,shape)=>{
    if (call.invocationEvidence?.channel!=='BEARER_HTTP') return false;
    const expected=independentConsumerResponse({expectedRows,dapis},service,{page:shape.page,page_size:shape.pageSize});
    if (call.resultHash!==serviceHash(expected.data) ||
        call.invocationEvidence.paginationDigest!==undefined &&
        call.invocationEvidence.paginationDigest!==serviceHash(expected.pagination)) return false;
    try {return storedServiceCallAttribution({store,project,call,version,source:entry.source})?.channel==='BEARER_HTTP';}
    catch (error) {if (error.status===409) return false; throw error;}
  };
  const eligible=calls.filter(call=>call.serviceId===entry.serviceId && call.serviceVersionId===entry.versionId &&
    call.applicationId===app.id && call.outcome==='SUCCEEDED' && call.statusCode===200 && call.rowCount>0 &&
    call.invocationEvidence?.channel==='BEARER_HTTP');
  const limit=100;
  const {chosen}=await inspectBatchServiceCalls(entry,eligible.slice(0,limit),new Map([[app.id,app]]),expectedRows.length,manager,
    {scope:'PRIVATE_CLOUD_TEST',checkPage});
  return {...(chosen?{paginationCoverage:chosen.pagination}:{}),...(eligible.length>limit?{paginationHistoryTruncated:true}:{})};
}

// Rebuild the original issuance from its existing idempotency record. Public
// applications carry a token prefix, so return an explicit field projection.
export function invitedBatchApplications({store,project,manager,report,owner,batchId}) {
  const services=new Map();
  for (const entry of report.services) {
    const service=store.get('data_service',entry.serviceId,project);
    const version=store.get('data_service_version',entry.versionId,project);
    if (entry.source?.sourceReleaseRunId===batchId && entry.sourceRunIds.length===1 &&
        entry.sourceRunIds[0]===batchId && entry.status!=='NEEDS_ATTENTION' &&
        service?.createdBy===owner && service.scope==='PRIVATE_CLOUD_TEST' && /^[a-f0-9]{64}$/.test(service.pilotId) &&
        version?.versionNumber===1 && version.status==='PUBLISHED' && service.publishedVersionId===version.id)
      services.set(service.id,service.pilotId);
  }
  const applications=[],limit=20;
  if (!services.size) return {applications,applicationsTruncated:report.truncated};
  let truncated=false;
  const ledger=store.db.prepare('SELECT key,signature FROM idempotency WHERE result_id=?');
  const prefix=project+':private-service:'+owner+':app:';
  for (const item of store.list('service_app',project)) {
    if (item.createdBy!==owner || item.scope!=='PRIVATE_CLOUD_TEST' || item.customerAccess!==undefined ||
        !item.pilotId || !Array.isArray(item.serviceIds) || !item.serviceIds.length || item.serviceIds.length>3 ||
        new Set(item.serviceIds).size!==item.serviceIds.length || !item.serviceIds.every(id=>services.get(id)===item.pilotId) ||
        item.issuanceEvidence?.mode!=='AUTHENTICATED_SESSION') continue;
    const signature=serviceHash({name:item.name,serviceIds:item.serviceIds});
    const original=ledger.all(item.id).filter(row=>row.signature===signature && row.key.startsWith(prefix) &&
      consumerDigest(row.key.slice(prefix.length))===item.issuanceEvidence.requestDigest);
    if (original.length!==1) continue;
    const app=manager.application(item.id);
    if (!['ACTIVE','EXPIRED','REVOKED'].includes(app.status) || !Number.isFinite(Date.parse(app.expiresAt)) ||
        app.status==='REVOKED'&&!Number.isFinite(Date.parse(app.revokedAt))) continue;
    if (applications.length===limit) {truncated=true;break;}
    applications.push({applicationId:app.id,name:app.name,status:app.status,createdAt:app.createdAt,expiresAt:app.expiresAt,
      ...(app.status==='REVOKED'?{revokedAt:app.revokedAt}:{}),serviceIds:app.serviceIds});
  }
  return {applications,applicationsTruncated:report.truncated||truncated};
}
