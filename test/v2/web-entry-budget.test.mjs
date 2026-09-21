import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkV2WebEntryBudget } from "../../scripts/check-v2-web-entry-budget.mjs";

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-web-budget-"));
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(root, name), content);
  return root;
}

test("web entry budget measures only the single initial index entry", (t) => {
  const root = fixture({
    "index-demo.js": "console.log('agent-first')",
    "AgentCenter-demo.js": "x".repeat(100_000),
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = checkV2WebEntryBudget({ assetsDirectory: root, budgetBytes: 200 });
  assert.deepEqual(result, {
    ok: true,
    code: "OK",
    entryFilename: "index-demo.js",
    entryBytes: Buffer.byteLength("console.log('agent-first')"),
    entryGzipBytes: gzipSync("console.log('agent-first')").byteLength,
    budgetBytes: 200,
    measuredAtBuild: true,
    publicPerformanceVerified: false,
  });
});

test("web entry budget fails closed for an oversized or ambiguous entry", (t) => {
  const root = fixture({ "index-demo.js": "x".repeat(4_000) });
  const ambiguous = fixture({ "index-a.js": "a", "index-b.js": "b" });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(ambiguous, { recursive: true, force: true });
  });
  assert.equal(
    checkV2WebEntryBudget({ assetsDirectory: root, budgetBytes: 20 }).code,
    "V2_WEB_ENTRY_GZIP_BUDGET_EXCEEDED",
  );
  assert.deepEqual(checkV2WebEntryBudget({ assetsDirectory: ambiguous }), {
    ok: false,
    code: "V2_WEB_ENTRY_ASSET_AMBIGUOUS",
  });
});
