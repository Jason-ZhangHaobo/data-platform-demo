const fields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
const id = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validLifecycleConsumptionSource(source) {
  return Boolean(source && source.sourceKind === "AGENT" && source.scope === "LOCAL_TEST_ONLY" &&
    Object.keys(source).every(key => ["sourceKind","scope","taskId","revisionId","revisionHash","developmentRunId","packageId","packageDigest","verificationId","releaseId","batches"].includes(key)) &&
    [source.taskId, source.revisionId, source.developmentRunId, source.packageId, source.verificationId, source.releaseId].every(id) &&
    digest(source.revisionHash) && digest(source.packageDigest) && Array.isArray(source.batches) && source.batches.length === 2 &&
    new Set(source.batches.map(batch => batch?.id)).size === 2 && source.batches.every(batch => id(batch?.id) && batch.id !== source.developmentRunId &&
      timestamp(batch.finishedAt) && Object.keys(batch).every(key => ["id","finishedAt"].includes(key))));
}

// Check only the bounded, already-authorized API projection. It contains no
// tokens, SQL, parameters or business rows and never creates a consumer call.
export function inspectLifecycleConsumption(source, report) {
  const invalid = () => ({ status: "PENDING", code: "CONSUMPTION_EVIDENCE_INVALID" });
  if (!validLifecycleConsumptionSource(source) || !report || report.protocol !== "shuduo-local-task-consumption/v1" ||
      report.scope !== source.scope || report.taskId !== source.taskId || report.packageDigest !== source.packageDigest || report.releaseId !== source.releaseId ||
      report.sourceKind !== "AGENT" || report.sourceAttribution !== undefined || report.externalSystemVerified !== false || report.agentIndependentE2E !== false || report.publicDeployed !== false ||
      !["VERIFIED", "PENDING"].includes(report.status) || report.truncated !== false || !timestamp(report.checkedAt) ||
      !Array.isArray(report.services) || report.services.length > 20 || !Number.isSafeInteger(report.matchingCount) ||
      report.matchingCount !== report.services.length || new Set(report.services.map(entry => entry?.serviceId)).size !== report.services.length) return invalid();
  const pending = { status: "PENDING", code: "CONSUMPTION_NOT_READY" };
  // The top-level status is never sufficient: require a checked XAPI pinned to
  // at least two distinct DAPI versions from the same successful release batch.
  for (const entry of report.services) {
    if (entry?.serviceType !== "XAPI" || entry.status !== "VERIFIED") continue;
    const versions = entry.sourceVersions, call = entry.call;
    if (!id(entry.serviceId) || !id(entry.versionId) || !digest(entry.configHash) || entry.sourceKind !== "AGENT" || entry.sourceAttribution !== undefined || entry.releaseId !== source.releaseId ||
        entry.agentIndependentE2E !== false || entry.fullAssetComposition !== true || !Array.isArray(entry.sourceRunIds) || entry.sourceRunIds.length !== 1 ||
        !Array.isArray(versions) || versions.length < 2 || versions.length > 5 ||
        new Set(versions.map(version => version?.versionId)).size !== versions.length || new Set(versions.map(version => version?.serviceId)).size !== versions.length)
      return invalid();
    const batchId = entry.sourceRunIds[0], batch = source.batches.find(value => value.id === batchId);
    if (!batch || versions.some(version => !version || !id(version.serviceId) || !id(version.versionId) || !digest(version.configHash) ||
        version.serviceId === entry.serviceId || version.versionId === entry.versionId || version.releaseId !== source.releaseId || version.packageDigest !== source.packageDigest ||
        version.sourceReleaseRunId !== batchId || version.sourceKind !== "AGENT" || version.sourceAttribution !== undefined || !Array.isArray(version.fields) || !version.fields.length || version.fields.length > fields.length ||
        new Set(version.fields).size !== version.fields.length || version.fields.some(field => !fields.includes(field)))) return invalid();
    const union = new Set(versions.flatMap(version => version.fields));
    if (!fields.every(field => union.has(field)) || !call || call.verified !== true || !id(call.callId) || call.versionId !== entry.versionId || call.configHash !== entry.configHash ||
        !digest(call.resultHash) || !Number.isSafeInteger(call.rowCount) || call.rowCount < 1 || call.rowCount > 1000 || !id(call.applicationId) ||
        !["ACTIVE", "REVOKED", "EXPIRED"].includes(call.applicationStatus) || !timestamp(call.finishedAt) ||
        Date.parse(call.finishedAt) < Date.parse(batch.finishedAt) || Date.parse(report.checkedAt) < Date.parse(call.finishedAt)) return invalid();
    if (report.status !== "VERIFIED") return invalid();
    const selected = {
      serviceId: entry.serviceId, serviceType: "XAPI", versionId: entry.versionId, configHash: entry.configHash, status: "VERIFIED",
      sourceKind: "AGENT", releaseId: source.releaseId, agentIndependentE2E: false, fullAssetComposition: true, sourceRunIds: [batchId],
      sourceVersions: versions.map(version => ({ serviceId: version.serviceId, versionId: version.versionId, configHash: version.configHash,
        releaseId: version.releaseId, sourceReleaseRunId: version.sourceReleaseRunId, packageDigest: version.packageDigest, sourceKind: "AGENT", fields: [...version.fields] })),
      call: { callId: call.callId, versionId: call.versionId, configHash: call.configHash, rowCount: call.rowCount, resultHash: call.resultHash, verified: true,
        applicationId: call.applicationId, applicationStatus: call.applicationStatus, finishedAt: call.finishedAt },
    };
    return { status: "PASSED", code: "CONSUMPTION_INTERNAL_RECHECK_PASSED", source: structuredClone(source),
      evidenceIds: [entry.serviceId, entry.versionId, ...versions.map(version => version.versionId), call.callId, batchId],
      evidence: { protocol: report.protocol, scope: report.scope, taskId: report.taskId, packageDigest: report.packageDigest, releaseId: report.releaseId,
        sourceKind: "AGENT", status: "VERIFIED", checkedAt: report.checkedAt, matchingCount: 1, truncated: false, services: [selected],
        externalSystemVerified: false, agentIndependentE2E: false, publicDeployed: false },
      externalSystemVerified: false, agentIndependentE2E: false, publicDeployed: false,
      notice: "本机既有授权调用与不可变快照的内部对照通过；应用可能已撤销或到期，不代表当前授权、外部客户端独立验收或云端完成。" };
  }
  return report.status === "PENDING" ? pending : invalid();
}

export function verifyLifecycleConsumptionStage(source, stage) {
  if (!stage || stage.status !== "PASSED" || stage.code !== "CONSUMPTION_INTERNAL_RECHECK_PASSED" ||
      stage.externalSystemVerified !== false || stage.agentIndependentE2E !== false || stage.publicDeployed !== false || !same(stage.source, source)) return false;
  const checked = inspectLifecycleConsumption(source, stage.evidence);
  return checked.status === "PASSED" && same(checked.evidence, stage.evidence) && same(checked.evidenceIds, stage.evidenceIds);
}
