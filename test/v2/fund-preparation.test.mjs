import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { MetadataStore } from "../../src/v2/store.mjs";
import { fundContextIds } from "../../src/v2/fund-contexts.mjs";
import { fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";
import { createFundPreparations } from "../../src/v2/fund-preparation.mjs";
import { checkedFundPreparation, fundExecutionBody } from "../../src/v2/fund-preparation-client.mjs";
import { validSqlRequirementInterpretation } from "../../src/v2/sql-requirement-contract.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { fundContext, fundReferenceSql } from "../../src/v2/fund-lookthrough.mjs";
import { generateSql } from "../../src/v2/model.mjs";
import { safeModelDiagnostic } from "../../src/v2/model-diagnostics.mjs";

const project = "fund-preparation-test";
const actor = "synthetic-engineer";
const [oldId, nextId] = fundContextIds;
const input = (contextId = nextId, businessDate = "2026-09-11") => ({
  contextId, businessDate, message: "分析当日基金组合敞口并保留未穿透余额",
  metrics: fundRequirementScope(contextId).metrics.map(metric => metric.field),
});

test("fund preparation preserves each registered scope and exact saved request without running work", async t => {
  const store = new MetadataStore(":memory:");
  t.after(() => store.close());
  const service = createFundPreparations({ store, project });
  const id = randomUUID();
  const saved = service.submit(input(), actor, id);
  assert.equal(saved.replayed, false);
  assert.equal(saved.receipt.basis.parameters.trade_date, "2026-09-11");
  assert.equal(saved.receipt.basis.parameters.manager_id, "MANAGER-DEMO-A");
  assert.equal(saved.receipt.basis.grain, "PORTFOLIO_TRADE_DATE_ASSET_CLASS");
  assert.equal(saved.receipt.modelCalls + saved.receipt.sparkRuns, 0);
  assert.ok(saved.receipt.basis.tables.every(table => !Object.hasOwn(table, "rows")));
  assert.equal(JSON.stringify(saved.receipt).includes("PORT-DEMO-A1"), false);
  assert.deepEqual(service.submit(input(), actor, id), { receipt: saved.receipt, replayed: true });
  assert.deepEqual(await checkedFundPreparation(service.read(id, actor), { requestId: id, input: input() }), saved.receipt);
  assert.throws(() => service.read(id, "other-engineer"), { code: "FUND_PREPARATION_NOT_FOUND" });
  assert.throws(() => service.submit({ ...input(), message: "改写原请求" }, actor, id), { status: 409 });
  assert.throws(() => service.submit(input(nextId, "2026-09-10"), actor, randomUUID()), { code: "FUND_PREPARATION_DATE_MISMATCH" });
  assert.throws(() => service.submit({ ...input(), metrics: ["total_assets"] }, actor, randomUUID()), { code: "FUND_PREPARATION_INVALID" });
  assert.equal(store.list("agent_fund_preparation", project).length, 1);
  assert.equal(store.list("agent", project).length + store.list("run", project).length, 0);
  const old = service.submit(input(oldId, "2026-09-10"), actor, randomUUID()).receipt;
  assert.notEqual(old.execution.assertionDigest, saved.receipt.execution.assertionDigest);
  assert.notEqual(old.execution.inputDigest, saved.receipt.execution.inputDigest);
  await assert.rejects(checkedFundPreparation({ ...saved.receipt, basis: old.basis }));
});

test("prepared fund basis validates only the registered output grain, metrics and input schema", t => {
  const store = new MetadataStore(":memory:");
  t.after(() => store.close());
  const { receipt } = createFundPreparations({ store, project }).submit(input(), actor, randomUUID());
  const basis = receipt.basis;
  const interpretation = { kind: "DEVELOPMENT", basisDigest: basis.digest, summary: "按组合和交易日分析敞口",
    grain: basis.grain, metrics: basis.metrics.map(({ field, label, sourceFields }) => ({ field, meaning: label, sourceFields })),
    constraints: basis.constraints };
  assert.equal(validSqlRequirementInterpretation(interpretation, basis), true);
  assert.equal(validSqlRequirementInterpretation({ ...interpretation, grain: "CLIENT_TRADE_DATE" }, basis), false);
  assert.equal(validSqlRequirementInterpretation(interpretation,
    { ...basis, parameters: { advisor_id: "ADVISOR-DEMO", trade_date: "2026-09-11" } }), false);
  assert.equal(validSqlRequirementInterpretation(interpretation,
    { ...basis, tables: basis.tables.map(table => ({ ...table, rows: [] })) }), false);
});

test("the real model adapter uses the exact saved fund scope and never sends rows or expected values", async t => {
  const store = new MetadataStore(":memory:");
  t.after(() => store.close());
  const { receipt } = createFundPreparations({ store, project }).submit(input(), actor, randomUUID());
  const { basis } = receipt, context = fundContext(nextId);
  const request = { message: receipt.input.message, context, fundBasisDigest: basis.digest };
  let requests = 0;
  const fetcher = async (_url, options) => {
    requests++;
    const [system, user] = JSON.parse(options.body).messages;
    const packet = JSON.parse(user.content);
    assert.match(system.content, /\{\{manager_id\}\}/);
    assert.doesNotMatch(system.content, /advisor_id|accounts\/positions\/cash/);
    assert.deepEqual(packet.context.parameters, basis.parameters);
    assert.deepEqual(packet.context.tables, basis.tables);
    assert.equal(packet.requirementBasis.digest, basis.digest);
    assert.deepEqual(packet.executionContract.fields, receipt.input.metrics);
    assert.doesNotMatch(options.body, /"rows"|"expected"|PORT-DEMO-A1/);
    const requirement = { kind: "DEVELOPMENT", basisDigest: basis.digest, summary: "按登记组合计算同日敞口",
      grain: basis.grain, metrics: basis.metrics.map(({ field, label, sourceFields }) => ({ field, meaning: label, sourceFields })),
      constraints: basis.constraints };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ requirement, sql: fundReferenceSql }) } }],
      usage: { total_tokens: 500 } }));
  };
  const env = { DASHSCOPE_API_KEY: "SYNTHETIC_TEST_ONLY" };
  const generated = await generateSql(request, env, fetcher);
  assert.equal(validSqlRequirementInterpretation(generated.requirement, basis), true);
  await assert.rejects(generateSql({ ...request, message: "替换已保存的原始需求" }, env, fetcher), error =>
    safeModelDiagnostic(error).code === "MODEL_FUND_BASIS_MISMATCH" && !safeModelDiagnostic(error).requestMayHaveBeenSent);
  assert.equal(requests, 1);
});

test("fund execution rejects unbound requests and stops before Spark if the preparation changes while generating", async t => {
  const store = new MetadataStore(":memory:");
  const preparations = createFundPreparations({ store, project: PROJECT });
  const { receipt } = preparations.submit(input(), "local-engineer", randomUUID());
  const another = preparations.submit(input(), "another-engineer", randomUUID()).receipt;
  const body = fundExecutionBody(receipt);
  let generated = 0, computations = 0;
  const app = createV2Server({ store, env: { V2_LOCAL_DEVELOPMENT: "true" },
    generator: async ({ fundBasisDigest }) => {
      generated++;
      assert.equal(fundBasisDigest, receipt.basis.digest);
      const item = store.list("agent_fund_preparation", PROJECT).find(item => item.actorId === "local-engineer");
      store.update("agent_fund_preparation", item.id, PROJECT, { receipt: { ...item.receipt, modelCalls: 1 } });
      return { model: "untrusted-provider-label", sql: fundReferenceSql, usage: { total_tokens: 500 } };
    },
    runner: async () => { computations++; throw Error("unexpected compute"); },
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));
    store.close();
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  const post = (body, key = receipt.requestId) => fetch(base + "/agent/tasks", { method: "POST",
    headers: { "content-type": "application/json", "x-shuduo-client": "workbench", "idempotency-key": key },
    body: JSON.stringify(body) });
  const invalid = [
    [body, randomUUID(), 422],
    [{ ...body, sql: "SELECT 1" }, undefined, 422],
    [{ ...body, fundPreparation: { ...body.fundPreparation, confirm: false } }, undefined, 422],
    [{ ...body, fundPreparation: { ...body.fundPreparation, basisDigest: "0".repeat(64) } }, undefined, 409],
    [{ ...body, contextId: oldId }, undefined, 409],
    [{ ...body, message: "更改登记基金的业务范围" }, undefined, 409],
    [fundExecutionBody(another), another.requestId, 404],
  ];
  for (const [payload, key, status] of invalid) assert.equal((await post(payload, key)).status, status);
  assert.equal(generated + computations + store.list("agent", PROJECT).length, 0);
  const response = await post(body);
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.equal(created.mode, "SYNTHETIC_MODEL");
  let task;
  for (let count = 0; count < 40; count++) {
    task = store.get("agent", created.id, PROJECT);
    if (task.status === "FAILED") break;
    await delay(10);
  }
  assert.equal(task.code, "FUND_PREPARATION_SOURCE_CHANGED");
  assert.equal(task.usedTokens, 500);
  assert.equal(task.attempts[0].model, "TEST_DOUBLE");
  assert.equal(task.attempts[0].computationSkipped, true);
  assert.equal(generated, 1);
  assert.equal(computations + store.list("revision", PROJECT).length + store.list("run", PROJECT).length, 0);
  const recovered = await fetch(base + "/agent/requests/" + receipt.requestId);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).id, created.id);
});
