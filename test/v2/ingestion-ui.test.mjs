import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syncRunSelectionFromLocation, syncRunSelectionLocation } from "../../web/src/sync-run-request.ts";

test("ingestion UI reflects actual server MySQL capability and never labels snapshot diff as CDC", async () => {
  const workbench = await readFile(
      new URL("../../web/src/IngestionWorkbench.tsx", import.meta.url),
      "utf8",
    ),
    main = await readFile(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.match(main, /serverMysqlSyncEnabled=\{status\?\.ingestion\?\.serverMysql\?\.supportsOfflineSync === true\}/);
  assert.match(workbench, /filter\(source => source\.supportsOfflineSync\)/);
  assert.match(workbench, /disabled=\{!canWrite \|\| !metadataForTask \|\| !!busy \|\| Boolean\(mappingProblem\)\}/);
  assert.match(workbench, /快照差异UPSERT（非CDC）/);
  assert.match(workbench, /可创建离线同步/);
  assert.match(workbench, /仅连接与元数据/);
  assert.doesNotMatch(workbench, /首期仅测试连接和采集元数据，不开放同步执行/);
});

test("sync workbench keeps read-only reconciliation separate from explicit execution", async () => {
  const workbench = await readFile(new URL("../../web/src/IngestionWorkbench.tsx", import.meta.url), "utf8");
  const read = workbench.slice(workbench.indexOf("async function readOriginalRun("), workbench.indexOf("function runTask()"));
  const execute = workbench.slice(workbench.indexOf("function runTask()"), workbench.indexOf("function settleOriginalRun()"));
  assert.match(read, /readSyncRunRequest\(\{ request: path => api\(path\) \}, selection\)/);
  assert.doesNotMatch(read, /canWrite|\/run\x60|idempotencyKey|\.runs\.find/);
  assert.match(execute, /rememberOriginalRun\(selection\);\s+const run = await api<SyncRun>/);
  assert.match(execute, /idempotencyKey: selection\.requestKey/);
  assert.match(workbench, /disabled=\{original\.reading \|\| originalOperationBusy\}/);
  assert.match(workbench, /runs=\{\[\{ id: original\.receipt\.run\.id, status: "SUCCEEDED" \}\]\}/);
  assert.match(workbench, /\{!original && <SyncRunSnapshotPanel/);
});

test("the explicit settlement asks only for metadata repair using verified landing evidence", async () => {
  const workbench = await readFile(new URL("../../web/src/IngestionWorkbench.tsx", import.meta.url), "utf8");
  const settle = workbench.slice(workbench.indexOf("function settleOriginalRun()"), workbench.indexOf("const planWithAgent ="));
  assert.match(workbench, /original\?\.receipt\?\.state === "LANDING_COMMITTED" \? original\.receipt\.landingEvidence/);
  assert.match(workbench, /canWrite && originalSettlement && <div>[\s\S]+?确认补记原回执/);
  assert.match(settle, /if \(!canWrite \|\| busy \|\| !selectedTask \|\| !original \|\| !originalSettlement/);
  assert.match(settle, /updateOriginalRun\(selection, \{\}\);\s+const receipt = await settleSyncRunRequest/);
  assert.match(settle, /settleSyncRunRequest\(\{ request: \(path, options\) => api\(path, options\?\.body\) \}, selection, proof\)/);
  assert.match(settle, /receipt\.run\.configHash !== configHash/);
  assert.doesNotMatch(settle, /\/run\x60|idempotencyKey|randomUUID/);
});

test("sync request URL round-trips the exact legacy key and rejects ambiguous links", () => {
  const taskId = "11111111-1111-4111-8111-111111111111";
  const requestKey = "legacy.batch/position+kept";
  const selected = { taskId, requestKey };
  const pinned = syncRunSelectionLocation("http://127.0.0.1:3100/v2/?module=sync#proof", selected);
  assert.equal(pinned.searchParams.get("module"), "sync");
  assert.equal(pinned.hash, "#proof");
  assert.deepEqual(syncRunSelectionFromLocation(pinned.href), selected);
  pinned.searchParams.append("sync_task", taskId);
  assert.throws(() => syncRunSelectionFromLocation(pinned.href), /一个任务和一个原请求编号/);
  assert.throws(() => syncRunSelectionFromLocation("http://127.0.0.1:3100/v2/?sync_run_request=unknown"), /一个任务和一个原请求编号/);
});
