import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MetadataStore } from "../../src/v2/store.mjs";
import { fundContextIds } from "../../src/v2/fund-contexts.mjs";
import { fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";
import { createFundPreparations } from "../../src/v2/fund-preparation.mjs";
import { checkedFundPreparation } from "../../src/v2/fund-preparation-client.mjs";
import { validSqlRequirementInterpretation } from "../../src/v2/sql-requirement-contract.mjs";

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
