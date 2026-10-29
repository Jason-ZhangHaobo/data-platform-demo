import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

let compiled = ts.transpileModule(readFileSync(new URL("../../web/src/EvidenceDownload.tsx", import.meta.url), "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
for (const name of ["react", "react/jsx-runtime", "lucide-react"])
  compiled = compiled.replaceAll(`from "${name}"`, `from ${JSON.stringify(import.meta.resolve(name))}`);
const { EvidenceDownload, requestTextDownload } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function useDocument(t, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, "document", previous) : delete globalThis.document);
}
function downloadFixture(t, { clickFailure = false, appendFailure = false, createFailure = false } = {}) {
  const events = [], timers = [], blobs = [];
  let connected = false;
  const anchor = {
    click() { assert.equal(connected, true, "Safari needs a connected download anchor"); events.push("click"); if (clickFailure) throw Error("SYNTHETIC_CLICK_FAILED"); },
    remove() { events.push("remove"); connected = false; },
  };
  useDocument(t, {
    createElement(tag) { assert.equal(tag, "a"); events.push("element"); return anchor; },
    body: { appendChild(value) { assert.equal(value, anchor); events.push("append"); if (appendFailure) throw Error("SYNTHETIC_APPEND_FAILED"); connected = true; } },
  });
  t.mock.method(URL, "createObjectURL", blob => { events.push("url"); if (createFailure) throw Error("SYNTHETIC_URL_FAILED"); blobs.push(blob); return "blob:synthetic-download"; });
  t.mock.method(URL, "revokeObjectURL", url => { assert.equal(url, "blob:synthetic-download"); events.push("revoke"); });
  t.mock.method(globalThis, "setTimeout", (callback, delay) => { events.push("schedule"); timers.push({ callback, delay }); return 1; });
  return { events, timers, blobs, anchor };
}

test("download requests use a connected hidden anchor, preserve JSON bytes, and defer URL cleanup", async t => {
  const f = downloadFixture(t), body = '{"scope":"FICTIONAL_SECURITIES"}\n';
  requestTextDownload("fictional-recovery.json", body);
  assert.deepEqual(f.events, ["url", "element", "append", "click", "remove", "schedule"]);
  assert.equal(f.anchor.hidden, true);
  assert.equal(f.anchor.download, "fictional-recovery.json");
  assert.equal(await f.blobs[0].text(), body);
  assert.equal(f.blobs[0].type, "application/json;charset=utf-8");
  assert.equal(f.timers.length, 1);
  assert.equal(f.timers[0].delay, 60_000);
  f.timers[0].callback();
  assert.equal(f.events.at(-1), "revoke");
});

test("one-time credential download uses the same connected path with plaintext MIME, not a new issuance", async t => {
  const f = downloadFixture(t), token = "synthetic-not-an-accepted-credential\n";
  requestTextDownload("fictional-application.token", token, "text/plain;charset=utf-8");
  assert.equal(await f.blobs[0].text(), token);
  assert.equal(f.blobs[0].type, "text/plain;charset=utf-8");
  assert.equal(f.events.filter(value => value === "click").length, 1);
  const source = readFileSync(new URL("../../web/src/DataServicesWorkbench.tsx", import.meta.url), "utf8");
  const start = source.indexOf('requestTextDownload(`shuduo-application-');
  const handler = source.slice(start, source.indexOf("下载本次调用凭据</button>", start));
  assert.match(handler, /issuedToken\+"\\n"/);
  assert.doesNotMatch(handler, /setIssuedToken|createApplication|\/applications|api\(/);
  assert.match(handler, /未确认保存，本次令牌仍在卡片中保留/);
});

test("a thrown browser click still removes the anchor and schedules cleanup without claiming success", t => {
  const f = downloadFixture(t, { clickFailure: true });
  assert.throws(() => requestTextDownload("fixture.json", "{}"), /SYNTHETIC_CLICK_FAILED/);
  assert.deepEqual(f.events, ["url", "element", "append", "click", "remove", "schedule"]);
  f.timers[0].callback();
  assert.equal(f.events.at(-1), "revoke");
});

test("DOM append failure does not leak a created object URL", t => {
  const f = downloadFixture(t, { appendFailure: true });
  assert.throws(() => requestTextDownload("fixture.json", "{}"), /SYNTHETIC_APPEND_FAILED/);
  assert.deepEqual(f.events, ["url", "element", "append", "remove", "schedule"]);
  f.timers[0].callback();
  assert.equal(f.events.at(-1), "revoke");
});

test("unsupported object URLs produce no anchor, retry or follow-up operation", t => {
  const f = downloadFixture(t, { createFailure: true });
  assert.throws(() => requestTextDownload("fixture.json", "{}"), /SYNTHETIC_URL_FAILED/);
  assert.deepEqual(f.events, ["url"]);
  assert.equal(f.timers.length, 0);
});

const request = { kind: "recovery", type: "xapi", id: "fictional-service" };
const render = value => renderToStaticMarkup(React.createElement(EvidenceDownload, { name: "fictional-recovery.json", value, request }, "下载恢复对照"));
test("normal report view keeps a collapsed complete-text fallback without fetching or executing work", t => {
  t.mock.method(globalThis, "fetch", () => { throw Error("render must not request anything"); });
  const value = { protocol: "FICTIONAL_REPORT", applicationId: "fictional-application", privateText: "<script>not executable</script>" };
  const html = render(value);
  assert.match(html, /下载没有反应？查看报告文本/);
  assert.match(html, /展开不会请求接口、重新计算或创建凭证/);
  assert.match(html, /报告可能包含私有任务、版本和应用标识，请勿公开/);
  assert.match(html, /<details class="evidence-text">/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /fictional-application/);
  assert.match(html, /&lt;script&gt;not executable&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|dangerouslySetInnerHTML|文件已保存/);
  assert.match(html, /tabindex="0"[^>]*aria-label="fictional-recovery.json 报告文本"/i);
});

test("private-preview server export retains the same read-only text fallback from the page snapshot", t => {
  useDocument(t, { querySelector: () => ({ getAttribute: () => "true" }) });
  const html = render({ protocol: "FICTIONAL_REPORT", checkedAt: "2026-01-01T00:00:00Z", state: { status: "REVOKED" } });
  assert.match(html, /href="\/api\/v2\/evidence-export\?kind=recovery&amp;type=xapi&amp;id=fictional-service"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /本页已读取的报告快照/);
  assert.match(html, /REVOKED/);
  assert.match(html, /<details class="evidence-text">/);
});

test("unserializable or absent report data remains an explicit read-only recovery state", () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, undefined]) {
    const html = render(value);
    assert.match(html, /<button class="button" disabled=""/);
    assert.match(html, /报告文本暂不可用/);
    assert.match(html, /不会自动重跑任务/);
    assert.doesNotMatch(html, /<pre/);
  }
});
