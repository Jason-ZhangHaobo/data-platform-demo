import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConsumerAcceptance } from "./verify-service-consumer.mjs";

const holdingsFields = ["client_id", "holding_market_value", "security_count"];
const cashFields = ["client_id", "available_cash", "total_assets"];

// The caller owns the disposable local project. Use its public product routes
// for setup, and a separate bearer-only HTTP client for the actual queries.
export async function verifyMysqlReleaseServices({base, api, taskId, releaseId, packageId, packageDigest, batchIds, expectedRows}) {
  const {origin} = new URL(base);
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/api\/v2$/);
  assert.equal(batchIds.length, 2);
  assert.equal(new Set(batchIds).size, 2);
  const selector = new URLSearchParams({agent_task_id:taskId, release_id:releaseId, package_digest:packageDigest});
  const sources = await api("/data-services/sources?"+selector, 200);
  assert.deepEqual(sources.map(item => item.id), batchIds);
  const bundle = await api("/delivery/packages/"+packageId, 200);
  assert.equal(bundle.digest, packageDigest);

  async function publish(type, body, source) {
    const collection = "/data-services/"+type+"s";
    const draft = await api(collection, 201, body, randomUUID());
    const path = collection+"/"+draft.id;
    const tested = await api(path+"/test", 200, {pageSize:1}, randomUUID());
    assert.equal(tested.test.status, "PASSED");
    assert.equal(tested.test.versionId, draft.currentVersion.id);
    const {service,version} = await api(path+"/publish", 200, {configHash:draft.currentVersion.configHash}, randomUUID());
    assert.equal(service.status, "PUBLISHED");
    assert.equal(service.publishedVersionId, draft.currentVersion.id);
    assert.equal(version.testId, tested.test.id);
    assert.deepEqual(version.sourceEvidence, source.sourceEvidence);
    return {id:service.id, slug:service.slug, versionId:version.id, configHash:version.configHash};
  }

  const directory = await mkdtemp(join(tmpdir(), "shuduo-mysql-consumer-"));
  const requests = [], versionIds = new Set(), revokedApps = new Set();
  try {
    for (const source of sources) {
      const batchId = source.id, sequence = source.sequence;
      assert.equal(source.scope, "LOCAL_TEST_ONLY");
      assert.equal(source.releaseId, releaseId);
      assert.equal(source.packageDigest, packageDigest);
      assert.equal(source.sourceEvidence.sourceReleaseRunId, batchId);
      assert.equal(source.sourceEvidence.syncRunId, bundle.manifest.source.syncInput.runId);
      assert.equal(source.sourceEvidence.snapshotHash, bundle.manifest.source.syncInput.snapshotHash);

      const holdings = await publish("dapi", {name:"虚构持仓市值查询 "+sequence, slug:"mysql-holdings-"+sequence,
        sourceReleaseRunId:batchId, fields:holdingsFields, rateLimitPerMinute:12, timeoutMs:3000}, source);
      const cash = await publish("dapi", {name:"虚构可用现金查询 "+sequence, slug:"mysql-cash-"+sequence,
        sourceReleaseRunId:batchId, fields:cashFields, rateLimitPerMinute:12, timeoutMs:3000}, source);
      const combined = await publish("xapi", {name:"虚构客户资产组合 "+sequence, slug:"mysql-assets-"+sequence,
        steps:[{alias:"holdings",dapiId:holdings.id,dapiVersionId:holdings.versionId},
          {alias:"cash",dapiId:cash.id,dapiVersionId:cash.versionId}], rateLimitPerMinute:6, timeoutMs:3000}, source);
      for (const service of [holdings,cash,combined]) versionIds.add(service.versionId);

      const sourceIdentity = {schema:"shuduo-service-consumer-source/v1", scope:"LOCAL_TEST_ONLY", sourceKind:"AGENT",
        taskId, revisionId:bundle.manifest.source.revisionId, revisionHash:bundle.manifest.source.sqlHash,
        developmentRunId:bundle.manifest.source.runId, contextId:bundle.manifest.source.contextId,
        validationContractId:bundle.manifest.source.validationContractId, packageDigest, releaseId, sourceReleaseRunId:batchId};
      const planFile = join(directory,"plan-"+sequence+".json"), tokenFile = join(directory,"token-"+sequence);
      const reportFile = join(directory,"report-"+sequence+".json");
      const now = Date.now();
      const plan = {protocol:"SERVICE_CONSUMER_V2", authorized:true, testOnly:true, origin, approvedOrigin:origin,
        source:sourceIdentity, startedAt:new Date(now).toISOString(), deadline:new Date(now+120000).toISOString(),
        timeoutMs:5000, maxRequests:15, expectedRows, reportFile,
        dapis:[{...holdings, alias:"holdings", fields:holdingsFields, granted:true},
          {...cash, alias:"cash", fields:cashFields, granted:false}], xapi:combined,
        ungranted:{type:"DAPI", slug:cash.slug}, rateLimit:{serviceId:combined.id, perMinute:6}};
      await writeFile(planFile, JSON.stringify(plan), {mode:0o600,flag:"wx"});
      const issued = await api("/data-services/applications", 201,
        {name:"虚构持仓只读验收应用 "+sequence, serviceIds:[holdings.id,combined.id]}, randomUUID());
      try {
        assert.deepEqual(issued.application.versionGrants, {[holdings.id]:holdings.versionId,[combined.id]:combined.versionId});
        const lifetime = Date.parse(issued.application.expiresAt)-Date.parse(issued.application.createdAt);
        assert.ok(lifetime > 0 && lifetime <= 3600000);
        await writeFile(tokenFile, issued.token, {mode:0o600,flag:"wx"});
        const consume = await runConsumerAcceptance({planFile,tokenFile,phase:"consume",execute:true});
        assert.equal(consume.result, "PASSED");
      } finally {
        const revoked = await api("/data-services/applications/"+issued.application.id+"/revoke", 200, {}, randomUUID());
        assert.equal(revoked.status, "REVOKED");
        revokedApps.add(revoked.id);
      }
      const done = await runConsumerAcceptance({planFile,tokenFile,phase:"revoked",execute:true});
      assert.deepEqual(done.phases, {consume:"PASSED",revoked:"PASSED"});
      assert.equal(done.requestCount, 15);
      requests.push(done.requestCount);
      await rm(tokenFile);

      const localReport = JSON.parse(await readFile(reportFile,"utf8"));
      const logs = await api("/data-services/calls", 200);
      const byDigest = new Map(logs.map(log => [createHash("sha256").update(log.id).digest("hex"), log]));
      for (const query of localReport.requests.filter(row => row.statusCode === 200)) {
        const saved = byDigest.get(query.callIdDigest);
        assert.ok(saved);
        assert.equal(saved.applicationId, issued.application.id);
        assert.equal(saved.serviceId, query.serviceId);
        assert.equal(saved.serviceVersionId, query.versionId);
        assert.equal(saved.resultHash, query.rowsDigest);
        assert.equal(saved.rowCount, query.rowCount);
      }
      const selected = new URLSearchParams(selector);
      selected.set("release_batch_id",batchId);
      const evidence = await api("/data-services/task-evidence?"+selected, 200);
      assert.equal(evidence.status, "VERIFIED");
      assert.deepEqual(evidence.verifiedBatchIds, [batchId]);
      assert.equal(evidence.monitoring.sequence, sequence);
      for (const service of [holdings,combined]) {
        const entry = evidence.services.find(item => item.serviceId === service.id && item.versionId === service.versionId);
        assert.equal(entry?.status, "VERIFIED");
        assert.deepEqual(entry.source, sourceIdentity);
        assert.deepEqual(entry.sourceRunIds, [batchId]);
        assert.equal(entry.call.independentResultVerified, true);
        assert.equal(entry.call.applicationStatus, "REVOKED");
        assert.deepEqual(entry.paginationCoverage, {status:"COMPLETE", applicationId:issued.application.id,
          pageSize:1, totalPages:2, verifiedPages:[1,2]});
      }
    }
    const both = await api("/data-services/task-evidence?"+selector, 200);
    assert.equal(both.status, "VERIFIED");
    assert.deepEqual(new Set(both.verifiedBatchIds), new Set(batchIds));
    assert.equal(versionIds.size, 6);
    assert.equal(revokedApps.size, 2);
    return {serviceVersions:versionIds.size, verifiedConsumptionBatches:both.verifiedBatchIds.length,
      consumerRequestsPerBatch:requests, verifiedPagesPerService:2, revokedFixtureApplications:revokedApps.size,
      independentHttpScope:"LOCAL_TEST_ONLY"};
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
}
