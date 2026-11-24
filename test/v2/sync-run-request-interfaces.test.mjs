import test from "node:test";
import assert from "node:assert/strict";
import { runV2Cli, V2_CLI_OPERATIONS } from "../../bin/shuduo.mjs";
import { handleV2Mcp, V2_MCP_OPERATIONS } from "../../bin/shuduo-mcp.mjs";
import { checkedSyncRunRequest, syncRunRequestPath, validSyncRunRequestKey } from "../../src/v2/sync-run-request.mjs";

const taskId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const requestId = "old/branch?raw#one% \t+é";
const receiptHash = "a".repeat(64);
const landingEvidence = { runId, receiptHash, finalCount: 3 };
const selection = { taskId, requestKey: requestId };
const path = syncRunRequestPath(selection);
const readArgs = ["sync", "run-request", "--id", taskId, "--request-id", requestId];
const settleArgs = ["sync", "settle-request", "--id", taskId, "--request-id", requestId,
  "--run-id", runId, "--receipt-hash", receiptHash, "--confirm"];
const callMcp = async (client, args = { taskId, requestId }, name = "sync_run_request") => JSON.parse(await handleV2Mcp({
  jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args },
}, { client }));
function makeReceipt(state) {
  return {
    schema: "shuduo-sync-run-request/v1", ...selection, state,
    run: { id: runId, taskId, requestKey: requestId, status: state === "LANDING_COMMITTED" ? "UNCONFIRMED" : state },
    ...(state === "LANDING_COMMITTED" ? { landingEvidence } : {}),
  };
}
async function callCli(client, args = readArgs) {
  let output, error;
  const exit = await runV2Cli(args, {}, {
    client, output: value => { output = JSON.parse(value); }, error: value => { error = value; },
  });
  return { exit, output, error };
}

test("original sync keys stay opaque in a single query parameter", () => {
  for (const key of [".", "..", requestId, "x".repeat(100), "old-run&task_id=other"]) {
    const url = new URL(syncRunRequestPath({ taskId, requestKey: key }), "http://127.0.0.1");
    assert.equal(url.pathname, `/sync/tasks/${taskId}/requests`);
    assert.deepEqual([...url.searchParams], [["request_key", key]]);
    assert.equal(url.hash, "");
  }
  for (const key of ["", " padded ", "bad\r\n", "bad\x7f", "x".repeat(101), "\ud800"]) {
    assert.equal(validSyncRunRequestKey(key), false);
    assert.throws(() => syncRunRequestPath({ taskId, requestKey: key }), /原同步任务/);
  }
});

test("CLI and MCP use a single GET for the exact original receipt in every state", async () => {
  for (const state of ["SUCCEEDED", "FAILED", "LANDING_COMMITTED", "UNCONFIRMED"]) {
    const receipt = makeReceipt(state);
    const calls = [];
    const client = { async request(...args) { calls.push(args); return receipt; } };
    assert.deepEqual(await callCli(client), { exit: 0, output: receipt, error: undefined });
    assert.deepEqual((await callMcp(client)).result.structuredContent, receipt);
    assert.deepEqual(calls, [[path, { method: "GET" }], [path, { method: "GET" }]]);
  }
});

test("lookup failure or mismatched receipts never fall back to another lookup or execution", async () => {
  const missing = Object.assign(Error("未找到原同步请求"), { status: 404, code: "SYNC_RUN_REQUEST_NOT_FOUND" });
  for (const { respond, expectedError } of [
    { respond: () => { throw missing; }, expectedError: "未找到原同步请求" },
    {
      respond: () => ({ ...makeReceipt("SUCCEEDED"), requestKey: "other" }),
      expectedError: "同步执行回执与原任务或请求编号不匹配，请保留原编号",
    },
  ]) {
    const calls = [];
    const client = { async request(...args) { calls.push(args); return respond(); } };
    const cli = await callCli(client);
    const mcp = await callMcp(client);
    assert.equal(cli.exit, 1);
    assert.equal(cli.error, "错误：" + expectedError);
    assert.equal(mcp.error.message, expectedError);
    if (expectedError === missing.message)
      assert.deepEqual(mcp.error.data, { status: 404, code: "SYNC_RUN_REQUEST_NOT_FOUND" });
    assert.deepEqual(calls, Array(2).fill([path, { method: "GET" }]));
  }
});

test("invalid task or extra selectors never send a request", async () => {
  const client = { request: () => assert.fail("invalid selector reached the client") };
  for (const args of [
    ["sync", "run-request", "--id", "%2Fother", "--request-id", requestId],
    [...readArgs, "--request-id", "other"],
    [...readArgs, "--run-id", runId],
  ]) assert.equal((await callCli(client, args)).exit, 1);
  for (const args of [
    { taskId, requestId, runId },
    { taskId: "../other", requestId },
    { taskId, requestId: "bad\n" },
  ]) assert.ok((await callMcp(client, args)).error);
  assert.ok(V2_CLI_OPERATIONS.includes("sync_run_request"));
  assert.ok(V2_MCP_OPERATIONS.includes("sync_run_request"));
  const list = JSON.parse(await handleV2Mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { client }));
  assert.equal(list.result.tools.find(tool => tool.name === "sync_run_request").annotations.readOnlyHint, true);
});

test("receipt verification rejects inconsistent terminal, task and nested landing evidence", () => {
  const committed = makeReceipt("LANDING_COMMITTED"), succeeded = makeReceipt("SUCCEEDED");
  for (const bad of [
    { ...succeeded, run: { ...succeeded.run, status: "FAILED" } },
    { ...committed, run: { ...committed.run, status: "SUCCEEDED" } },
    { ...committed, run: { ...committed.run, taskId: committed.run.id } },
    { ...committed, landingEvidence: { ...landingEvidence, runId: taskId } },
    { ...committed, landingEvidence: { ...landingEvidence, receiptHash: "unverified" } },
    { ...committed, landingEvidence: undefined },
    { ...makeReceipt("FAILED"), landingEvidence },
  ]) assert.throws(() => checkedSyncRunRequest(bad, selection), /不匹配/);
});

test("explicit CLI and MCP settlement posts only the approved original receipt selector", async () => {
  const confirmed = { taskId, requestId, runId, receiptHash, confirm: true };
  const receipt = { ...makeReceipt("SUCCEEDED"), landingEvidence }, calls = [];
  const client = { async request(...args) { calls.push(args); return receipt; } };
  assert.deepEqual(await callCli(client, settleArgs), { exit: 0, output: receipt, error: undefined });
  assert.deepEqual((await callMcp(client, confirmed, "sync_run_request_settle")).result.structuredContent, receipt);
  assert.deepEqual(calls, Array(2).fill([path, { method: "POST", body: { runId, receiptHash, confirm: true } }]));

  const noCall = { request: () => assert.fail("unconfirmed settlement reached the client") };
  for (const args of [settleArgs.slice(0, -1), [...settleArgs, "true"], [...settleArgs, "--latest"]])
    assert.equal((await callCli(noCall, args)).exit, 1);
  for (const args of [{ ...confirmed, confirm: false }, { ...confirmed, receiptHash: "bad" },
    { ...confirmed, runId: "../other" }, { ...confirmed, latest: true }])
    assert.ok((await callMcp(noCall, args, "sync_run_request_settle")).error);
});

test("an unconfirmed or altered settlement response is not accepted or retried", async () => {
  const accepted = { ...makeReceipt("SUCCEEDED"), landingEvidence };
  for (const receipt of [
    makeReceipt("LANDING_COMMITTED"),
    { ...accepted, landingEvidence: { ...landingEvidence, receiptHash: "b".repeat(64) } },
  ]) {
    let calls = 0;
    const client = { async request() { calls++; return receipt; } };
    assert.equal((await callCli(client, settleArgs)).exit, 1);
    assert.ok((await callMcp(client, { taskId, requestId, runId, receiptHash, confirm: true }, "sync_run_request_settle")).error);
    assert.equal(calls, 2);
  }
});
