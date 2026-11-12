import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, referenceSql, contextIds } from "../../src/v2/context.mjs";
import { identityPositionMapping } from "../../src/v2/ingestion.mjs";
import { readSyncSqlInput, syncSqlOutputSchemaDetails } from "../../src/v2/sync-sql-input.mjs";
import { checkedSyncSqlOutputSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { verifySavedSyncSqlInput } from "../../src/v2/sync-sql-saved-lifecycle.mjs";
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
  const columns = [
    {name:"client_id",type:"string"}, {name:"holding_market_value",type:"decimal(18,2)"},
    {name:"available_cash",type:"decimal(18,2)"}, {name:"total_assets",type:"decimal(18,2)"},
    {name:"security_count",type:"bigint"},
  ];
  const wrongColumns = columns.map(column => column.name === "total_assets" ? { ...column, type:"string" } : column);
  let modelCalls = 0, runs = 0, releaseCalls = 0, clock = Date.now(), base, app;
  let developmentColumns = columns, rehearsalColumns = columns;
  let openModel;
  const modelGate = new Promise(resolve => { openModel = resolve; });
  const runner = async ({ context, validationContexts }) => {
    runs++;
    assert.equal(context.tables.find(table => table.name === "positions").rows[0][5], "1245.07");
    assert.equal(context.expected[0].total_assets, "2045.07");
    assert.equal(validationContexts[0].expected[0].total_assets, "1800.00");
    return { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", testDouble: true, mainSqlExecuted: true,
      rows: context.expected, columns: developmentColumns, validation: { passed: true } };
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
          validation: JSON.parse(bundle.files["validation.json"]).report, rows: plan.fixtures.context.expected, columns: rehearsalColumns,
        };
      },
      generator: async ({ context, outputColumns }) => {
        modelCalls++;
        assert.equal(context.expected, undefined);
        assert.ok(context.tables.every(table => table.rows === undefined));
        assert.deepEqual(outputColumns, columns);
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
    developmentColumns = wrongColumns;
    const drifted = await request("/runs", { revisionId: revision.value.id }, "manual-schema-drift");
    const failedDevelopment = await finished(`/runs/${drifted.value.id}`);
    assert.equal(failedDevelopment.status, "VALIDATION_FAILED");
    assert.equal(failedDevelopment.code, "SYNC_SQL_OUTPUT_SCHEMA_MISMATCH");
    assert.equal(failedDevelopment.rows[0].total_assets, "2045.07");
    const schemaPath = `/runs/${failedDevelopment.id}/output-schema`;
    const schema = failedDevelopment.syncOutputSchema;
    assert.equal(schema.status, "MISMATCH");
    assert.deepEqual(schema.differences, [{
      expected:{name:"total_assets",type:"decimal(18,2)",position:4},
      actual:{name:"total_assets",type:"string",position:4},
      issues:["TYPE"],
    }]);
    assert.equal(schema.source.snapshotHash, run.syncInput.snapshotHash);
    assert.deepEqual((await request(schemaPath)).value, schema);
    assert.equal((await request(schemaPath + "?run_id=other")).status, 422);
    const schemaClient = {request:async path => (await request(path)).value};
    const stdout = [];
    assert.equal(await runV2Cli(["sql","output-schema","--run-id",failedDevelopment.id],{},
      {client:schemaClient,output:line=>stdout.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(stdout.join("")),schema);
    const mcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"sql_run_output_schema",arguments:{runId:failedDevelopment.id}}},{client:schemaClient}));
    assert.deepEqual(mcp.result.structuredContent,schema);
    assert.throws(() => checkedSyncSqlOutputSchema(schema,{runId:run.id}),/原运行/);
    assert.throws(() => checkedSyncSqlOutputSchema({...schema,differences:[{}]},schema.source),/原运行/);
    const {rows:ignored, ...safeSchema} = checkedSyncSqlOutputSchema({...schema,rows:failedDevelopment.rows},schema.source);
    assert.equal(ignored,undefined);
    assert.deepEqual(safeSchema,schema);
    const originalFailure = app.store.get("run",failedDevelopment.id,PROJECT);
    const ordered = syncSqlOutputSchemaDetails({...originalFailure,columns:[columns[1],columns[0],...columns.slice(2)]},revision.value);
    assert.deepEqual(ordered.differences.map(row=>row.issues),[["ORDER"],["ORDER"]]);
    const duplicates = syncSqlOutputSchemaDetails({...originalFailure,columns:[
      columns[0],columns[0],columns[2],columns[3],{name:"extra_field",type:"int"},
    ]},revision.value);
    assert.ok(duplicates.differences.some(row=>row.issues.includes("DUPLICATE")));
    assert.ok(duplicates.differences.some(row=>row.issues.includes("MISSING")));
    assert.ok(duplicates.differences.some(row=>row.issues.includes("EXTRA")));
    assert.equal(syncSqlOutputSchemaDetails({...originalFailure,columns:undefined},revision.value).status,"UNAVAILABLE");
    assert.equal(syncSqlOutputSchemaDetails(originalFailure,{...revision.value,hash:"0".repeat(64)}),undefined);
    developmentColumns = columns;
    const manual = await request("/runs", { revisionId: revision.value.id }, "manual-run");
    assert.equal(manual.status, 202);
    const checked = await finished(`/runs/${manual.value.id}`);
    assert.equal(checked.syncOutputSchema.status,"MATCHED");
    assert.equal(checked.rows[0].total_assets, "2045.07");
    assert.deepEqual(checked.syncInput, run.syncInput);
    const syncContext = readSyncSqlInput({ store: app.store, project: PROJECT, actorId: revision.value.author, binding: run.syncInput });
    const exampleReceipt = { ...checked, mainSqlExecuted: true, testDouble: false, validation: {
      ...checked.validation, selectedPassed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })),
    } };
    const deliverySource = { agent: completed, run: exampleReceipt, revision: revision.value, syncContext };
    assert.throws(() => createDeliveryPackage({ ...deliverySource, run: checked }), /真实本机运行/);
    assert.throws(() => createDeliveryPackage({ ...deliverySource, run: { ...exampleReceipt, rows: getContext().expected } }), /独立断言/);
    for (const invalid of [wrongColumns, [...columns].reverse(), undefined])
      assert.throws(() => createDeliveryPackage({ ...deliverySource, run: { ...exampleReceipt, columns: invalid } }),
        {code:"SYNC_SQL_OUTPUT_SCHEMA_MISMATCH"});
    const bundle = createDeliveryPackage({ ...deliverySource, name: "客户资产 T+1" });
    assert.equal(bundle.manifest.name, "客户资产 T+1 · 冻结同步持仓");
    const plan = validateDeliveryPackage(bundle, bundle.digest);
    assert.equal(plan.source.syncInput.developmentMode, "MANUAL");
    assert.equal(plan.source.syncInput.runId, first.run.id);
    assert.equal(plan.fixtures.context.expected[0].total_assets, "2045.07");
    const sourceRead = (kind,id) => app.store.get(kind,id,PROJECT);
    const originalCsv = readFileSync(join(fixtureRoot,"first.csv"),"utf8");
    const offlineInput = { read:sourceRead,input:plan.source.syncInput,context:plan.fixtures.context,csv:originalCsv };
    assert.equal(verifySavedSyncSqlInput(offlineInput).targetHash,first.run.targetHash);
    assert.throws(() => verifySavedSyncSqlInput({...offlineInput,csv:readFileSync(join(fixtureRoot,"later.csv"),"utf8")}),
      {code:"SYNC_SAVED_INPUT_CHANGED"});
    assert.throws(() => verifySavedSyncSqlInput({...offlineInput,input:{...offlineInput.input,targetHash:"0".repeat(64)}}),
      {code:"SYNC_SAVED_INPUT_PROJECTION_CHANGED"});
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
    rehearsalColumns = wrongColumns;
    const driftedRehearsal = await request(packagePath + "/verify", { scheduledFor }, "file-schema-drift");
    assert.equal(driftedRehearsal.status, 202);
    const failedRehearsal = await finished(`/delivery/verifications/${driftedRehearsal.value.id}`);
    assert.equal(failedRehearsal.status, "FAILED");
    assert.match(failedRehearsal.error, /冻结持仓输出列或类型不符合约定/);
    rehearsalColumns = columns;
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
    assert.equal(releaseCalls, 2); // One rejected rehearsal and one accepted rehearsal.
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
    assert.equal(releaseCalls, 4);
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
    assert.equal((await request(schemaPath, undefined, undefined, otherIdentity)).status, 403);
    assert.deepEqual((await request("/data-services/sources", undefined, undefined, otherIdentity)).value, []);
    assert.equal((await request(`/data-services/xapis/${xapi.id}`, undefined, undefined, otherIdentity)).status, 403);
    const persisted = await app.dataServices.recheckCall(xapi.id, checkedCall.value.callId);
    assert.equal(persisted.independentResultVerified, true);
    const source = { kind: "MANUAL", releaseId:activate.value.id, packageDigest:stored.digest, revisionId:revision.value.id,
      runId:checked.id, batchId:batches[0].id };
    const reportRequestId = crypto.randomUUID();
    const reportInput = { name:"冻结持仓验收报告", source };
    const createdReport = await request("/reports/published", reportInput, reportRequestId);
    assert.equal(createdReport.value.status, "SUCCEEDED", JSON.stringify(createdReport.value.error));
    const reportPath = `/reports/published/requests/${reportRequestId}`;
    const result = await request(reportPath + "/result");
    assert.equal(result.value.overview.reports[0].runs[0].widgets.find(w=>w.id==="total_assets").value, "2995.07");
    const lineage = await request(reportPath + "/lineage");
    assert.equal(lineage.value.release.snapshotHash,run.syncInput.snapshotHash);
    assert.equal(lineage.value.calls[0].callId,checkedCall.value.callId);
    const assetPath = "/assets/" + encodeURIComponent(lineage.value.snapshot.assetId);
    const asset = await request(assetPath + "/lineage");
    assert.ok(asset.value.edges.some(edge=>edge.evidenceId===first.run.id&&edge.evidenceHash===run.syncInput.snapshotHash));
    assert.ok(!asset.value.nodes.some(node=>node.id==="fixture:positions"));
    assert.equal(asset.value.nodes.length,4);
    assert.ok(asset.value.nodes.every(node=>node.fields?.length&&node.evidenceHash));
    assert.equal((await request(assetPath, undefined, undefined, otherIdentity)).status, 403);
    const classic = await request("/reports/datasets", { name:"原批次资产数据集",code:"frozen_asset_report",assetId:lineage.value.snapshot.assetId,
      fields:asset.value.nodes.find(node=>node.id===lineage.value.snapshot.assetId).fields.map(field=>field.name) });
    assert.equal(classic.status,201,JSON.stringify(classic.value));
    assert.equal(classic.value.publishedSource.batchId,batches[0].id);
    assert.equal((await request(`/reports/datasets/${classic.value.id}/refresh`, {})).value.currentSnapshot.assetVersionId,batches[0].id);
    assert.equal((await request(`/reports/${createdReport.value.reportId}`, undefined, undefined, otherIdentity)).status, 404);
    assert.equal((await request(reportPath + "/lineage?download_digest=" + "0".repeat(64))).status, 409);
    const replayReport = await request("/reports/published", reportInput, reportRequestId);
    assert.equal(replayReport.value.reportRunId,createdReport.value.reportRunId);
    const holdPath = `/data-services/dapis/${holdings.id}`;
    const replacement = await request(holdPath + "/versions", { sourceReleaseRunId: batches[0].id, rateLimitPerMinute: 20 }, "replace-frozen-dapi");
    assert.equal(replacement.status, 201);
    assert.equal((await request(holdPath + "/test", {})).status, 200);
    assert.equal((await request(holdPath + "/publish", { configHash: replacement.value.configHash })).status, 200);
    assert.equal((await request("/open/dapis/sync-holdings", undefined, undefined, bearer)).value.code, "SERVICE_VERSION_FORBIDDEN");
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 200);
    const originalBatch = app.store.get("release_run", batches[1].id, PROJECT);
    app.store.update("release_run", originalBatch.id, PROJECT, { columns:wrongColumns });
    assert.deepEqual((await request("/data-services/sources")).value, []);
    assert.equal((await request(reportPath + "/lineage")).status,409);
    app.store.update("release_run", originalBatch.id, PROJECT, { columns });
    app.store.update("release_run", originalBatch.id, PROJECT, { snapshotHash:"0".repeat(64) });
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 409);
    assert.equal((await request(reportPath + "/lineage")).status,409);
    assert.equal((await request(reportPath + "/result")).value.receipt.reportRunId,createdReport.value.reportRunId);
    app.store.update("release_run", originalBatch.id, PROJECT, { snapshotHash:originalBatch.snapshotHash });
    assert.equal((await request(`/data-services/applications/${issued.value.application.id}/revoke`, {})).status, 200);
    assert.equal((await request("/open/xapis/sync-assets", undefined, undefined, bearer)).status, 401);
    const record = app.store.get("sync_sql_input", completed.syncInput.snapshotId, PROJECT);
    record.payload.context.expected[0].total_assets = "0.00";
    app.store.update("sync_sql_input", record.id, PROJECT, { payload: record.payload });
    assert.equal((await request("/runs", { revisionId: revision.value.id }, "tampered")).value.code, "SYNC_SQL_INPUT_CHANGED");
    assert.equal(sync("bad.csv").run.status, "SUCCEEDED");
    assert.equal((await request("/development/synced-positions")).status, 422);
    assert.equal(runs, 3);
    assert.equal(modelCalls, 1);
  } finally {
    openModel();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
