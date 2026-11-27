import { consumerDigest } from './consumer-source.mjs';
import { syncSqlPageShape } from './sync-sql-service-source.mjs';

// A version can have been queried with different grants or page sizes. Preserve
// that separation until a pair of compatible DAPI/XAPI grants has been found.
export async function inspectBatchServiceCalls(entry, logs, apps, rowCount, manager, {scope, checkPage}) {
  const groups=new Map();
  let single;
  for (const saved of logs) {
    const app=apps.get(saved.applicationId);
    if (!app || app.scope!==scope || !app.serviceIds?.includes(entry.serviceId) ||
        !['ACTIVE','EXPIRED','REVOKED'].includes(app.status)) continue;
    const shape=(!app.customerAccess && !saved.customerAccessHash && saved.parameters &&
      Object.keys(saved.parameters).every(key=>key==='page'||key==='pageSize'))
      ? syncSqlPageShape(rowCount,saved.parameters) : undefined;
    const key=shape ? app.id+':'+shape.pageSize : undefined;
    if (single && (!shape || saved.rowCount!==shape.rowCount || groups.get(key)?.pages.has(shape.page))) continue;
    if (checkPage && (!shape || !checkPage(saved, shape))) continue;
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
