import { serviceHash } from './data-services.mjs';

// Read-only evidence: never rematerializes data, issues tokens or runs compute.
export function privateServiceRecovery({ service, bootId, businessStore,
  ownedService, source, getVersion, applications, calls }) {
  const selected = service.publishedVersion ?? service.currentVersion;
  const versions = [selected];
  if (selected?.serviceType === 'XAPI') {
    for (const step of selected.steps ?? []) {
      ownedService(step.dapiId);
      const version = getVersion(step.dapiVersionId);
      if (!version || version.serviceId !== step.dapiId) {
        versions.push({ id: step.dapiVersionId, missing: true });
      } else versions.push(version);
    }
  }
  const evidence = versions.filter(Boolean).map(version => {
    const base = { versionId: version.id, configHash: version.configHash,
      serviceId: version.serviceId, serviceType: version.serviceType };
    if (version.missing) return { ...base, verified: false, code: 'VERSION_NOT_FOUND' };
    if (version.serviceType !== 'DAPI') return { ...base, verified: true };
    const snapshot = businessStore.snapshotEvidence(version.snapshotId);
    let provenanceVerified = false;
    try {
      const run = source(version.sourceReleaseRunId);
      provenanceVerified = run.packageDigest === version.sourcePackageDigest;
    } catch (error) {
      if (![403, 409, 422].includes(error.status)) throw error;
    }
    const verified = provenanceVerified && snapshot?.integrityVerified === true &&
      snapshot.contentHash === version.snapshotHash;
    return { ...base, sourceReleaseRunId: version.sourceReleaseRunId,
      packageDigest: version.sourcePackageDigest, snapshotId: version.snapshotId,
      expectedSnapshotHash: version.snapshotHash, snapshot: snapshot ?? null,
      provenanceVerified, verified,
      ...(verified ? {} : { code: 'SOURCE_SNAPSHOT_UNAVAILABLE' }) };
  });
  const state = {
    serviceId: service.id, serviceType: service.serviceType, status: service.status,
    currentVersionId: service.currentVersionId, publishedVersionId: service.publishedVersionId,
    versionHistory: service.versions.map(v => ({ id: v.id, configHash: v.configHash,
      status: v.status, versionNumber: v.versionNumber })).sort((a,b)=>a.id.localeCompare(b.id)),
    evidence,
    applications: applications.map(a => ({ id:a.id, status:a.status }))
      .sort((a,b)=>a.id.localeCompare(b.id)),
    calls: calls.map(c => ({ id:c.id, versionId:c.serviceVersionId, outcome:c.outcome,
      statusCode:c.statusCode, rowCount:c.rowCount, resultHash:c.resultHash }))
      .sort((a,b)=>a.id.localeCompare(b.id)),
  };
  const safeState = JSON.parse(JSON.stringify(state));
  return { protocol: 'shuduo-private-service-recovery/v1', scope: 'PRIVATE_CLOUD_TEST',
    publicDeployed: false, bootId, checkedAt: new Date().toISOString(),
    healthy: Boolean(selected) && evidence.length > 0 && evidence.every(e => e.verified),
    fingerprint: serviceHash(safeState), state: safeState,
    notice: '只读恢复对照；须比较不同后端启动标识与同一状态摘要，不代表已完成冷启动验收。' };
}
