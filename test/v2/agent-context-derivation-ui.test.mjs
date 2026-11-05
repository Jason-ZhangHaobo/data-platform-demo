import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../src/v2/context.mjs";
import { createAgentSubmission, agentSubmissionRequest } from "../../web/src/agent-submission.ts";
import { contextDerivationFromLocation, contextDerivationLocation, clearContextDerivation, contextDerivationReference,
  contextDerivationAccessReason, readContextDerivationSource, contextDerivationSubmitReason, contextDerivationBody,
  contextDerivationReceiptMatches, contextDerivationReceiptContent } from "../../web/src/agent-context-derivation.ts";

// Public synthetic records and injected GET/POST only; no model or Spark.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const access = { canWrite: true, readOnly: false, taskOnly: false, sourceLocked: false, publicationOnly: false, working: false, pending: false, dirty: false };
function fixture() {
  const contextId = "holdings-t1", family = validationFamilyForContext(contextId), sql = referenceSqlForContext(contextId), hash = createHash("sha256").update(sql).digest("hex");
  const task = { id: id(1), status: "SUCCEEDED", mode: "LIVE_MODEL", language: "SPARK_SQL", contextId, sql, revisionId: id(2), runId: id(3),
    attempts: [{ attempt: 1, status: "SUCCEEDED", model: "qwen3.7-plus", revisionId: id(2), runId: id(3) }] };
  const revision = { id: id(2), source: "LIVE_MODEL", contextId, sql, hash };
  const run = { id: id(3), status: "SUCCEEDED", agentTaskId: task.id, revisionId: revision.id, revisionHash: hash, contextId,
    engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, validationContractId: family.id,
    validation: { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) } };
  const workflow = { report: { taskId: task.id, runId: run.id, revisionId: revision.id, revisionHash: hash, contextId,
    validationContractId: family.id, status: "PASSED", checks: ["revision", "execution", "results", "regressions"].map(id => ({ id, passed: true })) } };
  const source = { kind: "REGISTERED_CONTEXT_CHANGE", taskId: task.id, revisionId: revision.id, runId: run.id, revisionHash: hash };
  const draft = { source, targetContextId: "stock-cash-t1" }, reads = [];
  const read = async (path, ...args) => {
    assert.equal(args.length, 0); reads.push(path);
    const value = new Map([[`/agent/tasks/${task.id}`, task], [`/revisions/${revision.id}`, revision], [`/runs/${run.id}`, run], [`/agent/tasks/${task.id}/workflow`, workflow]]).get(path);
    if (!value) throw Error("unexpected source read"); return structuredClone(value);
  };
  return { task, revision, run, workflow, source, draft, reads, read, family };
}

test("draft URL preserves only source IDs/hash and target context, including a pending original request", () => {
  const f = fixture(), original = structuredClone(f.source);
  const url = contextDerivationLocation(`https://example.invalid/v2/?task=${id(99)}&sql=NOT_SAVED&message=NOT_SAVED&token=NOT_SAVED`, f.draft);
  assert.deepEqual(contextDerivationFromLocation(url.href), { status: "VALID", draft: f.draft });
  assert.equal(url.searchParams.size, 6); assert.equal(url.href.includes("NOT_SAVED"), false);
  const pending = contextDerivationLocation(url.href, f.draft, id(4));
  assert.equal(agentSubmissionRequest(pending.href), id(4)); assert.deepEqual(contextDerivationFromLocation(pending.href).draft, f.draft);
  const cleaned = clearContextDerivation(pending.href); assert.equal([...cleaned.searchParams.keys()].some(key => key.startsWith("derive_")), false);
  assert.deepEqual(f.source, original);
  for (const malformed of [url.href + "&derive_task=" + id(1), url.href + "&derive_unknown=x", url.href.replace("derive_hash=", "missing_hash="),
    url.href + "&task=" + id(99), url.href + "&origin_task=" + id(1), url.href.replace("stock-cash-t1", "unregistered"), pending.href + "&agent_request=" + id(5)])
    assert.equal(contextDerivationFromLocation(malformed).status, "INVALID");
});

test("source recovery is four exact GETs and hashes the frozen SQL before enabling a new-context body", async () => {
  const f = fixture(), before = structuredClone({ task: f.task, revision: f.revision, run: f.run });
  assert.deepEqual(contextDerivationReference(f.task, f.run, f.revision.id), f.source);
  const verified = await readContextDerivationSource(f.draft, f.read);
  assert.equal(f.reads.length, 4); assert.ok(f.reads.every(path => !path.includes("stock-cash")));
  assert.equal(verified.sql, f.revision.sql); assert.equal(verified.contextId, "holdings-t1");
  assert.equal(contextDerivationSubmitReason(f.draft, verified, access, true, verified.sql), "");
  const body = contextDerivationBody(f.draft, verified, "仅统计股票持仓与可用现金，请按新口径验证");
  assert.equal(body.contextId, "stock-cash-t1"); assert.equal(body.sql, f.revision.sql); assert.deepEqual(body.derivation, f.source);
  assert.equal(Object.hasOwn(body, "sourceRunId"), false); assert.equal(Object.hasOwn(body, "approvalId"), false);
  assert.deepEqual({ task: f.task, revision: f.revision, run: f.run }, before);
});

test("failed, manual, stale or mixed sources cannot become a verified derivation draft", async () => {
  for (const mutate of [
    f => { f.task.status = "FAILED"; }, f => { f.task.mode = "TEMPLATE"; }, f => { f.task.sourceKind = "MANUAL"; },
    f => { f.task.attempts[0].model = "TEST_DOUBLE"; }, f => { f.task.attempts[0].runId = id(99); },
    f => { f.run.agentTaskId = id(99); }, f => { f.run.validationContractId = "wrong"; },
    f => { f.run.validation.regressions.pop(); }, f => { f.run.mainSqlExecuted = false; },
    f => { f.revision.source = "MANUAL"; }, f => { f.workflow.report.runId = id(99); },
    f => { f.workflow.report.checks[2].passed = false; }, f => { f.revision.sql = "SELECT 1"; f.task.sql = "SELECT 1"; },
  ]) { const f = fixture(); mutate(f); await assert.rejects(readContextDerivationSource(f.draft, f.read)); }
  await assert.rejects(readContextDerivationSource(fixture().draft, async () => { throw Error("synthetic GET failed"); }));
});

test("existing scopes, pending requests, dirty input and unchanged target block new work", async () => {
  const f = fixture(), verified = await readContextDerivationSource(f.draft, f.read);
  for (const key of ["readOnly", "taskOnly", "sourceLocked", "publicationOnly", "working", "pending", "dirty"])
    assert.ok(contextDerivationSubmitReason(f.draft, verified, { ...access, [key]: true }, true, verified.sql), key);
  assert.ok(contextDerivationAccessReason({ ...access, unsentMessage: true }));
  assert.equal(contextDerivationSubmitReason(f.draft, verified, access, true, verified.sql), "", "new requirement text is not the entry-only unsent-message gate");
  assert.ok(contextDerivationSubmitReason({ ...f.draft, targetContextId: verified.contextId }, verified, access, true, verified.sql));
  assert.ok(contextDerivationSubmitReason(f.draft, undefined, access, true, verified.sql));
  assert.ok(contextDerivationSubmitReason(f.draft, verified, access, false, verified.sql));
  assert.ok(contextDerivationSubmitReason(f.draft, verified, access, true, "SELECT 1"));
});

test("confirmed creation uses the existing controller: unknown response is read first and explicit retry preserves frozen source/body/key", async () => {
  const f = fixture(), verified = await readContextDerivationSource(f.draft, f.read), body = contextDerivationBody(f.draft, verified, "变更为股票持仓与现金口径");
  const calls = [], pending = [], child = { id: id(8), contextId: body.contextId, initialSql: body.sql, derivedFrom: { ...body.derivation, contextId: verified.contextId, validationContractId: verified.validationContractId } };
  const controller = createAgentSubmission({ makeKey: () => id(4), onPending: key => pending.push(key), api: async (path, input, options) => {
    calls.push({ path, input: input && structuredClone(input), key: options?.idempotencyKey });
    if (input === undefined) throw Object.assign(Error("not recorded"), { status: 404 });
    if (calls.length === 1) throw Error("synthetic response unknown"); return child;
  } });
  assert.equal(calls.length, 0);
  await assert.rejects(controller.submit(body)); body.contextId = "cash-change";
  assert.equal(calls.length, 1); assert.equal(controller.snapshot().key, id(4));
  const recovered = await controller.retry();
  assert.deepEqual(calls.map(call => call.path), ["/agent/tasks", `/agent/requests/${id(4)}`, "/agent/tasks"]);
  assert.deepEqual(calls[2].input, calls[0].input); assert.equal(calls[2].key, calls[0].key);
  assert.equal(contextDerivationReceiptMatches(recovered, f.draft, verified), true);
  for (const patch of [{ contextId: "holdings-t1" }, { initialSql: "SELECT 1" }, { derivedFrom: { ...child.derivedFrom, revisionHash: "a".repeat(64) } }])
    assert.equal(contextDerivationReceiptMatches({ ...child, ...patch }, f.draft, verified), false);
  controller.acknowledge(id(4)); assert.deepEqual(pending, [id(4), undefined]);
});

test("refreshing a pending derivation recovers completed child SQL and clears only the automatic placeholder", async () => {
  const f = fixture(), url = contextDerivationLocation("https://example.invalid/v2/", f.draft, id(4));
  const restored = contextDerivationFromLocation(url.href); assert.equal(restored.status, "VALID");
  const verified = await readContextDerivationSource(restored.draft, f.read), automatic = "请基于原已验证SQL，按选定的新口径改写并重新验证。";
  const child = { id: id(8), contextId: "stock-cash-t1", sql: referenceSqlForContext("stock-cash-t1"), initialSql: verified.sql, message: "原先确认的新证券口径需求",
    derivedFrom: { ...f.source, contextId: verified.contextId, validationContractId: verified.validationContractId } };
  let requests = 0;
  const controller = createAgentSubmission({ initialKey: agentSubmissionRequest(url.href), onPending: () => {}, api: async (path, body) => {
    assert.equal(path, `/agent/requests/${id(4)}`); assert.equal(body, undefined); requests++; return child;
  } });
  const receipt = await controller.recover(); assert.equal(controller.snapshot().canRetry, false);
  assert.equal(contextDerivationReceiptMatches(receipt, restored.draft, verified), true);
  const view = contextDerivationReceiptContent(receipt, automatic, automatic), baseline = receipt.sql;
  assert.equal(view.sql, child.sql); assert.notEqual(view.sql, verified.sql); assert.equal(view.sql !== baseline, false, "no invented dirty parent SQL");
  assert.equal(view.message, ""); assert.equal(receipt.contextId, f.draft.targetContextId);
  assert.equal(contextDerivationReceiptContent(receipt, "用户等待时填写的下一条需求", automatic).message, "用户等待时填写的下一条需求");
  assert.equal(requests, 1); assert.equal(f.reads.length, 4);
});

test("malformed derived SQL is rejected before acknowledgement and retains the original request and full recovery URL", async () => {
  const f = fixture(), verified = await readContextDerivationSource(f.draft, f.read), body = contextDerivationBody(f.draft, verified, "只统计股票与现金的新需求");
  const child = { id: id(8), contextId: body.contextId, initialSql: verified.sql, message: body.message,
    derivedFrom: { ...f.source, contextId: verified.contextId, validationContractId: verified.validationContractId } };
  for (const sql of [123, null, "", "   ", "x".repeat(20001)]) {
    let href = contextDerivationLocation("https://example.invalid/v2/", f.draft).href;
    const pending = [], controller = createAgentSubmission({ makeKey: () => id(4), onPending: key => {
      pending.push(key); if (key) href = contextDerivationLocation(href, f.draft, key).href;
    }, api: async () => ({ ...child, sql }) });
    const receipt = await controller.submit(body);
    const confirm = value => {
      assert.equal(contextDerivationReceiptMatches(value, f.draft, verified), true);
      const content = contextDerivationReceiptContent(value, "");
      controller.acknowledge(id(4)); return content;
    };
    assert.throws(() => confirm(receipt), /原提交编号保留/);
    assert.equal(controller.snapshot().key, id(4)); assert.deepEqual(pending, [id(4)]);
    assert.equal(agentSubmissionRequest(href), id(4)); assert.deepEqual(contextDerivationFromLocation(href).draft, f.draft);
    controller.close();
  }
  assert.equal(contextDerivationReceiptContent(child, "").sql, verified.sql, "QUEUED receipt can use verified initialSql only when sql is absent");
  const ui = readFileSync("web/src/AgentDevelopmentWorkbench.tsx", "utf8"), accept = ui.slice(ui.indexOf("async function acceptSubmissionReceipt"), ui.indexOf("async function recoverAgentSubmission"));
  assert.ok(accept.indexOf("const derivedContent=") < accept.indexOf("submissionController().acknowledge(key)"));
  assert.doesNotMatch(accept, /set(?:Draft|Message)\(previous=>[^;]*contextDerivationReceiptContent/);
});

let compiled = ts.transpileModule(readFileSync("web/src/AgentContextDerivation.tsx", "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } }).outputText;
compiled = compiled.replaceAll('from "react/jsx-runtime"', `from ${JSON.stringify(import.meta.resolve("react/jsx-runtime"))}`);
const { AgentContextDerivation } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
test("actual draft card describes a separate task and disables target/exit while recovery is unconfirmed", async () => {
  const f = fixture(), source = await readContextDerivationSource(f.draft, f.read);
  const props = { draft: f.draft, source, state: "READY", error: "", reason: "", busy: false, pending: false, locked: false,
    contexts: [getContext("holdings-t1"), getContext("stock-cash-t1")], onRead: () => { throw Error("render cannot fetch"); }, onTarget: () => {}, onExit: () => {} };
  const html = renderToStaticMarkup(React.createElement(AgentContextDerivation, props));
  assert.match(html, /新任务草稿 · 原任务不变/); assert.match(html, /不继承原审阅、批准或发布/); assert.match(html, /原SQL保持只读/);
  assert.match(html, /股票持仓/); assert.doesNotMatch(html, /SELECT/);
  for (const patch of [{ pending: true }, { locked: true }, { state: "ERROR", error: "原冻结来源未确认" }]) {
    const disabled = renderToStaticMarkup(React.createElement(AgentContextDerivation, { ...props, ...patch }));
    assert.match(disabled, /<select[^>]*disabled=""/);
  }
  const ui = readFileSync("web/src/AgentDevelopmentWorkbench.tsx", "utf8");
  assert.match(ui, /readOnly=\{derivationActive\|\|readOnly/); assert.match(ui, /if \(derivationActive \|\| !draft.trim\(\)/);
  assert.match(ui, /derivationActive&&derivationDraft\?contextDerivationLocation\(location.href,derivationDraft,pendingAgentKey\)/);
  assert.match(ui, /contextDerivationReceiptMatches\(current,derivationRef.current,derivationSourceRef.current\)/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
});
