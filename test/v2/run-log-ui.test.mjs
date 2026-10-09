import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { developmentRunLog } from "../../web/src/run-log.ts";

test("run logs display returned streams and error without silently dropping evidence", () => {
  const text = developmentRunLog({ id: "run-fixture", status: "FAILED", log: "worker-output", stdout: "rows-written", stderr: "spark-warning", error: "actual-error" });
  for (const value of ["run-fixture", "FAILED", "worker-output", "rows-written", "spark-warning", "actual-error"]) assert.ok(text.includes(value));
});

test("missing worker output is explicitly missing, not waiting for an unrelated model", () => {
  const text = developmentRunLog({ id: "run-fixture", status: "SUCCEEDED", stage: "COMPLETED", engine: "Apache Spark", engineVersion: "3.5.9", submittedAt: "2026-10-09T07:46:07Z", finishedAt: "2026-10-09T07:46:40Z", durationMs: 21313 });
  assert.match(text, /未包含 Worker 原始日志/);
  for (const value of ["COMPLETED", "Apache Spark 3.5.9", "21313 ms", "2026-10-09T07:46:07Z"]) assert.ok(text.includes(value));
  assert.doesNotMatch(text, /等待运行日志|任务执行成功/);
  assert.match(developmentRunLog(), /尚未提交运行/);
});

test("development layout reserves result space and permits scrolling in short windows", () => {
  const css = readFileSync(new URL("../../web/src/styles.css", import.meta.url), "utf8");
  const main = readFileSync(new URL("../../web/src/main.tsx", import.meta.url), "utf8");
  assert.match(css, /\.development-main\s*\{\s*overflow-y: auto;/);
  assert.match(css, /\.development-main \.work-area\s*\{\s*min-height: 560px;\s*flex: 1 0 560px;/);
  assert.match(main, /nav === "development" \? " development-main"/);
});
