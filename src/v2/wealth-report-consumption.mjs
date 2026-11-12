import { isDeepStrictEqual as same } from 'node:util';
import { getContext } from './context.mjs';
import { dataServiceFields, normalizedServiceSourceRows, serviceHash, serviceVersionConfigValid } from './data-services.mjs';
import { resolvePublishedReportSource } from './published-report-source.mjs';
import { checkedFixedReportArtifacts } from './report-provenance.mjs';
import { executeWidget } from './reports.mjs';
import { completeWealthPages } from './wealth-report-consumption-client.mjs';

const assetId = 'dataset:customer_assets_t1';
const digest = /^[a-f0-9]{64}$/;
const client = /^[A-Z0-9][A-Z0-9-]{2,63}$/;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const unproven = () => fail(409, 'WEALTH_REPORT_CONSUMPTION_UNPROVEN', '报表运行和原发布批次的来源无法确认');
const projectFields = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field]]));

function verifiedCall({ call, version, application, children, rows, finishedAt, now }) {
  const { parameters: query } = call;
  const started = Date.parse(call.startedAt), finished = Date.parse(call.finishedAt);
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      Object.keys(query).some(key => !['page', 'pageSize', 'clientId'].includes(key)) ||
      !Number.isSafeInteger(query.page) || query.page < 1 || query.page > 10000 ||
      !Number.isSafeInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100 ||
      query.clientId !== undefined && (typeof query.clientId !== 'string' || !client.test(query.clientId)) ||
      call.serviceId !== version.serviceId || call.serviceType !== version.serviceType || call.versionNumber !== version.versionNumber ||
      call.statusCode !== 200 || !digest.test(call.resultHash ?? '') ||
      !application || application.scope !== 'LOCAL_TEST_ONLY' || !Array.isArray(application.serviceIds) ||
      !application.serviceIds.includes(version.serviceId) || !['ACTIVE', 'REVOKED'].includes(application.status) ||
      !(Date.parse(application.createdAt) <= started && Date.parse(version.publishedAt) <= started &&
        Date.parse(finishedAt) <= started && started <= finished) ||
      application.expiresAt !== undefined && !(started < Date.parse(application.expiresAt)) ||
      application.status === 'REVOKED' && !(finished <= Date.parse(application.revokedAt))) return;
  const filtered = query.clientId === undefined ? rows : rows.filter(row => row.client_id === query.clientId);
  const offset = (query.page - 1) * query.pageSize;
  const expected = filtered.slice(offset, offset + query.pageSize).map(row => version.serviceType === 'DAPI' ?
    projectFields(row, version.fields) : {
      client_id: row.client_id, ...Object.fromEntries(version.steps.map((step, index) =>
        [step.alias, projectFields(row, children[index].fields.filter(field => field !== 'client_id'))])),
    });
  if (expected.length !== call.rowCount || serviceHash(expected) !== call.resultHash) return;
  const applicationStatus = application.status === 'ACTIVE' && Date.parse(application.expiresAt) <= now ? 'EXPIRED' : application.status;
  return { callId: call.id, applicationId: application.id, applicationStatus, page: query.page, pageSize: query.pageSize,
    filtered: query.clientId !== undefined, rowCount: call.rowCount, resultHash: call.resultHash, finishedAt: call.finishedAt };
}

export function readWealthReportConsumption({ store, reportStore, businessStore, project, reportId, runId, actor, now = Date.now() }) {
  const read = (kind, id) => store.get(kind, id, project);
  const { report, version: reportVersion, run, snapshot, dataset, data } =
    checkedFixedReportArtifacts({ store, project, reportStore, reportId, runId });
  if (dataset.assetId !== assetId || snapshot.assetId !== assetId || run.outputContractId || reportVersion.outputContractId)
    throw fail(422, 'WEALTH_REPORT_CONSUMPTION_UNSUPPORTED', '仅客户资产发布快照支持此消费回看');
  const batch = read('release_run', snapshot.assetVersionId);
  if (!batch?.source || !digest.test(batch.packageDigest ?? '')) throw unproven();
  const source = { kind: 'MANUAL', releaseId: batch.releaseId, batchId: batch.id, packageDigest: batch.packageDigest,
    revisionId: batch.source.revisionId, runId: batch.source.runId };
  if (dataset.publishedSource && !same(dataset.publishedSource, source) || dataset.sourceActorId && dataset.sourceActorId !== actor)
    throw unproven();
  const resolved = resolvePublishedReportSource({ store, project, source, actorId: actor });
  const fields = snapshot.fields;
  const rows = normalizedServiceSourceRows(getContext(resolved.context.id).expected);
  if (resolved.asset.id !== assetId || resolved.asset.versionId !== batch.id ||
      resolved.asset.evidenceHash !== snapshot.assetEvidenceHash || snapshot.actualMaterialization !== true ||
      !Array.isArray(fields) || !fields.length || !same(fields, dataset.fields) || new Set(fields).size !== fields.length ||
      fields.some(field => !dataServiceFields.includes(field)) ||
      !same(normalizedServiceSourceRows(resolved.rows), rows) ||
      !same(resolved.rows.map(row => projectFields(row, fields)), data.rows) ||
      !same(reportVersion.widgets.map(widget => executeWidget(widget, data.rows)), run.widgets)) throw unproven();

  const versions = store.list('data_service_version', project).filter(item =>
    !item.outputContractId && item.scope === 'LOCAL_TEST_ONLY' && ['PUBLISHED', 'RETIRED'].includes(item.status));
  const serviceTypes = new Map(store.list('data_service', project).map(item => [item.id, item.serviceType]));
  const dapis = versions.filter(item => item.serviceType === 'DAPI' && item.sourceReleaseRunId === batch.id);
  const dapiById = new Map(dapis.map(item => [item.id, item]));
  const candidates = [...dapis, ...versions.filter(item => item.serviceType === 'XAPI' && Array.isArray(item.steps) &&
    item.steps.some(step => dapiById.has(step?.dapiVersionId)))];
  const validDapiIds = new Set(dapis.filter(item => {
    if (serviceTypes.get(item.serviceId) !== 'DAPI' || item.sourceReleaseId !== source.releaseId || item.sourcePackageDigest !== source.packageDigest ||
        item.sourceEngine !== batch.engine || item.sourceEngineVersion !== batch.engineVersion ||
        !serviceVersionConfigValid(item) || !Array.isArray(item.fields) || !item.fields.includes('client_id') ||
        new Set(item.fields).size !== item.fields.length || item.fields.some(field => !dataServiceFields.includes(field))) return false;
    const data = businessStore.snapshotEvidence(item.snapshotId);
    return data?.integrityVerified && data.contentHash === item.snapshotHash && item.snapshotHash === serviceHash(rows);
  }).map(item => item.id));
  const byVersion = new Map(candidates.map(item => [item.id, item]));
  const allCalls = store.list('service_call', project).filter(call => call.outcome === 'SUCCEEDED' && byVersion.has(call.serviceVersionId));
  const calls = new Map();
  for (const call of allCalls.slice(0, 100)) {
    const version = byVersion.get(call.serviceVersionId);
    const children = version.serviceType === 'DAPI' ? [] : version.steps.map(step => dapiById.get(step?.dapiVersionId));
    const valid = version.serviceType === 'DAPI' ? validDapiIds.has(version.id) :
      serviceTypes.get(version.serviceId) === 'XAPI' && version.joinKey === 'client_id' && children.length >= 2 && children.length <= 5 &&
      new Set(children.map(child => child?.serviceId)).size === children.length &&
      new Set(version.steps.map(step => step?.alias)).size === children.length && serviceVersionConfigValid(version) &&
      children.every((child, index) => child && validDapiIds.has(child.id) && child.serviceId === version.steps[index].dapiId &&
        Date.parse(child.publishedAt) <= Date.parse(version.publishedAt) && /^[a-z][a-z0-9_]{1,29}$/.test(version.steps[index].alias));
    const receipt = valid && verifiedCall({ call, version, application: read('service_app', call.applicationId), children,
      rows, finishedAt: batch.finishedAt, now });
    if (receipt) {
      if (!calls.has(version.id)) calls.set(version.id, []);
      calls.get(version.id).push(receipt);
    }
  }
  const services = candidates.filter(item => calls.has(item.id)).map(item => {
    const receipts = calls.get(item.id);
    return { type: item.serviceType, serviceId: item.serviceId, versionId: item.id, versionNumber: item.versionNumber,
      fields: item.serviceType === 'DAPI' ? item.fields : [...new Set(item.steps.flatMap(step => dapiById.get(step.dapiVersionId).fields))],
      childVersionIds: item.serviceType === 'XAPI' ? item.steps.map(step => step.dapiVersionId) : [],
      completePagination: completeWealthPages(receipts, rows.length), calls: receipts };
  });
  const completeDapis = new Set(services.filter(item => item.type === 'DAPI' && item.completePagination).map(item => item.versionId));
  const verified = services.some(item => item.type === 'XAPI' && item.completePagination &&
    fields.every(field => item.fields.includes(field)) && item.childVersionIds.every(id => completeDapis.has(id)));
  const verifiedCalls = services.reduce((sum, service) => sum + service.calls.length, 0);
  const unconfirmedCalls = Math.min(allCalls.length, 100) - verifiedCalls;
  return { protocol: 'shuduo-wealth-report-consumption/v1', scope: 'LOCAL_TEST_ONLY', sourceAttribution: 'ENGINEER_AUTHORED',
    status: verified ? 'VERIFIED' : unconfirmedCalls ? 'UNCONFIRMED' : 'PENDING', source,
    report: { id: report.id, runId: run.id, versionId: reportVersion.id, resultHash: run.resultHash },
    snapshot: { id: snapshot.id, contentHash: snapshot.contentHash, rowCount: rows.length, fields },
    context: { id: resolved.context.id, name: resolved.context.name }, services, verifiedCalls, unconfirmedCalls,
    truncated: allCalls.length > 100, publicDeployed: false, agentIndependentE2E: false };
}
