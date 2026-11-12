import { publishedReportSource, reportRequestId } from './published-report-request.mjs';

const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function completeWealthPages(calls, rowCount) {
  const groups = new Map();
  for (const call of calls) {
    const totalPages = Math.ceil(rowCount / call.pageSize);
    if (call.filtered || call.page > totalPages) continue;
    const key = `${call.applicationId}:${call.pageSize}`;
    if (!groups.has(key)) groups.set(key, new Set());
    const pages = groups.get(key);
    pages.add(call.page);
    if (pages.size === totalPages) return true;
  }
  return false;
}

export function checkedWealthReportConsumption(value, expected) {
  const bad = () => { throw Error('报表运行与原批次调用回执不一致'); };
  if (value?.protocol !== 'shuduo-wealth-report-consumption/v1' || value.scope !== 'LOCAL_TEST_ONLY' ||
      value.publicDeployed !== false || value.agentIndependentE2E !== false || value.sourceAttribution !== 'ENGINEER_AUTHORED' ||
      !['VERIFIED', 'UNCONFIRMED', 'PENDING'].includes(value.status) || !Array.isArray(value.services)) bad();
  const { report, snapshot, source, services } = value;
  const binding = publishedReportSource(source);
  if (binding.kind !== 'MANUAL' || !hash(report?.resultHash) || !hash(snapshot?.contentHash) ||
      typeof value.context?.id !== 'string' || typeof value.context?.name !== 'string' ||
      !Number.isSafeInteger(snapshot.rowCount) || snapshot.rowCount < 1 || snapshot.rowCount > 1000 ||
      !Array.isArray(snapshot.fields) || !snapshot.fields.length || snapshot.fields.some(field => typeof field !== 'string') ||
      expected && (report.id !== expected.reportId || report.runId !== expected.runId ||
        expected.versionId && report.versionId !== expected.versionId || expected.resultHash && report.resultHash !== expected.resultHash)) bad();
  for (const id of [report.id, report.runId, report.versionId, snapshot.id]) reportRequestId(id);
  const calls = new Set(), versions = new Set();
  for (const service of services) {
    if (!['DAPI', 'XAPI'].includes(service?.type) || !Array.isArray(service.fields) || service.fields.some(field => typeof field !== 'string') ||
        !Array.isArray(service.childVersionIds) || (service.type === 'DAPI' ? service.childVersionIds.length !== 0 :
          service.childVersionIds.length < 2 || service.childVersionIds.length > 5 || new Set(service.childVersionIds).size !== service.childVersionIds.length) ||
        typeof service.completePagination !== 'boolean' || !Array.isArray(service.calls) || !service.calls.length ||
        !Number.isSafeInteger(service.versionNumber) || service.versionNumber < 1 || versions.has(service.versionId)) bad();
    for (const id of [service.serviceId, service.versionId, ...service.childVersionIds]) reportRequestId(id);
    versions.add(service.versionId);
    for (const call of service.calls) {
      if (!call || !['ACTIVE', 'EXPIRED', 'REVOKED'].includes(call.applicationStatus) || !hash(call.resultHash) ||
          !Number.isFinite(Date.parse(call.finishedAt)) || !Number.isSafeInteger(call.rowCount) || call.rowCount < 0 ||
          call.rowCount > snapshot.rowCount || !Number.isSafeInteger(call.page) || call.page < 1 ||
          !Number.isSafeInteger(call.pageSize) || call.pageSize < 1 || call.pageSize > 100 ||
          typeof call.filtered !== 'boolean' || calls.has(call.callId)) bad();
      reportRequestId(call.callId);
      reportRequestId(call.applicationId);
      calls.add(call.callId);
    }
    if (service.completePagination !== completeWealthPages(service.calls, snapshot.rowCount)) bad();
  }
  const completeDapis = new Set(services.filter(item => item.type === 'DAPI' && item.completePagination).map(item => item.versionId));
  const verified = services.some(item => item.type === 'XAPI' && item.completePagination && item.childVersionIds.length >= 2 &&
    snapshot.fields.every(field => item.fields.includes(field)) && item.childVersionIds.every(id => completeDapis.has(id)));
  if (calls.size !== value.verifiedCalls || !Number.isSafeInteger(value.unconfirmedCalls) || value.unconfirmedCalls < 0 ||
      calls.size + value.unconfirmedCalls > 100 || typeof value.truncated !== 'boolean' ||
      value.status !== (verified ? 'VERIFIED' : value.unconfirmedCalls ? 'UNCONFIRMED' : 'PENDING')) bad();
  return value;
}

export async function readWealthConsumption(client, expected) {
  const reportId = reportRequestId(expected.reportId), runId = reportRequestId(expected.runId);
  return checkedWealthReportConsumption(await client.request(`/reports/${reportId}/wealth-consumption?run_id=${runId}`), expected);
}
