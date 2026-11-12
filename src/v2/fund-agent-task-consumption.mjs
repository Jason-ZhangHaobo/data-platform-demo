import { isDeepStrictEqual as same } from "node:util";
import { consumerDigest } from "./consumer-source.mjs";
import { serviceVersionConfigValid } from "./data-services.mjs";
import { fundAgentServiceSources } from "./fund-consumption-source.mjs";
import { fundDapiContract } from "./fund-dapi-contract.mjs";
import { distributionComposition } from "./distribution-services.mjs";

const invalid = () => Object.assign(new Error("基金 Agent 的原批次、固定接口版本或历史调用未确认"), {
  status: 409, code: "FUND_AGENT_CONSUMPTION_UNCONFIRMED",
});

export async function fundAgentTaskConsumption({ store, project, agent, packageDigest, releaseId, callIdDigest, manager, timeUnitMs, batchId, fundSignedExecutionFor }) {
  const selection = { taskId: agent.id, packageDigest, releaseId };
  const sources = () => fundAgentServiceSources({ store, project, selection, timeUnitMs, fundSignedExecutionFor });
  const original = sources();
  if (original.length !== 2) throw invalid();
  const byBatch = new Map(original.filter(run => batchId === undefined || run.id === batchId).map(run => [run.id, run.sourceEvidence]));
  if (!byBatch.size) throw invalid();
  const services = [];
  let matchingCount = 0;
  for (const service of manager.list()) {
    const logs = manager.listCalls(service.id).filter(call => call.outcome === "SUCCEEDED" && call.statusCode === 200);
    const exact = callIdDigest && logs.find(call => consumerDigest(call.id) === callIdDigest);
    if (callIdDigest && !exact) continue;
    const candidates = exact ? service.versions.filter(version => version.id === exact.serviceVersionId) :
      [service.publishedVersion, ...service.versions.filter(version => version.id !== service.publishedVersionId && version.status === "RETIRED")];
    const childrenFor = version => version.serviceType === "DAPI" ? [version] :
      (version.steps ?? []).map(step => store.get("data_service_version", step.dapiVersionId, project));
    const scoped = candidates.filter(value => value?.outputContractId === fundDapiContract.id &&
      childrenFor(value).some(child => child?.sourcePackageDigest === packageDigest && byBatch.has(child.sourceReleaseRunId)));
    const version = scoped.find(value => logs.some(call => call.serviceVersionId === value.id)) ?? scoped[0];
    if (!version) continue;
    matchingCount++;
    if (services.length >= 20) continue;
    const entry = { serviceId: service.id, serviceType: service.serviceType, name: service.name, versionId: version.id,
      configHash: version.configHash, status: "PENDING", sourceRunIds: [], releaseId, sourceKind: "AGENT",
      agentIndependentE2E: false, fundExposureComposition: false, notice: "等待这一个固定版本的非空授权调用。" };
    try {
      const children = childrenFor(version), batchId = children[0]?.sourceReleaseRunId, evidence = byBatch.get(batchId);
      if (!evidence || !serviceVersionConfigValid(version) || version.scope !== "LOCAL_TEST_ONLY" ||
          version.serviceType !== service.serviceType || children.some(child => !child || !serviceVersionConfigValid(child) ||
            child.outputContractId !== fundDapiContract.id || child.sourceReleaseRunId !== batchId ||
            child.sourceReleaseId !== releaseId || child.sourcePackageDigest !== packageDigest ||
            !same(child.sourceEvidence, evidence)) ||
          version.serviceType === "XAPI" && (children.length < 2 || children.some((child, i) => child.serviceId !== version.steps[i].dapiId))) throw invalid();
      if (version.serviceType === "XAPI" && !same(distributionComposition(children, version.steps),
        Object.fromEntries(["sourceEvidence", "outputContractId", "composition", "groupKeys", "joinKeys"].map(key => [key, version[key]])))) throw invalid();
      entry.sourceRunIds = [batchId];
      entry.source = { revisionId: evidence.revisionId, developmentRunId: evidence.developmentRunId,
        modelMode: evidence.modelMode, engineClassification: evidence.engineClassification, resultDigest: evidence.resultDigest };
      entry.sourceVersions = children.map(child => ({ serviceId: child.serviceId, versionId: child.id,
        configHash: child.configHash, snapshotHash: child.snapshotHash, fields: child.fields }));
      entry.fundExposureComposition = version.serviceType === "XAPI" &&
        fundDapiContract.fields.every(field => children.some(child => child.fields.includes(field.name)));
      const matching = (exact ? [exact] : logs.filter(call => call.serviceVersionId === version.id))
        .sort((left, right) => String(right.finishedAt).localeCompare(String(left.finishedAt)));
      if (matching.length > 10) throw invalid();
      entry.checkedCalls = [];
      for (const call of matching) {
        const proof = await manager.recheckFundCall(service.id, call.id);
        if (!proof.verified || !proof.independentResultVerified) throw invalid();
        const app = manager.application(call.applicationId);
        entry.checkedCalls.push({ ...proof, applicationId: app.id, applicationStatus: app.status, finishedAt: call.finishedAt,
          page: call.parameters.page, pageSize: call.parameters.pageSize });
      }
      entry.call = entry.checkedCalls.find(call => call.rowCount > 0);
      if (entry.call) {
        entry.status = "VERIFIED";
        entry.notice = "原授权调用的分页结果、固定版本和独立基金预期一致。";
      }
    } catch (error) {
      if (![400, 403, 404, 409, 422, 504].includes(error.status)) throw error;
      delete entry.call;
      delete entry.checkedCalls;
      entry.status = "NEEDS_ATTENTION";
      entry.notice = "原调用的结果、版本或授权未确认。";
    }
    services.push(entry);
  }
  if (!same(sources(), original)) throw invalid();
  const truncated = matchingCount > services.length;
  const complete = !truncated && services.some(entry => entry.status === "VERIFIED" && entry.fundExposureComposition &&
    services.some(dapi => dapi.serviceType === "DAPI" && dapi.status === "VERIFIED" &&
      dapi.sourceRunIds[0] === entry.sourceRunIds[0] && entry.sourceVersions.some(child => child.versionId === dapi.versionId)));
  return { protocol: "shuduo-local-fund-agent-consumption/v1", scope: "LOCAL_TEST_ONLY", taskId: agent.id,
    releaseId, packageDigest, ...(batchId ? { batchId } : {}), sourceKind: "AGENT", outputContractId: fundDapiContract.id, status: complete ? "VERIFIED" : "PENDING",
    checkedAt: new Date().toISOString(), matchingCount, truncated, services,
    publicDeployed: false, externalSystemVerified: false, agentIndependentE2E: false,
    notice: "历史消费仅核对原批次的固定版本和调用结果。凭证状态以本次读取为准。" };
}
