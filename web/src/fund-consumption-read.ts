import type { ServiceSourceBinding } from "./service-source-binding";
import type { TaskConsumption } from "./agent-journey";

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const id = (value: unknown) => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const bad = () => Error("基金原批次、固定接口版本或历史调用未确认，请只读重查。");
const integer = (value: unknown, minimum: number) => Number.isSafeInteger(value) && Number(value) >= minimum;
function checkedCall(call: unknown, version: Record<string, unknown>, dapi: boolean): boolean {
  return record(call) && id(call.callId) && id(call.applicationId) && call.versionId === version.versionId && call.configHash === version.configHash &&
    ["ACTIVE", "REVOKED", "EXPIRED"].includes(String(call.applicationStatus)) && typeof call.finishedAt === "string" &&
    Number.isFinite(Date.parse(call.finishedAt)) && call.verified === true && call.independentResultVerified === true &&
    hash(call.resultHash) && integer(call.rowCount, 0) && call.expectedRowCount === call.rowCount &&
    integer(call.page, 1) && integer(call.pageSize, 1) &&
    call.paginationUnit === (dapi ? "FUND_EXPOSURE_ROWS" : "PORTFOLIO_DATE_GROUPS");
}

export function checkedFundConsumption(value: unknown, binding: ServiceSourceBinding,
  batches: { id: string; status: string; schedulerTriggered?: boolean }[], expected: { id: string; modelMode: string }): TaskConsumption {
  if (!record(value) || value.protocol !== "shuduo-local-fund-agent-consumption/v1" ||
      value.taskId !== binding.taskId || value.releaseId !== binding.releaseId || value.packageDigest !== binding.packageDigest ||
      value.sourceKind !== "AGENT" || binding.sourceKind !== "AGENT" || value.scope !== "LOCAL_TEST_ONLY" || value.scope !== binding.scope ||
      value.outputContractId !== expected.id || !["PENDING", "VERIFIED"].includes(String(value.status)) ||
      typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) || typeof value.notice !== "string" ||
      value.agentIndependentE2E !== false || value.externalSystemVerified !== false || value.publicDeployed !== false ||
      !Array.isArray(value.services) || value.services.length > 20 ||
      !Number.isSafeInteger(value.matchingCount) || Number(value.matchingCount) < value.services.length ||
      value.truncated !== (Number(value.matchingCount) > value.services.length)) throw bad();
  const verified: { type: unknown; composition: boolean; batchId: unknown; versionId: unknown; children: unknown[] }[] = [];
  for (const entry of value.services) {
    if (!record(entry) || !id(entry.serviceId) || !id(entry.versionId) || !hash(entry.configHash) ||
        !["DAPI", "XAPI"].includes(String(entry.serviceType)) || !["PENDING", "VERIFIED", "NEEDS_ATTENTION"].includes(String(entry.status)) ||
        typeof entry.name !== "string" || typeof entry.notice !== "string" || entry.releaseId !== binding.releaseId ||
        entry.sourceKind !== "AGENT" || entry.agentIndependentE2E !== false || !Array.isArray(entry.sourceRunIds)) throw bad();
    if (entry.status !== "VERIFIED") continue;
    const [batchId] = entry.sourceRunIds, source = entry.source, call = entry.call, versions = entry.sourceVersions;
    const dapi = entry.serviceType === "DAPI";
    if (entry.sourceRunIds.length !== 1 || batchId === binding.runId ||
        !batches.some(batch => batch.id === batchId && batch.status === "SUCCEEDED" && batch.schedulerTriggered === true) ||
        !record(source) || source.revisionId !== binding.revisionId || source.developmentRunId !== binding.runId ||
        source.modelMode !== expected.modelMode || source.engineClassification !== "LOCAL_SPARK_PROCESS" || !hash(source.resultDigest) ||
        !Array.isArray(versions) || versions.length < (dapi ? 1 : 2) || versions.length > (dapi ? 1 : 5) ||
        versions.some(version => !record(version) || !id(version.versionId) || !id(version.serviceId) ||
          !hash(version.configHash) || !hash(version.snapshotHash) || !Array.isArray(version.fields)) ||
        dapi && versions[0].versionId !== entry.versionId ||
        !record(call) || !integer(call.rowCount, 1) || !checkedCall(call, entry, dapi) ||
        !Array.isArray(entry.checkedCalls) || entry.checkedCalls.length > 10 ||
        !entry.checkedCalls.every(value => checkedCall(value, entry, dapi)) ||
        new Set(entry.checkedCalls.map(value => value.callId)).size !== entry.checkedCalls.length ||
        !entry.checkedCalls.some(value => JSON.stringify(value) === JSON.stringify(call))) throw bad();
    const complete = !dapi && ["portfolio_id", "trade_date", "asset_class", "exposure_amount", "exposure_ratio"]
      .every(field => versions.some(version => version.fields.includes(field)));
    if (entry.fundExposureComposition !== complete) throw bad();
    verified.push({ type: entry.serviceType, composition: complete, batchId, versionId: entry.versionId,
      children: versions.map(version => version.versionId) });
  }
  if (new Set(value.services.map(entry => entry.serviceId)).size !== value.services.length ||
      value.status === "VERIFIED" && (value.truncated || !verified.some(xapi => xapi.composition && verified.some(dapi =>
        dapi.type === "DAPI" && dapi.batchId === xapi.batchId && xapi.children.includes(dapi.versionId))))) throw bad();
  return value as unknown as TaskConsumption;
}
