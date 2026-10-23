import { serviceVersionConfigValid } from "./data-services.mjs";

const assetFields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
// Private, owner-authorized projection of persisted calls. No tokens, rows,
// parameters, rematerialization, model invocation or new consumer calls.
export async function privateTaskConsumption({ taskId, packageDigest, services, ownedService, getVersion, source, getRelease, application, calls, recheckCall, scope = "PRIVATE_CLOUD_TEST" }) {
  if (!["PRIVATE_CLOUD_TEST", "LOCAL_TEST_ONLY"].includes(scope)) throw new Error("Unsupported consumption scope");
  const entries = [], limit = 20;
  let matchingCount = 0;
  for (const service of services) {
    const root = service.publishedVersion;
    if (!root || service.status !== "PUBLISHED") continue;
    let children;
    try {
      children = root.serviceType === "XAPI" ? (root.steps ?? []).map(step => {
        ownedService(step.dapiId);
        const child = getVersion(step.dapiVersionId);
        return child?.serviceId === step.dapiId ? child : undefined;
      }) : [root];
    } catch (error) { if ([403,404].includes(error.status)) continue; throw error; }
    const related = children.filter(Boolean).some(v => {
      const release = getRelease(v.sourceReleaseId);
      return release?.sourceAgentTaskId === taskId && v.sourcePackageDigest === packageDigest;
    });
    if (!related) continue;
    matchingCount++;
    if (entries.length >= limit) continue;
    const entry = { serviceId: service.id, serviceType: service.serviceType, name: service.name,
      versionId: root.id, configHash: root.configHash, status: "PENDING", sourceRunIds: [],
      notice: "尚无当前发布版本的成功授权调用；测试或打开模块不算消费。" };
    try {
      if (!serviceVersionConfigValid(root) || !children.length || children.some(v => !v || !serviceVersionConfigValid(v))) throw Object.assign(new Error(), {status:409, code:"SERVICE_VERSION_CORRUPT"});
      const sources = children.map(v => {
        const run = source(v.sourceReleaseRunId), release = getRelease(run.releaseId);
        if (release?.sourceAgentTaskId !== taskId || run.packageDigest !== packageDigest || v.sourcePackageDigest !== packageDigest || v.sourceReleaseId !== release.id)
          throw Object.assign(new Error(), {status:409, code:"MIXED_SOURCE_VERSIONS"});
        return run.id;
      });
      if (root.serviceType === "XAPI" && new Set(sources).size !== 1) throw Object.assign(new Error(), {status:409, code:"MIXED_SOURCE_VERSIONS"});
      entry.sourceRunIds = [...new Set(sources)];
      const fields = new Set(children.flatMap(v => v.fields ?? []));
      entry.fullAssetComposition = root.serviceType === "XAPI" && assetFields.every(field => fields.has(field));
      const successful = calls(service.id).filter(c => c.serviceVersionId === root.id && c.outcome === "SUCCEEDED" && c.statusCode === 200 && c.rowCount > 0).sort((a,b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
      const call = successful.find(c => {
        const app = application(c.applicationId);
        return app?.scope === scope && app.serviceIds?.includes(service.id) && ["ACTIVE", "REVOKED"].includes(app.status);
      });
      if (call) {
        const proof = await recheckCall(service.id, call.id);
        entry.status = proof.verified ? "VERIFIED" : "NEEDS_ATTENTION";
        entry.code = proof.verified ? "OK" : "CONSUMPTION_RESULT_MISMATCH";
        entry.call = { ...proof, applicationId: call.applicationId, applicationStatus: application(call.applicationId).status, finishedAt: call.finishedAt };
        entry.notice = proof.verified ? "历史授权调用结果与当前不可变快照对照通过；不表示应用现在仍获授权。" : "持久调用结果与当前快照不一致。";
      }
    } catch (error) {
      if (![400,403,404,409,422,504].includes(error.status)) throw error;
      entry.status = "NEEDS_ATTENTION"; entry.code = error.code ?? "CONSUMPTION_EVIDENCE_UNAVAILABLE";
      entry.notice = "来源、固定版本、快照或调用证据未通过，不能标记完成。";
    }
    entries.push(entry);
  }
  const truncated = matchingCount > limit;
  const verified = !truncated && entries.some(e => e.status === "VERIFIED" && e.fullAssetComposition === true);
  return { protocol: scope === "LOCAL_TEST_ONLY" ? "shuduo-local-task-consumption/v1" : "shuduo-private-task-consumption/v1", taskId, packageDigest,
    scope, status: verified ? "VERIFIED" : "PENDING", checkedAt: new Date().toISOString(),
    services: entries, matchingCount, truncated, publicDeployed: false, externalSystemVerified: false, agentIndependentE2E: false,
    notice: "持久授权调用与现有快照的只读对照；不新增调用、不消耗限流，不等同外部客户端独立断言或自主E2E验收。" };
}
