import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { fundRehearsalRecheckResult, readFundRehearsalRecheck, recheckFundRehearsal } from "../../src/v2/fund-rehearsal-recheck.mjs";

test("receipt recheck uses its own route and checks exact status and version across CLI and MCP", async () => {
  const task = { id: randomUUID(), version: 3, packageDigest: "a".repeat(64), verificationId: randomUUID() };
  const input = { deliveryTaskId: task.id, expectedVersion: task.version };
  const path = `/agent/deliveries/${task.id}/recheck-receipt`;
  const pending = fundRehearsalRecheckResult(task, "UNCONFIRMED");
  const recovered = fundRehearsalRecheckResult({ ...task, version: 4 }, "RECOVERED");
  const responses = [pending, recovered];
  const client = { request: async (url, options) => {
    assert.equal(url, path);
    assert.deepEqual(options, { method: "POST", body: { expectedVersion: 3 } });
    return responses.shift();
  } };
  let output;
  const exit = await runV2Cli(["agent", "recheck-delivery-receipt", "--id", task.id, "--version", "3"], {}, {
    client, output: text => { output = JSON.parse(text); }, error: assert.fail,
  });
  assert.equal(exit, 0);
  assert.deepEqual(output, pending);
  const rpc = await handleV2Mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "fund_delivery_receipt_recheck", arguments: input,
  } }, { client });
  assert.deepEqual(JSON.parse(rpc).result.structuredContent, recovered);
  assert.deepEqual(responses, []);

  for (const result of [{ ...pending, version: 4 }, { ...recovered, deliveryTaskId: randomUUID() }, { ...pending, extra: "unexpected" }])
    await assert.rejects(recheckFundRehearsal({ request: async () => result }, input), /响应与所选交付不符/);
  await assert.rejects(recheckFundRehearsal({ request: assert.fail }, { ...input, expectedVersion: 0 }), { status: 422 });
  assert.throws(() => readFundRehearsalRecheck({ expectedVersion: 3, receipt: {} }), { status: 422 });
});
