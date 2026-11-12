import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, referenceSql, contextIds } from "../../src/v2/context.mjs";
import { identityPositionMapping } from "../../src/v2/ingestion.mjs";
import { readSyncSqlInput } from "../../src/v2/sync-sql-input.mjs";
import { createDeliveryPackage, computeManifestDigest, loadDeliveryDirectory, resolveDeliverySchedule, sha256, validateDeliveryPackage } from "../../src/v2/delivery.mjs";

test("Agent binds a committed position snapshot across overwrite, retry and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-sync-sql-"));
  const fixtureRoot = join(root, "sources");
  mkdirSync(fixtureRoot);
  const positions = getContext().tables.find(table => table.name === "positions");
  const sample = (name, amount) => {
    const rows = structuredClone(positions.rows);
    rows[0][5] = amount;
    writeFileSync(join(fixtureRoot, name), [positions.columns.map(([name]) => name), ...rows].map(row => row.join(",")).join("\n"));
  };
  sample("first.csv", "1245.07");
  sample("later.csv", "4000.00");
  sample("bad.csv", "0.001");
  let modelCalls = 0, runs = 0, releaseCalls = 0, clock = Date.now(), base, app;
  let openModel;
  const modelGate = new Promise(resolve => { openModel = resolve; });
  const runner = async ({ context, validationContexts }) => {
    runs++;
    assert.equal(context.tables.find(table => table.name === "positions").rows[0][5], "1245.07");
    assert.equal(context.expected[0].total_assets, "2045.07");
    assert.equal(validationContexts[0].expected[0].total_assets, "1800.00");
    return { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", testDouble: true,
      rows: context.expected, validation: { passed: true } };
  };
  async function start() {
    app = createV2Server({ root, fixtureRoot, runner, now: () => clock, setTimer: () => ({}), clearTimer: () => {},
      env: { V2_LOCAL_DEVELOPMENT: "true", V2_RELEASE_SCHEDULER_MODE: "LOCAL_TIMER" },
      releaseRunner: async ({ directory, expectedDigest, scheduledFor, beforeRun }) => {
        const { bundle, plan } = loadDeliveryDirectory(directory, expectedDigest);
        beforeRun?.();
        releaseCalls++;
        return {
          status: "SUCCEEDED", mainSqlExecuted: true, engine: "Apache Spark", engineVersion: "3.5.9",
          mode: "LOCAL_FILE_REHEARSAL", published: false, schedulerTriggered: false,
          packageDigest: expectedDigest, source: plan.source, occurrence: resolveDeliverySchedule(plan, scheduledFor),
          fileHashes: Object.fromEntries(Object.entries(bundle.manifest.files).map(([name, file]) => [name, file.sha256])),
          testSqlValidation: { passed: true, sqlHash: sha256(bundle.files["tests.sql"]) },
          validation: JSON.parse(bundle.files["validation.json"]).report, rows: plan.fixtures.context.expected,
        };
      },
      generator: async ({ context }) => {
        modelCalls++;
        assert.equal(context.expected, undefined);
        assert.ok(context.tables.every(table => table.rows === undefined));
        await modelGate;
        return { sql: referenceSql, explanation: "虚构测试替身", usage: { total_tokens: 1 } };
      } });
    await new Promise((resolve, reject) => { app.server.once("error", reject); app.server.listen(0, "127.0.0.1", resolve); });
    base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  }
  async function stop() {
    if (!app) return;
    app.releaseScheduler.shutdown();
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    app.store.close();
    app = undefined;
  }
  async function request(path, body, key = "request", headers = {}) {
    const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", "X-Shuduo-Client": "workbench", "Idempotency-Key": key, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }
  async function finished(path) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { status, value } = await request(path);
      assert.equal(status, 200);
      if (!["QUEUED", "RUNNING"].includes(value.status)) return value;
      await pause(10);
    }
    assert.fail("Execution did not settle");
  }
  function sync(fileName) {
    const source = app.ingestion.createSource({ name: "虚构证券源 " + fileName, sourceType: "LOCAL_CSV", fileName });
    app.ingestion.testConnection(source.id);
    const metadata = app.ingestion.collectMetadata(source.id);
    const task = app.ingestion.createTask({ name: "虚构持仓同步 " + fileName, sourceId: source.id, targetTable: "raw_positions",
      mode: "FULL", mapping: identityPositionMapping, keyFields: ["position_id"] });
    return { run: app.ingestion.runTask(task.id), metadata };
  }
  try {
    await start();
    assert.equal((await request("/development/synced-positions")).status, 409);
    const first = sync("first.csv");
    const offer = await request("/development/synced-positions");
    assert.equal(offer.status, 200);
    assert.equal(offer.value.selection.runId, first.run.id);
    assert.equal(offer.value.metadataVersionId, first.metadata.id);
    assert.equal(offer.value.context, undefined);
    const body = { contextId: "holdings-t1", message: "按冻结持仓计算客户总资产", sql: "SELECT 1", syncInput: offer.value.selection };
    const requestId = "freeze-request";
    assert.equal((await request("/agent/tasks", { ...body, contextId: "stock-cash-t1" })).status, 422);
    const task = await request("/agent/tasks", body, requestId);
    assert.equal(task.status, 202);
    assert.equal(task.value.syncInput.rowCount, 4);
    assert.equal(task.value.mode, "SYNTHETIC_MODEL");
    assert.equal(task.value.syncInput.payload, undefined);
    const latest = sync("later.csv");
    assert.notEqual(latest.run.targetHash, first.run.targetHash);
    const replay = await request("/agent/tasks", body, requestId);
    assert.equal(replay.value.id, task.value.id);
    const stale = await request("/agent/tasks", body, "stale-request");
    assert.equal(stale.status, 409);
    assert.equal(stale.value.code, "SYNC_SQL_INPUT_STALE");
    assert.equal((await request("/agent/requests/stale-request")).status, 404);
    openModel();
    const completed = await finished(`/agent/tasks/${task.value.id}`);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.fullLifecycleE2E, false);
    assert.equal((await request(`/agent/tasks/${completed.id}/prepare-delivery`, {})).status, 409);
    const run = await finished(`/runs/${completed.runId}`);
    assert.deepEqual(run.syncInput, completed.syncInput);
    assert.equal(run.rows[0].total_assets, "2045.07");
    assert.equal(modelCalls, 1);
    assert.equal(runs, 1);
    await stop();
    await start();
    const recovered = await request(`/agent/requests/${requestId}`);
    assert.deepEqual(recovered.value.syncInput, completed.syncInput);
    const revision = await request("/revisions", { contextId: "holdings-t1", originAgentTaskId: completed.id, sql: referenceSql }, "manual");
    assert.equal(revision.status, 201);
    assert.deepEqual(revision.value.syncInput, run.syncInput);
    const manual = await request("/runs", { revisionId: revision.value.id }, "manual-run");
    assert.equal(manual.status, 202);
    const checked = await finished(`/runs/${manual.value.id}`);
    assert.equal(checked.rows[0].total_assets, "2045.07");
    assert.deepEqual(checked.syncInput, run.syncInput);
    const syncContext = readSyncSqlInput({ store: app.store, project: PROJECT, actorId: revision.value.author, binding: run.syncInput });
    const exampleReceipt = { ...checked, mainSqlExecuted: true, testDouble: false, validation: {
      ...checked.validation, selectedPassed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })),
    } };
    const deliverySource = { agent: completed, run: exampleReceipt, revision: revision.value, syncContext };
    assert.throws(() => createDeliveryPackage({ ...deliverySource, run: checked }), /真实本机运行/);
    assert.throws(() => createDeliveryPackage({ ...deliverySource, run: { ...exampleReceipt, rows: getContext().expected } }), /独立断言/);
    const bundle = createDeliveryPackage({ ...deliverySource, name: "客户资产 T+1" });
    assert.equal(bundle.manifest.name, "客户资产 T+1 · 冻结同步持仓");
    const plan = validateDeliveryPackage(bundle, bundle.digest);
    assert.equal(plan.source.syncInput.developmentMode, "MANUAL");
    assert.equal(plan.source.syncInput.runId, first.run.id);
    assert.equal(plan.fixtures.context.expected[0].total_assets, "2045.07");
    const changed = (name, text) => {
      const copy = structuredClone(bundle);
      copy.files[name] = text;
      copy.manifest.files[name] = { sha256: sha256(text), bytes: Buffer.byteLength(text) };
      copy.digest = computeManifestDigest(copy.manifest);
      return copy;
    };
    const wrongRows = changed("fixtures.json", JSON.stringify({ ...plan.fixtures, context: getContext() }));
    assert.throws(() => validateDeliveryPackage(wrongRows, wrongRows.digest), /独立预期不一致/);
    const noAssertions = changed("tests.sql", "SELECT true AS passed");
    assert.throws(() => validateDeliveryPackage(noAssertions, noAssertions.digest), /独立断言不一致/);
    const wrongCalendar = changed("calendar.json", JSON.stringify({ ...plan.calendar, tradingDays: ["2026-09-11", "2026-09-14"] }));
    assert.throws(() => validateDeliveryPackage(wrongCalendar, wrongCalendar.digest), /前一个交易日/);

    app.store.update("run", checked.id, PROJECT, exampleReceipt);
    const stored = (await request("/delivery/packages", { sourceRunId: checked.id })).value;
    assert.equal(stored.digest, bundle.digest);
    const packagePath = `/delivery/packages/${stored.id}`;
    const scheduledFor = "2026-09-11T09:00:00+08:00";
    const receipt = await request(packagePath + "/verify", { scheduledFor });
    assert.equal(receipt.status, 202);
    const verified = await finished(`/delivery/verifications/${receipt.value.id}`);
    assert.equal(verified.status, "SUCCEEDED");
    const reviewed = await request(packagePath + "/review", { packageDigest: stored.digest, verificationId: verified.id,
      reviewNote: "隔离环境的测试审阅", attestations: { code: true, assertions: true, deliveryFiles: true, localScope: true } });
    assert.equal(reviewed.status, 201);
    const scheduleSpec = { triggerAfterSeconds: 5, intervalSeconds: 45, runCount: 2 };
    const syncConsent = { scope: "LOCAL_TEST_RELEASE", packageDigest: stored.digest, verificationId: verified.id,
      businessDate: "2026-09-10", snapshotHash: run.syncInput.snapshotHash, scheduleSpec, confirmFrozenFictionalData: true };
    const approvalBody = { packageDigest: stored.digest, reviewId: reviewed.value.id, syncConsent };
    for (const replacement of [undefined, {...syncConsent, businessDate:"2026-09-11"}, {...syncConsent, snapshotHash:"0".repeat(64)}])
      assert.equal((await request(packagePath + "/approve", { ...approvalBody, syncConsent: replacement })).status, 409);
    const firstApproval = await request(packagePath + "/approve", approvalBody, "sync-approve-first");
    assert.equal(firstApproval.status, 201);
    clock = Date.parse(firstApproval.value.expiresAt);
    const expired = await request("/releases", { approvalId: firstApproval.value.id, ...scheduleSpec });
    assert.equal(expired.value.code, "SYNC_RELEASE_APPROVAL_EXPIRED");
    assert.equal(app.store.list("release_run", PROJECT).length, 0);
    const approval = await request(packagePath + "/approve", approvalBody, "sync-approve-renewed");
    assert.equal(approval.status, 201);
    assert.notEqual(approval.value.id, firstApproval.value.id);
    const releaseBody = { approvalId: approval.value.id, ...scheduleSpec };
    assert.equal((await request("/releases", { ...releaseBody, intervalSeconds: 1 })).status, 409);
    const activate = await request("/releases", releaseBody, "sync-activate");
    assert.equal(activate.status, 201);
    const replayRelease = await request("/releases", releaseBody, "sync-activate-lost-response");
    assert.equal(replayRelease.value.id, activate.value.id);
    const batches = app.store.list("release_run", PROJECT).sort((a, b) => a.sequence - b.sequence);
    assert.equal(batches.length, 2);
    assert.equal(releaseCalls, 1); // The stored rehearsal is the only file execution so far.
    clock = Date.parse(batches[0].scheduledTriggerAt);
    await app.releaseScheduler.enqueue(batches[0].id);
    await stop();
    await start();
    clock = Date.parse(approval.value.expiresAt) + 1000;
    await app.releaseScheduler.enqueue(batches[1].id);
    for (const batch of batches) {
      const actual = app.store.get("release_run", batch.id, PROJECT);
      assert.equal(actual.status, "SUCCEEDED");
      assert.equal(actual.schedulerTriggered, true);
      assert.equal(actual.snapshotHash, run.syncInput.snapshotHash);
      assert.equal(actual.rows[0].total_assets, "2045.07");
    }
    const observed = await request("/monitoring/overview");
    assert.equal(observed.value.activeRelease.health, "HEALTHY");
    assert.equal(observed.value.counts.succeeded, 2);
    const replayAfterExpiry = await request("/releases", releaseBody, "sync-activate-after-expiry");
    assert.equal(replayAfterExpiry.value.id, activate.value.id);
    assert.equal(releaseCalls, 3);
    const sources = await request("/data-services/sources");
    assert.deepEqual(sources.value.map(source => source.id), batches.map(batch => batch.id));
    const create = async (type, body) => {
      const created = await request(`/data-services/${type}s`, body, body.slug);
      assert.equal(created.status, 201, JSON.stringify(created.value));
      const path = `/data-services/${type}s/${created.value.id}`;
      assert.equal((await request(path + "/test", { pageSize: 1 })).status, 200);
      assert.equal((await request(path + "/publish", { configHash: created.value.currentVersion.configHash })).status, 200);
      return created.value;
    };
    const holdings = await create("dapi", { name:"冻结持仓查询", slug:"sync-holdings", sourceReleaseRunId:batches[0].id,
      fields:["client_id","holding_market_value","total_assets","security_count"] });
    const cash = await create("dapi", { name:"冻结现金查询", slug:"sync-cash", sourceReleaseRunId:batches[0].id, fields:["client_id","available_cash"] });
    const otherBatch = await create("dapi", { name:"第二批现金查询", slug:"sync-cash-second", sourceReleaseRunId:batches[1].id, fields:["client_id","available_cash"] });
    const parts = child => [{alias:"holdings",dapiId:holdings.id},{alias:"cash",dapiId:child.id}];
    const mixed = await request("/data-services/xapis", { name:"混批查询", slug:"sync-mixed", steps:parts(otherBatch) });
    assert.equal(mixed.value.code, "SYNC_SERVICE_MIXED_SOURCES");
    const xapi = await create("xapi", { name:"冻结客户资产查询", slug:"sync-assets", steps:parts(cash) });
    const issued = await request("/data-services/applications", {name:"冻结资产消费测试",serviceIds:[holdings.id,xapi.id]}, "sync-app");
    assert.equal(issued.status, 201);
    assert.equal(issued.value.application.versionGrants[xapi.id], xapi.currentVersion.id);
    const bearer = { Authorization: "Bearer " + issued.value.token };
    const checkedCall = await request("/open/xapis/sync-assets?page=1&page_size=1", undefined, undefined, bearer);
    assert.equal(checkedCall.status, 200);
    assert.equal(checkedCall.value.data[0].holdings.total_assets, "2045.07");
    assert.equal(checkedCall.value.pagination.total, 2);
    assert.equal((await request("/open/dapis/sync-cash", undefined, undefined, bearer)).status, 403);
    const otherEngineer = app.store.create("auth_user", PROJECT, {
      status: "ACTIVE", displayName: "另一测试工程师", email: "other-engineer@example.test",
      memberships: [{projectId:PROJECT, role:"ENGINEER"}],
    });
    const otherCookie = "fictional-other-engineer-session";
    app.store.create("auth_session", PROJECT, { userId:otherEngineer.id, tokenHash:sha256(otherCookie),
      status:"ACTIVE",expiresAt:new Date(clock+60000).toISOString() });
    const otherIdentity = { Cookie:"shuduo_session="+otherCookie };
    assert.deepEqual((await request("/data-services/sources", undefined, undefined, otherIdentity)).value, []);
    assert.equal((await request(`/data-services/xapis/${xapi.id}`, undefined, undefined, otherIdentity)).status, 403);
    const persisted = await app.dataServices.recheckCall(xapi.id, checkedCall.value.callId);
    assert.equal(persisted.independentResultVerified, true);
    const holdPath = `/data-services/dapis/${holdings.id}`;
    const replacement = await request(holdPath + "/versions", { sourceReleaseRunId: batches[0].id, rateLimitPerMinute: 20 }, "replace-frozen-dapi");
    assert.equal(replacement.status, 201);
    assert.equal((await request(holdPath + "/test", {})).status, 200);
    assert.equal((await request(holdPath + "/publish", { configHash: replacement.value.configHash })).status, 200);
    assert.equal((await request("/open/dapis/sync-holdings", undefined, undefined, bearer)).value.code, "SERVICE_VERSION_FORBIDDEN");
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 200);
    const originalBatch = app.store.get("release_run", batches[1].id, PROJECT);
    app.store.update("release_run", originalBatch.id, PROJECT, { snapshotHash:"0".repeat(64) });
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 409);
    app.store.update("release_run", originalBatch.id, PROJECT, { snapshotHash:originalBatch.snapshotHash });
    assert.equal((await request(`/data-services/applications/${issued.value.application.id}/revoke`, {})).status, 200);
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 401);
    const record = app.store.get("sync_sql_input", completed.syncInput.snapshotId, PROJECT);
    record.payload.context.expected[0].total_assets = "0.00";
    app.store.update("sync_sql_input", record.id, PROJECT, { payload: record.payload });
    assert.equal((await request("/runs", { revisionId: revision.value.id }, "tampered")).value.code, "SYNC_SQL_INPUT_CHANGED");
    assert.equal(sync("bad.csv").run.status, "SUCCEEDED");
    assert.equal((await request("/development/synced-positions")).status, 422);
    assert.equal(runs, 2);
    assert.equal(modelCalls, 1);
  } finally {
    openModel();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
