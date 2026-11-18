import test from "node:test";
import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, referenceSql, contextIds } from "../../src/v2/context.mjs";
import { identityPositionMapping } from "../../src/v2/ingestion.mjs";
import { readSyncSqlInput, syncSqlOutputSchemaDetails } from "../../src/v2/sync-sql-input.mjs";
import { checkedSqlRunComparison } from "../../src/v2/run-comparison-client.mjs";
import { checkedSyncSqlOutputSchema, checkedSyncSqlRehearsalSchema, checkedSyncSqlScheduledSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { verifySavedSyncSqlInput, verifySavedSyncSqlPackageInput } from "../../src/v2/sync-sql-saved-lifecycle.mjs";
import { createDeliveryPackage, computeManifestDigest, loadDeliveryDirectory, resolveDeliverySchedule, sha256, validateDeliveryPackage } from "../../src/v2/delivery.mjs";

for(const inputMode of ['CURRENT','ARCHIVED','MATERIALIZED']) test(`Agent binds a ${inputMode} position snapshot across overwrite, retry and restart`, async () => {
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
  sample('before-archival.csv','4000.00');
  sample("bad.csv", "0.001");
  const captured = readFileSync(join(fixtureRoot, "first.csv"), "utf8").split("\n");
  writeFileSync(join(fixtureRoot, "currency.csv"), captured.map((line, index) =>
    line + (index === 0 ? ",currency" : ",CNY")).join("\n"));
  writeFileSync(join(fixtureRoot, "mixed.csv"), captured.map((line, index) =>
    line + (index === 0 ? ",currency" : index === 1 ? ",USD" : ",CNY")).join("\n"));
  writeFileSync(join(fixtureRoot, "unknown.csv"), captured.map((line, index) =>
    line + (index === 0 ? ",unregistered" : ",test")).join("\n"));
  cpSync(join(fixtureRoot,"currency.csv"),join(fixtureRoot,"missing.csv"));
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
  async function start(worktree = root) {
    app = createV2Server({ root:worktree, fixtureRoot, runner, now: () => clock, setTimer: () => ({}), clearTimer: () => {},
      env: { V2_LOCAL_DEVELOPMENT: "true", V2_RELEASE_SCHEDULER_MODE: "LOCAL_TIMER" },
      releaseRunner: async ({ directory, expectedDigest, scheduledFor, beforeRun }) => {
        const { bundle, plan } = loadDeliveryDirectory(directory, expectedDigest);
        beforeRun?.();
        releaseCalls++;
        return {
          status: "SUCCEEDED", mainSqlExecuted: true, engine: "Apache Spark", engineVersion: "3.5.9",
          mode: "LOCAL_FILE_REHEARSAL", published: false, schedulerTriggered: false,
          packageDigest: expectedDigest, source: plan.source, occurrence: resolveDeliverySchedule(plan, scheduledFor),
          workflowTrace:plan.order.map(({id,kind})=>({id,kind,status:"SUCCEEDED"})),
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
  function sync(fileName, mapping = identityPositionMapping) {
    const source = app.ingestion.createSource({ name: "虚构证券源 " + fileName, sourceType: "LOCAL_CSV", fileName });
    app.ingestion.testConnection(source.id);
    const metadata = app.ingestion.collectMetadata(source.id);
    const task = app.ingestion.createTask({ name: "虚构持仓同步 " + fileName, sourceId: source.id, targetTable: "raw_positions",
      mode: "FULL", mapping, keyFields: ["position_id"] });
    return { run: app.ingestion.runTask(task.id), metadata };
  }
  try {
    await start();
    assert.equal((await request("/development/synced-positions")).status, 409);
    const first = sync("first.csv");
    if(inputMode==='ARCHIVED')sync('before-archival.csv');
    const offer = await request(inputMode==='MATERIALIZED'?`/development/synced-positions/materialized/${first.run.taskId}/${first.run.id}`:inputMode==='ARCHIVED'?`/development/synced-positions/archives/${first.run.taskId}/${first.run.id}`:"/development/synced-positions");
    assert.equal(offer.status, 200);
    assert.equal(offer.value.selection.runId, first.run.id);
    assert.equal(offer.value.metadataVersionId, first.metadata.id);
    assert.equal(offer.value.context, undefined);
    assert.equal(offer.value.selection.kind,inputMode==='MATERIALIZED'?'SYNC_MATERIALIZED_HOLDINGS_V1':inputMode==='ARCHIVED'?'SYNC_RUN_ARCHIVE_V1':undefined);
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
    const stale = await request("/agent/tasks", {...body,syncInput:{targetTable:'raw_positions',runId:first.run.id,targetHash:first.run.targetHash}}, "stale-request");
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
    const input = schema.inputMetadata;
    assert.equal(input.syncRunId, first.run.id);
    assert.equal(input.frozen.metadataVersionId, first.metadata.id);
    assert.equal(input.frozen.sourceRevisionId, first.metadata.revisionId);
    assert.equal(input.frozen.columns.length, 7);
    assert.deepEqual(input.current, input.frozen);
    assert.deepEqual(input.differences, []);
    assert.equal(input.frozen.columns[0].distinctCount, undefined);
    assert.deepEqual((await request(schemaPath)).value, schema);
    assert.equal((await request(schemaPath + "?run_id=other")).status, 422);
    const sourceId = first.metadata.sourceId;
    app.ingestion.createSourceRevision(sourceId, {fileName:"currency.csv"});
    const missingCurrent = (await request(schemaPath)).value.inputMetadata;
    assert.equal(missingCurrent.current, null);
    assert.deepEqual(missingCurrent.frozen, input.frozen);
    app.ingestion.testConnection(sourceId);
    const currentMetadata = app.ingestion.collectMetadata(sourceId);
    const report = (await request(schemaPath)).value;
    assert.deepEqual(report.differences, schema.differences);
    assert.deepEqual(report.inputMetadata.frozen, input.frozen);
    assert.equal(report.inputMetadata.current.metadataVersionId, currentMetadata.id);
    assert.deepEqual(report.inputMetadata.differences, [
      {name:"currency",before:null,after:{name:"currency",type:"string",position:8,nullable:false}},
    ]);
    assert.deepEqual((await request("/runs/"+failedDevelopment.id)).value.syncOutputSchema, report);
    app.store.update("ingestion_source", sourceId, PROJECT, {currentMetadataId:latest.metadata.id});
    assert.equal((await request(schemaPath)).value.inputMetadata.current,null);
    app.store.update("ingestion_source", sourceId, PROJECT, {currentMetadataId:currentMetadata.id});
    app.store.update("source_metadata", first.metadata.id, PROJECT, {schemaHash:"0".repeat(64)});
    assert.equal((await request(schemaPath)).value.inputMetadata,null);
    app.store.update("source_metadata", first.metadata.id, PROJECT, {schemaHash:first.metadata.schemaHash});
    let adapterRequest = 0;
    const schemaClient = {request:async (path, options) => (await request(path, options?.body,
      options?.body === undefined ? undefined : "adapter-"+(++adapterRequest))).value};
    const stdout = [];
    assert.equal(await runV2Cli(["sql","output-schema","--run-id",failedDevelopment.id],{},
      {client:schemaClient,output:line=>stdout.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(stdout.join("")),report);
    const mcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"sql_run_output_schema",arguments:{runId:failedDevelopment.id}}},{client:schemaClient}));
    assert.deepEqual(mcp.result.structuredContent,report);
    assert.throws(() => checkedSyncSqlOutputSchema(report,{...schema.source,metadataVersionId:currentMetadata.id}),/原运行/);
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
    const comparisonPath = "/runs/"+checked.id+"/comparison";
    const candidatesPath = comparisonPath+"-candidates";
    const failureComparison = comparisonPath+"?baseline_run_id="+failedDevelopment.id;
    const candidates = (await request(candidatesPath)).value;
    assert.equal(candidates.snapshotHash,run.syncInput.snapshotHash);
    assert.ok(candidates.candidates.some(candidate=>candidate.runId===failedDevelopment.id));
    const compared = (await request(failureComparison)).value;
    assert.equal(compared.frozenInput.baseline.output.status,"MISMATCH");
    assert.equal(compared.frozenInput.current.output.status,"MATCHED");
    assert.equal(compared.frozenInput.baseline.selectedRows,"MATCHED");
    assert.equal(compared.frozenInput.current.selectedRows,"MATCHED");
    assert.equal(compared.frozenInput.syncRunId,first.run.id);
    assert.equal(compared.frozenInput.metadataVersionId,first.metadata.id);
    assert.equal(compared.readOnly,true);
    assert.equal(compared.frozenInput.current.rows,undefined);
    const compareArgs = {runId:checked.id,baselineRunId:failedDevelopment.id,snapshotHash:run.syncInput.snapshotHash};
    assert.throws(()=>checkedSqlRunComparison({...compared,frozenInput:{...compared.frozenInput,
      baseline:compared.frozenInput.current}},compareArgs),/原运行/);
    const swapped = app.store.create("run",PROJECT,{...originalFailure,syncInput:{...originalFailure.syncInput,snapshotHash:"0".repeat(64)}});
    assert.ok(!(await request(candidatesPath)).value.candidates.some(candidate=>candidate.runId===swapped.id));
    assert.equal((await request(comparisonPath+"?baseline_run_id="+swapped.id)).value.code,"FROZEN_RUN_COMPARISON_SCOPE");
    assert.equal((await request(comparisonPath+"?baseline_run_id="+checked.id)).status,409);
    const cliCompare = [];
    assert.equal(await runV2Cli(["sql","compare-runs","--run-id",checked.id,"--baseline-run-id",failedDevelopment.id],{},
      {client:schemaClient,output:line=>cliCompare.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(cliCompare.join("")),compared);
    const mcpCompare = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"sql_run_compare",arguments:{runId:checked.id,baselineRunId:failedDevelopment.id}}},{client:schemaClient}));
    assert.deepEqual(mcpCompare.result.structuredContent,compared);
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
    const offlineInput = { read:sourceRead,input:plan.source.syncInput,context:plan.fixtures.context,csv:originalCsv,...(inputMode==='MATERIALIZED'?{readSnapshot:id=>app.landingStore.db.prepare('SELECT * FROM landing_run_snapshots WHERE run_id=?').get(id)}:{}) };
    assert.equal(verifySavedSyncSqlInput(offlineInput).targetHash,first.run.targetHash);
    if(inputMode==='MATERIALIZED'){
      const checkedInput=verifySavedSyncSqlPackageInput({store:app.store,project:PROJECT,actor:revision.value.author,
        originalPackage:bundle,packageDigest:bundle.digest,csv:originalCsv,readSnapshot:offlineInput.readSnapshot});
      assert.equal(checkedInput.scope,'LOCAL_SAVED_INPUT_ONLY');assert.equal(checkedInput.input.proof.scope,'RETAINED_TARGET_SNAPSHOT');
      assert.equal(checkedInput.provenance.fullLifecycleE2E,false);assert.equal(checkedInput.input.proof.eventReplayVerified,false);
      const file=join(root,'input-check-package.json');writeFileSync(file,JSON.stringify(bundle));
      const args=['scripts/verify-saved-sync-sql-lifecycle.mjs','--input-only','--metadata',join(root,'.data/v2-platform.sqlite'),
        '--landing-snapshots',join(root,'.data/v2-landing.sqlite'),'--source-csv',join(fixtureRoot,'first.csv'),
        '--package-file',file,'--package-digest',bundle.digest];
      const before=[sha256(readFileSync(join(root,'.data/v2-platform.sqlite'))),sha256(readFileSync(join(root,'.data/v2-landing.sqlite')))];
      const offline=spawnSync(process.execPath,args,{encoding:'utf8',timeout:10000});assert.equal(offline.status,0,offline.stderr);
      assert.deepEqual(JSON.parse(offline.stdout),checkedInput);
      assert.deepEqual([sha256(readFileSync(join(root,'.data/v2-platform.sqlite'))),sha256(readFileSync(join(root,'.data/v2-landing.sqlite')))],before);
      const missing=spawnSync(process.execPath,args.filter((v,i)=>v!=='--landing-snapshots'&&args[i-1]!=='--landing-snapshots'),{encoding:'utf8',timeout:10000});
      assert.equal(missing.status,1);assert.equal(JSON.parse(missing.stderr).code,'SYNC_SAVED_TARGET_SNAPSHOT_REQUIRED');
      const foreign=spawnSync(process.execPath,[...args,'--actor','another-engineer'],{encoding:'utf8',timeout:10000});
      assert.equal(foreign.status,1);assert.equal(JSON.parse(foreign.stderr).code,'SYNC_SAVED_AGENT_SOURCE_REQUIRED');

    }

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
    const failedRehearsalPath = `/delivery/verifications/${failedRehearsal.id}`;
    const rehearsalSchema = failedRehearsal.rehearsalOutputSchema;
    const expectedRehearsal = { ...schema.source, runId:checked.id, verificationId:failedRehearsal.id,
      packageId:stored.id, packageDigest:stored.digest };
    assert.deepEqual(checkedSyncSqlRehearsalSchema(rehearsalSchema,expectedRehearsal),rehearsalSchema);
    assert.deepEqual(rehearsalSchema.differences,schema.differences);
    assert.throws(() => checkedSyncSqlRehearsalSchema(rehearsalSchema,{...expectedRehearsal,verificationId:checked.id}),/原运行/);
    const rehearsalList = await request("/delivery/verifications");
    assert.deepEqual(rehearsalList.value.find(row=>row.id===failedRehearsal.id).rehearsalOutputSchema,rehearsalSchema);
    const fileOutput = [];
    assert.equal(await runV2Cli(["delivery","verification","--id",failedRehearsal.id],{},
      {client:schemaClient,output:line=>fileOutput.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(fileOutput.join("")).rehearsalOutputSchema,rehearsalSchema);
    const fileMcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:2,method:"tools/call",
      params:{name:"delivery_verification_detail",arguments:{verificationId:failedRehearsal.id}}},{client:schemaClient}));
    assert.deepEqual(fileMcp.result.structuredContent.rehearsalOutputSchema,rehearsalSchema);
    assert.equal((await request(packagePath+"/review",{packageDigest:stored.digest,verificationId:failedRehearsal.id,
      reviewNote:"隔离环境的失败审阅",attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}})).status,409);
    app.store.update("delivery_verification",failedRehearsal.id,PROJECT,{fileHashes:{...failedRehearsal.fileHashes,"main.sql":"0".repeat(64)}});
    assert.equal((await request(failedRehearsalPath)).value.rehearsalOutputSchema,undefined);
    app.store.update("delivery_verification",failedRehearsal.id,PROJECT,{fileHashes:failedRehearsal.fileHashes});
    rehearsalColumns = columns;
    const receipt = await request(packagePath + "/verify", { scheduledFor });
    assert.equal(receipt.status, 202);
    const verified = await finished(`/delivery/verifications/${receipt.value.id}`);
    assert.equal(verified.status, "SUCCEEDED");
    assert.equal(verified.rehearsalOutputSchema,undefined);
    assert.deepEqual((await request(failedRehearsalPath)).value.rehearsalOutputSchema,rehearsalSchema);
    const verifiedPath = `/delivery/verifications/${verified.id}`;
    const reviewInput = { packageDigest: stored.digest, verificationId: verified.id,
      reviewNote: "隔离环境的测试审阅", attestations: { code: true, assertions: true, deliveryFiles: true, localScope: true } };
    for (const change of [
      {occurrence:{...verified.occurrence,timezone:"UTC"}},
      {scheduledFor:undefined},
      {workflowTrace:verified.workflowTrace.slice(0,-1)},
      {fileHashes:{...verified.fileHashes,"tests.sql":"0".repeat(64)}},
    ]) {
      app.store.update("delivery_verification",verified.id,PROJECT,change);
      const doubtful = await request(verifiedPath);
      assert.equal(doubtful.value.status,"UNCONFIRMED");
      assert.equal(doubtful.value.storedStatus,"SUCCEEDED");
      assert.equal(doubtful.value.workflowTrace,undefined);
      assert.equal((await request("/delivery/verifications")).value.find(item=>item.id===verified.id).status,"UNCONFIRMED");
      assert.equal((await request(packagePath+"/review",reviewInput)).value.code,"SYNC_SQL_REHEARSAL_UNPROVEN");
      assert.equal((await request(packagePath+"/verify",{scheduledFor},"doubtful-replay")).value.code,"SYNC_SQL_REHEARSAL_UNPROVEN");
      assert.equal(app.store.get("delivery_verification",verified.id,PROJECT).status,"SUCCEEDED");
      app.store.update("delivery_verification",verified.id,PROJECT,Object.fromEntries(Object.keys(change).map(key=>[key,verified[key]])));
    }
    const repeatVerification = await request(packagePath+"/verify",{scheduledFor},"verified-replay");
    assert.equal(repeatVerification.value.id,verified.id);
    const scheduleSpec = { triggerAfterSeconds: 5, intervalSeconds: 45, runCount: 2 };
    const syncConsent = { scope: "LOCAL_TEST_RELEASE", packageDigest: stored.digest, verificationId: verified.id,
      businessDate: "2026-09-10", snapshotHash: run.syncInput.snapshotHash, scheduleSpec, confirmFrozenFictionalData: true };
    const reviewPath = packagePath+"/review";
    const currentReviewDigest = repeatVerification.value.syncRehearsalDigest;
    assert.match(currentReviewDigest,/^[a-f0-9]{64}$/);
    assert.equal((await request(verifiedPath)).value.syncRehearsalDigest,currentReviewDigest);
    const exportPath = verifiedPath+"/review-evidence";
    const changesBeforeExport = app.store.db.prepare("SELECT total_changes() AS count").get().count;
    const exportResponse = await request(exportPath);
    assert.equal(exportResponse.status,200);
    const exported = exportResponse.value;
    assert.equal(exported.readOnly,true);
    assert.equal(exported.verificationId,verified.id);
    assert.equal(exported.syncRehearsalDigest,currentReviewDigest);
    assert.equal(exported.source.snapshotHash,run.syncInput.snapshotHash);
    assert.equal(exported.source.syncRunId,first.run.id);
    assert.equal(exported.rehearsal.businessDate,"2026-09-10");
    assert.deepEqual(exported.fileHashes,verified.fileHashes);
    assert.ok(!JSON.stringify(exported).includes("CLIENT-001"));
    assert.equal(exported.files,undefined);
    assert.equal(exported.rehearsal.rows,undefined);
    const outputEvidence = [];
    assert.equal(await runV2Cli(["delivery","review-evidence","--verification-id",verified.id],{},
      {client:schemaClient,output:line=>outputEvidence.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(outputEvidence.join("")),exported);
    const exportMcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:4,method:"tools/call",
      params:{name:"sync_review_evidence_read",arguments:{verificationId:verified.id}}},{client:schemaClient}));
    assert.deepEqual(exportMcp.result.structuredContent,exported);
    assert.equal(app.store.db.prepare("SELECT total_changes() AS count").get().count,changesBeforeExport);
    assert.equal((await request(exportPath+"?package_id="+stored.id)).status,422);
    assert.equal((await request(failedRehearsalPath+"/review-evidence")).status,409);
    assert.equal((await request(reviewPath,reviewInput,"missing-reviewed-receipt")).value.code,"SYNC_REHEARSAL_REVIEW_CHANGED");
    const oldReviewInput = {...reviewInput,syncRehearsalDigest:exported.syncRehearsalDigest};
    const reviewOutput = [];
    assert.equal(await runV2Cli(["delivery","review","--id",stored.id,"--package-digest",stored.digest,"--verification-id",verified.id,
      "--sync-rehearsal-digest",currentReviewDigest,"--note",reviewInput.reviewNote,
      "--attest-code","--attest-assertions","--attest-delivery-files","--attest-local-scope"],{},
      {client:schemaClient,output:line=>reviewOutput.push(line),error:()=>{}}),0);
    const oldReview = JSON.parse(reviewOutput.join(""));
    assert.equal(oldReview.syncRehearsalDigest,currentReviewDigest);
    assert.equal((await request(reviewPath,oldReviewInput,"retry-same-reviewed-evidence")).value.id,oldReview.id);
    app.store.update("delivery_verification",verified.id,PROJECT,{notice:"隔离测试中同编号且有效的另一份执行说明"});
    const changedReceipt = (await request(verifiedPath)).value;
    assert.equal(changedReceipt.id,verified.id);
    assert.equal(changedReceipt.status,"SUCCEEDED");
    assert.notEqual(changedReceipt.syncRehearsalDigest,currentReviewDigest);
    assert.equal((await request(exportPath)).value.syncRehearsalDigest,changedReceipt.syncRehearsalDigest);
    const approvalFor = reviewId => ({packageDigest:stored.digest,reviewId,syncConsent});
    assert.equal((await request(reviewPath,oldReviewInput,"old-browser-review")).value.code,"SYNC_REHEARSAL_REVIEW_CHANGED");
    assert.equal((await request(packagePath+"/approve",approvalFor(oldReview.id),"approve-stale-review")).value.code,"SYNC_REHEARSAL_REVIEW_CHANGED");
    const legacyReview = app.store.create("delivery_review",PROJECT,{...oldReview,syncRehearsalDigest:undefined});
    assert.equal((await request(packagePath+"/approve",approvalFor(legacyReview.id),"approve-legacy-unapproved")).value.code,"SYNC_REHEARSAL_REVIEW_CHANGED");
    assert.equal(app.store.list("release_approval",PROJECT).length,0);
    const updatedReviewInput = {...reviewInput,syncRehearsalDigest:changedReceipt.syncRehearsalDigest};
    const reviewMcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:3,method:"tools/call",
      params:{name:"delivery_review_create",arguments:{...updatedReviewInput,packageId:stored.id}}},{client:schemaClient}));
    const reviewed = reviewMcp.result.structuredContent;
    assert.equal(reviewed.status,"REVIEWED");
    assert.equal(reviewed.syncRehearsalDigest,changedReceipt.syncRehearsalDigest);
    assert.notEqual(reviewed.id,oldReview.id);
    assert.deepEqual(app.store.get("delivery_review",oldReview.id,PROJECT),oldReview);
    const approvalBody = approvalFor(reviewed.id);
    for (const replacement of [undefined, {...syncConsent, businessDate:"2026-09-11"}, {...syncConsent, snapshotHash:"0".repeat(64)}])
      assert.equal((await request(packagePath + "/approve", { ...approvalBody, syncConsent: replacement })).status, 409);
    const firstApproval = await request(packagePath + "/approve", approvalBody, "sync-approve-first");
    assert.equal(firstApproval.status, 201);
    assert.equal(firstApproval.value.syncRehearsalDigest,changedReceipt.syncRehearsalDigest);
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

    // Test the exact approved plan in an isolated copy before the happy-path batches run.
    const failureRoot = join(root, "schema-failure-replay");
    await stop();
    mkdirSync(failureRoot);
    cpSync(join(root,".data"),join(failureRoot,".data"),{recursive:true});
    await start(failureRoot);
    rehearsalColumns = wrongColumns;
    clock = Date.parse(batches[0].scheduledTriggerAt);
    await app.releaseScheduler.enqueue(batches[0].id);
    const failedBatchPath = `/release/runs/${batches[0].id}`;
    const failedBatch = (await request(failedBatchPath)).value;
    assert.equal(failedBatch.status,"FAILED");
    assert.equal(failedBatch.errorCode,"SYNC_SQL_OUTPUT_SCHEMA_MISMATCH");
    assert.equal(failedBatch.schedulerTriggered,true);
    assert.equal(failedBatch.rows[0].total_assets,"2045.07");
    const batchSchema = failedBatch.scheduledOutputSchema;
    const expectedBatch = {...expectedRehearsal,batchId:batches[0].id,releaseId:activate.value.id};
    assert.deepEqual(checkedSyncSqlScheduledSchema(batchSchema,expectedBatch),batchSchema);
    assert.deepEqual(batchSchema.differences,rehearsalSchema.differences);
    assert.equal(failedBatch.rehearsalOutputSchema,undefined);
    assert.throws(()=>checkedSyncSqlScheduledSchema(batchSchema,{...expectedBatch,batchId:batches[1].id}),/原运行/);
    assert.equal((await request(failedRehearsalPath)).value.scheduledOutputSchema,undefined);
    rehearsalColumns = columns;
    clock = Date.parse(batches[1].scheduledTriggerAt);
    await app.releaseScheduler.enqueue(batches[1].id);
    const failureOverview = (await request("/monitoring/overview")).value;
    assert.equal(failureOverview.activeRelease.health,"CRITICAL");
    assert.equal(failureOverview.counts.succeeded,1);
    assert.equal(failureOverview.counts.failed,1);
    assert.deepEqual(failureOverview.recentRuns.find(item=>item.id===batches[0].id).scheduledOutputSchema,batchSchema);
    const events = failureOverview.recentEvents.filter(item=>item.releaseRunId===batches[0].id);
    assert.deepEqual(events.map(item=>[item.type,item.errorCode]),[["BATCH_FAILED","SYNC_SQL_OUTPUT_SCHEMA_MISMATCH"]]);
    const event=events[0];
    assert.equal(failureOverview.alerts.find(item=>item.releaseRunId===batches[0].id).status,"OPEN");
    assert.deepEqual((await request("/data-services/sources")).value,[]);
    assert.equal((await request("/data-services/dapis",{name:"失败批次查询",slug:"failed-batch-assets",
      sourceReleaseRunId:batches[0].id,fields:["client_id","total_assets"]},"failed-batch-service")).status,409);
    app.store.update("monitor_event",event.id,PROJECT,{snapshotHash:"0".repeat(64)});
    assert.equal((await request(failedBatchPath)).value.scheduledOutputSchema,undefined);
    app.store.update("monitor_event",event.id,PROJECT,{snapshotHash:event.snapshotHash});
    await stop();
    await start(failureRoot);
    assert.deepEqual((await request(failedBatchPath)).value.scheduledOutputSchema,batchSchema);
    const monitorCli=[];
    assert.equal(await runV2Cli(["releases","monitor"],{}, {client:schemaClient,output:line=>monitorCli.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(monitorCli.join("")).recentRuns.find(item=>item.id===batches[0].id).scheduledOutputSchema,batchSchema);
    const batchMcp=JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:3,method:"tools/call",
      params:{name:"release_runs_list",arguments:{}}},{client:schemaClient}));
    assert.deepEqual(batchMcp.result.structuredContent.find(item=>item.id===batches[0].id).scheduledOutputSchema,batchSchema);
    await app.releaseScheduler.enqueue(batches[0].id);
    assert.equal(releaseCalls,4);
    await stop();
    await start();

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
    assert.equal(releaseCalls, 6);
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
    for (const path of [schemaPath, "/runs/"+failedDevelopment.id, failureComparison, candidatesPath, "/revisions/"+revision.value.id]) {
      assert.equal((await request(path,undefined,undefined,otherIdentity)).status,403);
      assert.equal((await request(path,undefined,undefined,bearer)).status,403);
      assert.equal((await request(path,undefined,undefined,{Cookie:"shuduo_session=expired-fixture"})).status,403);
    }
    for (const headers of [otherIdentity,bearer,{Cookie:"shuduo_session=expired-fixture"}])
      assert.equal((await request(exportPath,undefined,undefined,headers)).status,403);
    for (const headers of [otherIdentity,bearer,{Cookie:"shuduo_session=expired-fixture"}]) {
      assert.ok(!(await request("/runs",undefined,undefined,headers)).value.some(item=>item.id===checked.id));
      assert.ok(!(await request("/revisions",undefined,undefined,headers)).value.some(item=>item.id===revision.value.id));
    }
    assert.equal((await request(failedRehearsalPath, undefined, undefined, otherIdentity)).status, 403);
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
    const upstreamId=asset.value.nodes.find(node=>node.id.startsWith("snapshot:sync-holdings:")).id;
    const upstreamPath="/assets/"+encodeURIComponent(upstreamId);
    const frozenSearch="/assets?kind=PUBLISHED_DATASET&q="+encodeURIComponent("冻结持仓客户资产");
    assert.equal((await request(frozenSearch)).value.length,2);
    assert.deepEqual((await request(frozenSearch,undefined,undefined,otherIdentity)).value,[]);
    for(const path of [assetPath,assetPath+"/lineage",upstreamPath,upstreamPath+"/lineage"]){
      assert.equal((await request(path)).status,200);
      assert.equal((await request(path,undefined,undefined,otherIdentity)).status,403);
      assert.equal((await request(path,undefined,undefined,{Cookie:"shuduo_session=expired-fixture"})).status,401);
      const denied=await request(path,undefined,undefined,bearer);
      assert.equal(denied.status,403);
      assert.equal(denied.value.code,"ASSET_SERVICE_CREDENTIAL_FORBIDDEN");
    }
    assert.equal((await request(frozenSearch,undefined,undefined,bearer)).status,403);
    assert.deepEqual((await request(frozenSearch,undefined,undefined,{Cookie:"shuduo_session=expired-fixture"})).value,[]);
    assert.equal((await request("/assets/fixture:positions",undefined,undefined,otherIdentity)).status,200);
    const qualityPath=assetPath+"/quality";
    const pendingQuality=await request(qualityPath);
    assert.equal(pendingQuality.status,200);
    assert.equal(pendingQuality.value.status,"PENDING");
    assert.equal(pendingQuality.value.actualExecution,false);
    assert.equal(app.store.list("quality_frozen_asset_check",PROJECT).length,0);
    const monitoringPath="/operations/overview";
    const opsBefore=(await request(monitoringPath)).value;
    const visibleBatches=opsBefore.recentActivity.filter(item=>item.frozenQualitySource);
    assert.deepEqual(visibleBatches.map(item=>item.id).sort(),batches.map(batch=>batch.id).sort());
    const matching=visibleBatches.find(item=>item.id===batches[0].id).frozenQualitySource;
    for(const key of ["assetId","batchId","releaseId","snapshotHash","evidenceHash","rowCount"])
      assert.equal(matching[key],pendingQuality.value[key]);
    assert.equal(opsBefore.fullLifecycleE2E,false);
    const otherOps=(await request(monitoringPath,undefined,undefined,otherIdentity)).value;
    assert.ok(otherOps.recentActivity.every(item=>!item.frozenQualitySource));
    assert.equal((await request(qualityPath,undefined,undefined,otherIdentity)).status,403);
    assert.equal((await request(qualityPath,undefined,undefined,bearer)).status,403);
    assert.equal((await request(qualityPath,{confirm:true,basisDigest:"0".repeat(64)})).status,409);
    const runQuality=()=>request(qualityPath,{confirm:true,basisDigest:pendingQuality.value.basisDigest});
    const inspected=await runQuality();
    assert.equal(inspected.status,200);
    assert.equal(inspected.value.status,"PASSED");
    assert.equal(inspected.value.batchId,batches[0].id);
    assert.equal(inspected.value.checks.length,3);
    assert.ok(inspected.value.checks.every(check=>check.evaluatedCount===2&&check.passedCount===2&&!check.invalidRowHashes));
    assert.deepEqual((await runQuality()).value,inspected.value);
    assert.deepEqual((await request(qualityPath)).value,inspected.value);
    assert.deepEqual((await request(monitoringPath)).value,opsBefore);
    assert.equal(app.store.list("quality_frozen_asset_check",PROJECT).length,1);
    const differentQuality=await request("/assets/"+encodeURIComponent("dataset:sync-holdings:"+batches[1].id)+"/quality");
    assert.equal(differentQuality.value.status,"PENDING");
    assert.ok(!JSON.stringify(inspected.value).includes("CLIENT-001"));
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
    assert.equal(runs, 3);
    assert.equal(modelCalls, 1);
    const recoveredBatch = sync("currency.csv", {...identityPositionMapping,currency:"currency"});
    const recoveredOffer = await request("/development/synced-positions");
    assert.equal(recoveredOffer.status,200);
    assert.equal(recoveredOffer.value.verifiedCurrency,"CNY");
    assert.equal(recoveredOffer.value.selection.runId,recoveredBatch.run.id);
    assert.equal(recoveredOffer.value.selection.targetHash,recoveredBatch.run.targetHash);
    assert.equal(recoveredOffer.value.context,undefined);
    assert.equal((await request("/development/synced-positions",undefined,undefined,bearer)).status,403);
    const recoveredBody = {...body,syncInput:recoveredOffer.value.selection};
    assert.equal((await request("/agent/tasks",recoveredBody,"forbidden-recovered",bearer)).status,403);
    assert.equal((await request("/agent/tasks",recoveredBody,"expired-recovered",{Cookie:"shuduo_session=expired"})).status,403);
    const stdoutRecovered = [];
    assert.equal(await runV2Cli(["sql","synced-positions"],{},{client:schemaClient,output:line=>stdoutRecovered.push(line),error:()=>{}}),0);
    assert.deepEqual(JSON.parse(stdoutRecovered.join("")),recoveredOffer.value);
    const recoveredMcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
      params:{name:"sql_synced_positions",arguments:{}}},{client:schemaClient}));
    assert.deepEqual(recoveredMcp.result.structuredContent,recoveredOffer.value);
    assert.equal((await request("/agent/tasks",{...recoveredBody,syncInput:{...recoveredBody.syncInput,targetHash:"0".repeat(64)}},"wrong-hash")).value.code,
      "SYNC_SQL_INPUT_STALE");
    const newTask = await request("/agent/tasks",recoveredBody,"new-frozen-currency");
    assert.equal(newTask.status,202);
    const newResult = await finished("/agent/tasks/"+newTask.value.id);
    assert.equal(newResult.status,"SUCCEEDED");
    assert.notEqual(newResult.syncInput.snapshotHash,completed.syncInput.snapshotHash);
    assert.equal(newResult.syncInput.metadataVersionId,recoveredBatch.metadata.id);
    const projected = readSyncSqlInput({store:app.store,project:PROJECT,actorId:revision.value.author,binding:newResult.syncInput});
    assert.deepEqual(projected,syncContext);
    const projectedReceipt = verifySavedSyncSqlInput({read:sourceRead,input:newResult.syncInput,context:projected,
      csv:readFileSync(join(fixtureRoot,"currency.csv"),"utf8")});
    assert.equal(projectedReceipt.targetHash,recoveredBatch.run.targetHash);
    assert.deepEqual(app.store.get("sync_sql_input",record.id,PROJECT),record);
    const actualMetadata = recoveredBatch.metadata;
    app.store.update("source_metadata",actualMetadata.id,PROJECT,{schemaHash:"0".repeat(64)});
    assert.equal((await request("/development/synced-positions")).value.code,"SYNC_SQL_INPUT_UNAVAILABLE");
    app.store.update("source_metadata",actualMetadata.id,PROJECT,{schemaHash:actualMetadata.schemaHash});
    sync("mixed.csv",{...identityPositionMapping,currency:"currency"});
    const mixedCurrency = await request("/development/synced-positions");
    assert.equal(mixedCurrency.status,422);
    assert.equal(mixedCurrency.value.code,"SYNC_SQL_INPUT_INVALID");
    sync("unknown.csv",{...identityPositionMapping,unregistered:"unregistered"});
    assert.equal((await request("/development/synced-positions")).value.code,"SYNC_SQL_INPUT_UNAVAILABLE");
    const {industry: omitted, ...missingField} = identityPositionMapping;
    sync("missing.csv",{...missingField,currency:"currency"});
    assert.equal((await request("/development/synced-positions")).value.code,"SYNC_SQL_INPUT_UNAVAILABLE");
    record.payload.context.expected[0].total_assets = "0.00";
    app.store.update("sync_sql_input", record.id, PROJECT, { payload: record.payload });
    assert.equal((await request("/runs", { revisionId: revision.value.id }, "tampered")).value.code, "SYNC_SQL_INPUT_CHANGED");
    assert.equal(sync("bad.csv").run.status, "SUCCEEDED");
    assert.equal((await request("/development/synced-positions")).status, 422);
    assert.equal(runs, 4);
    assert.equal(modelCalls, 2);
  } finally {
    openModel();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
