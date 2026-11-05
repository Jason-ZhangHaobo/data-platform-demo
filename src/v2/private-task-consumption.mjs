import { serviceVersionConfigValid } from "./data-services.mjs";
import {validateDeliveryPackage} from "./delivery.mjs";
import {validateConsumerSource} from "./consumer-source.mjs";

const assetFields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
// Private, owner-authorized projection of persisted calls. No tokens, rows,
// parameters, rematerialization, model invocation or new consumer calls.
export async function privateTaskConsumption({ taskId, packageDigest, releaseId, services, ownedService, getVersion, source, getRelease, getPackage, application, calls, recheckCall, scope = "PRIVATE_CLOUD_TEST" }) {
  if (!["PRIVATE_CLOUD_TEST", "LOCAL_TEST_ONLY"].includes(scope)) throw new Error("Unsupported consumption scope");
  const entries = [], limit = 20;
  const selectedRelease=releaseId===undefined?undefined:getRelease(releaseId);
  const selectedMatches=releaseId===undefined||selectedRelease?.id===releaseId&&selectedRelease.sourceAgentTaskId===taskId&&selectedRelease.packageDigest===packageDigest;
  const attribution=release=>({sourceKind:release.sourceKind??"AGENT",
    ...(release.sourceKind==="MANUAL"?{sourceAttribution:"ENGINEER_ASSISTED"}:{}),agentIndependentE2E:false});
  let matchingCount = 0;
  for (const service of services) {
    const root = service.publishedVersion;
    if (!root || service.status !== "PUBLISHED") continue;
    let children;
    try {
      children = root.serviceType === "XAPI" ? (Array.isArray(root.steps) ? root.steps.slice(0,5) : []).map(step => {
        ownedService(step.dapiId);
        const child = getVersion(step.dapiVersionId);
        return child?.serviceId === step.dapiId ? child : undefined;
      }) : [root];
    } catch (error) { if ([403,404].includes(error.status)) continue; throw error; }
    const related = children.filter(Boolean).some(v => {
      const release = getRelease(v.sourceReleaseId);
      return selectedMatches && release?.sourceAgentTaskId === taskId && v.sourcePackageDigest === packageDigest &&
        (releaseId===undefined||release.id===releaseId);
    });
    if (!related) continue;
    matchingCount++;
    if (entries.length >= limit) continue;
    const entry = { serviceId: service.id, serviceType: service.serviceType, name: service.name,
      versionId: root.id, configHash: root.configHash, status: "PENDING", sourceRunIds: [],
      notice: "尚无当前发布版本的成功授权调用；测试或打开模块不算消费。" };
    try {
      if (!serviceVersionConfigValid(root) || !children.length || root.serviceType==="XAPI"&&(!Array.isArray(root.steps)||root.steps.length<2||root.steps.length>5) ||
          children.some(v => !v || !serviceVersionConfigValid(v) || !Array.isArray(v.fields) || v.fields.length>assetFields.length ||
            new Set(v.fields).size!==v.fields.length || v.fields.some(field=>!assetFields.includes(field)))) throw Object.assign(new Error(), {status:409, code:"SERVICE_VERSION_CORRUPT"});
      const sourceReleases=[],sourceRuns=[];
      const sources = children.map(v => {
        const run = source(v.sourceReleaseRunId), release = getRelease(run.releaseId);
        if (release?.sourceAgentTaskId !== taskId || run.packageDigest !== packageDigest || v.sourcePackageDigest !== packageDigest || v.sourceReleaseId !== release.id ||
          (releaseId!==undefined&&release.id!==releaseId))
          throw Object.assign(new Error(), {status:409, code:"MIXED_SOURCE_VERSIONS"});
        sourceReleases.push(release);
        sourceRuns.push(run);
        return run.id;
      });
      if (new Set(sourceReleases.map(release=>release.id)).size!==1||root.serviceType === "XAPI" && new Set(sources).size !== 1)
        throw Object.assign(new Error(), {status:409, code:"MIXED_SOURCE_VERSIONS"});
      entry.sourceRunIds = [...new Set(sources)];
      Object.assign(entry,attribution(sourceReleases[0]),{releaseId:sourceReleases[0].id});
      if(typeof getPackage==='function'){
        try{
          const run=sourceRuns[0],release=sourceReleases[0],bundle=getPackage(run.packageId),origin=validateDeliveryPackage(bundle,packageDigest).source,
            sourceKind=release.sourceKind??'AGENT';
          if(bundle.id!==release.packageId||bundle.digest!==packageDigest||release.sourceAgentTaskId!==taskId||
            origin.projectId!==bundle.projectId||bundle.projectId!==run.projectId||run.projectId!==release.projectId||
            release.sourceRevisionId!==undefined&&release.sourceRevisionId!==origin.revisionId||
            (release.sourceCodeHash??release.sourceSqlHash)!==undefined&&(release.sourceCodeHash??release.sourceSqlHash)!==origin.sqlHash||
            sourceKind==='AGENT'&&origin.attribution!==undefined||sourceKind==='MANUAL'&&
              (origin.attribution?.kind!=='ENGINEER_ASSISTED'||origin.attribution.originAgentTaskId!==taskId||origin.attribution.agentIndependentE2E!==false))throw Error('UNBOUND_SOURCE');
          entry.source=validateConsumerSource({schema:'shuduo-service-consumer-source/v1',scope,sourceKind,taskId,
            revisionId:origin.revisionId,revisionHash:origin.sqlHash,developmentRunId:origin.runId,contextId:origin.contextId,
            validationContractId:origin.validationContractId,packageDigest,releaseId:release.id,sourceReleaseRunId:run.id});
        }catch{throw Object.assign(new Error(),{status:409,code:'CONSUMER_SOURCE_IDENTITY_UNAVAILABLE'});}
      }
      // Bounded immutable child references, not data rows or query parameters.
      // Consumers can independently check the exact versions and release batch
      // instead of trusting a top-level VERIFIED label or composition boolean.
      entry.sourceVersions = children.map((version,index)=>({serviceId:version.serviceId,versionId:version.id,configHash:version.configHash,
        releaseId:sourceReleases[index].id,sourceReleaseRunId:sources[index],packageDigest:version.sourcePackageDigest,
        sourceKind:sourceReleases[index].sourceKind??"AGENT",fields:assetFields.filter(field=>version.fields.includes(field))}));
      const fields = new Set(children.flatMap(v => v.fields ?? []));
      entry.fullAssetComposition = root.serviceType === "XAPI" && assetFields.every(field => fields.has(field));
      const successful = calls(service.id).filter(c => c.serviceVersionId === root.id && c.outcome === "SUCCEEDED" && c.statusCode === 200 && c.rowCount > 0).sort((a,b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
      const call = successful.find(c => {
        const app = application(c.applicationId);
        return app?.scope === scope && app.serviceIds?.includes(service.id) && ["ACTIVE", "REVOKED", "EXPIRED"].includes(app.status);
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
  const sourceKinds=[...new Set(entries.map(entry=>entry.sourceKind).filter(Boolean))];
  const sourceMetadata=selectedMatches&&selectedRelease?attribution(selectedRelease):sourceKinds.length===1?
    {sourceKind:sourceKinds[0],...(sourceKinds[0]==="MANUAL"?{sourceAttribution:"ENGINEER_ASSISTED"}:{})}:{};
  return { protocol: scope === "LOCAL_TEST_ONLY" ? "shuduo-local-task-consumption/v1" : "shuduo-private-task-consumption/v1", taskId, packageDigest,
    ...(releaseId===undefined?{}:{releaseId}),...sourceMetadata,
    scope, status: verified ? "VERIFIED" : "PENDING", checkedAt: new Date().toISOString(),
    services: entries, matchingCount, truncated, publicDeployed: false, externalSystemVerified: false, agentIndependentE2E: false,
    notice: "持久授权调用与现有快照的只读对照；不新增调用、不消耗限流，不等同外部客户端独立断言或自主E2E验收。" };
}
