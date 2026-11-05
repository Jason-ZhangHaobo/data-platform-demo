import assert from "node:assert/strict";
import { createManualPublicationJourney } from "./manual-publication-journey.mjs";
import { BusinessQueryStore } from "../../../src/v2/data-services.mjs";
import { createPrivateDataServices } from "../../../src/v2/private-data-services.mjs";
import { saveManualRevision } from "../../../src/v2/manual-revisions.mjs";
import { createDeliveryPackage, sha256 } from "../../../src/v2/delivery.mjs";
import { PROJECT } from "../../../src/v2/server.mjs";

// UI/HTTP acceptance fixture, not a deployment. Only signed synthetic queue
// receipts are used. Service queries really execute against in-memory SQLite.
// Setup services through an explicit fixture adapter: the displayed HTTP app
// remains PUBLICATION_ONLY and cannot create a service or issue a credential.
export async function createManualServiceJourney({ applicationRoot, port = 0 } = {}) {
  const businessStore = new BusinessQueryStore(":memory:");
  let f, disposed = false, setupRequests = 0;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try { await f?.dispose(); } finally { businessStore.close(); }
  };
  try {
    f = await createManualPublicationJourney({ applicationRoot, port, businessStore, enableServices: true });
    const originalAgent = structuredClone(f.store.get("agent", f.agent.id, PROJECT));
    const published = await f.call(f.path, f.body);
    assert.equal(published.status, 202);
    const releaseId = published.body.release.id;
    let publication;
    for (const sequence of [1, 2]) {
      if (sequence === 2) f.advance();
      assert.equal((await f.tick(releaseId, sequence)).status, 200);
      const run = f.store.list("release_run", PROJECT).find(run => run.releaseId === releaseId && run.sequence === sequence);
      assert.equal(run.status, "RUNNING");
      f.complete(run.remoteSubmission.prepared);
      const read = await f.call(f.path + f.query);
      assert.equal(read.status, 200); publication = read.body;
    }
    assert.equal(publication.release.status, "COMPLETED_CLOUD_TEST");
    assert.equal(publication.release.health, "HEALTHY");
    const sourceReleaseRunId = publication.runs.find(run => run.sequence === 1).id;
    const adapter = createPrivateDataServices({ store: f.store, businessStore, project: PROJECT,
      auth: { sessionFromHeaders: () => ({ role: "ADMIN", user: { id: f.owner.id } }), requireMutation: () => {} } });
    const setup = async (path, body, headers = {}) => {
      setupRequests++;
      return adapter.handle({ method: body === undefined ? "GET" : "POST",
        headers: { "idempotency-key": `synthetic-service-setup-${setupRequests}`, ...headers } },
      new URL(`/api/v2${path}`, "http://127.0.0.1"), async () => body);
    };
    const dapi = async (slug, sourceId, fields) => {
      const made = await setup("/data-services/dapis", { name: slug, slug, sourceReleaseRunId: sourceId, fields, rateLimitPerMinute: 30 });
      assert.equal(made.status, 201);
      assert.equal((await setup(`/data-services/dapis/${made.body.id}/test`, {})).status, 200);
      const result = await setup(`/data-services/dapis/${made.body.id}/publish`, { configHash: made.body.currentVersion.configHash });
      assert.equal(result.status, 200); return result.body.service;
    };
    const holdings = await dapi("manual-selected-holdings", sourceReleaseRunId, ["client_id", "holding_market_value", "security_count"]);
    const cash = await dapi("manual-selected-cash", sourceReleaseRunId, ["client_id", "available_cash", "total_assets"]);
    const composed = await setup("/data-services/xapis", { name: "指定人工版本股票与现金", slug: "manual-selected-overview", rateLimitPerMinute: 8,
      steps: [{ alias: "holdings", dapiId: holdings.id, dapiVersionId: holdings.publishedVersionId },
        { alias: "cash", dapiId: cash.id, dapiVersionId: cash.publishedVersionId }] });
    assert.equal(composed.status, 201);
    assert.equal((await setup(`/data-services/xapis/${composed.body.id}/test`, {})).status, 200);
    const xapi = (await setup(`/data-services/xapis/${composed.body.id}/publish`, { configHash: composed.body.currentVersion.configHash })).body.service;
    const issued = await setup("/data-services/applications", { name: "合成人工消费一次性应用", serviceIds: [holdings.id, xapi.id] });
    assert.equal(issued.status, 201); assert.equal(issued.body.application.createdBy, f.owner.id);
    const consumed = await setup(`/open/xapis/${xapi.slug}?client_id=CLIENT-001`, undefined, { authorization: `Bearer ${issued.body.token}` });
    assert.equal(consumed.status, 200);
    assert.deepEqual(consumed.body.data, [{ client_id: "CLIENT-001", holdings: { holding_market_value: "1000.00", security_count: 1 },
      cash: { available_cash: "300.00", total_assets: "1300.00" } }]);
    const revoked = await setup(`/data-services/applications/${issued.body.application.id}/revoke`, {});
    assert.equal(revoked.body.status, "REVOKED");
    // The one synthetic token is never returned to the UI fixture caller.
    issued.body.token = undefined;

    // A newer-looking, different manual package of the SAME failed origin task.
    // This is stored synthetic history, not an extra timer or compute execution.
    const revision = saveManualRevision({ store: f.store, project: PROJECT, actor: f.owner.id, key: "synthetic-distractor-manual",
      sql: f.revision.sql + "\n-- unrelated synthetic historical version", contextId: f.revision.contextId, originAgentTaskId: f.agent.id }).revision;
    const sourceRun = f.store.create("run", PROJECT, { ...f.sourceRun, id: undefined, revisionId: revision.id, revisionHash: revision.hash });
    const bundle = f.store.create("delivery_package", PROJECT, { ...createDeliveryPackage({ run: sourceRun, revision }),
      sourceKind: "MANUAL", sourceRunId: sourceRun.id, agentIndependentE2E: false });
    const attribution = { sourceKind: "MANUAL", sourceAttribution: "ENGINEER_ASSISTED", sourceRunId: sourceRun.id,
      agentIndependentE2E: false, submittedBy: f.owner.id };
    const approval = f.store.create("release_approval", PROJECT, { ...attribution, status: "APPROVED", packageId: bundle.id,
      packageDigest: bundle.digest, sourceRevisionId: revision.id, sourceCodeHash: revision.hash });
    const release = f.store.create("release", PROJECT, { ...attribution, mode: "DURABLE_PRIVATE_RELEASE_V1", scope: "PRIVATE_CLOUD_TEST",
      sourceAgentTaskId: f.agent.id, sourceRevisionId: revision.id, sourceCodeHash: revision.hash, packageId: bundle.id, packageDigest: bundle.digest,
      approvalId: approval.id, status: "COMPLETED_CLOUD_TEST", health: "HEALTHY", publicDeployed: false });
    const releaseRun = f.store.create("release_run", PROJECT, { ...attribution, mode: release.mode, scope: release.scope, sourceAgentTaskId: f.agent.id,
      releaseId: release.id, packageId: bundle.id, packageDigest: bundle.digest, status: "SUCCEEDED", published: true, publicDeployed: false,
      schedulerTriggered: true, clockMode: "FC_TIMER", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
      testSqlValidation: { passed: true, sqlHash: sha256(bundle.files["tests.sql"]) }, validation: sourceRun.validation, rows: sourceRun.rows, sequence: 1,
      createdAt: new Date(Date.now() + 300000).toISOString() });
    const otherService = await dapi("manual-other-package-history", releaseRun.id, ["client_id", "total_assets"]);
    assert.deepEqual(f.store.get("agent", f.agent.id, PROJECT), originalAgent);
    const serviceIds = { holdings: holdings.id, cash: cash.id, xapi: xapi.id };
    const selection = new URLSearchParams({ agent_task_id: f.agent.id, package_digest: f.item.digest, release_id: releaseId }).toString();
    return { ...f, publicationFixture: f, businessStore, originalAgent, publication, releaseId, sourceReleaseRunId, serviceIds,
      services: { holdings, cash, xapi }, callId: consumed.body.callId, applicationId: issued.body.application.id,
      distractor: { revision, sourceRun, bundle, release, releaseRun, service: otherService }, selection,
      sourcesPath: `/data-services/sources?${selection}`, evidencePath: `/data-services/task-evidence?${selection}`,
      counts: () => ({ ...f.counts(), setupRequests, services: f.store.list("data_service", PROJECT).length,
        applications: f.store.list("service_app", PROJECT).length, serviceCalls: f.store.list("service_call", PROJECT).length,
        realModelCalls: 0, realSparkRuns: 0, realCloudCalls: 0 }),
      get base() { return f.base; }, get store() { return f.store; }, get manualUrl() { return f.manualUrl; },
      get url() { return `${f.base}/v2/?module=agent-center&task=${f.agent.id}`; },
      dispose };
  } catch (error) { await dispose(); throw error; }
}
