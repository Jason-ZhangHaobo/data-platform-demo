import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { runSpark, runtimeConfig } from "../src/v2/spark.mjs";
import { getContext, referenceSql } from "../src/v2/context.mjs";

const config = runtimeConfig();
if (!config.available) throw new Error("先执行 npm run v2:bootstrap");
const cases = [];
const base = { sql: referenceSql, context: getContext() };
let controller = new AbortController();
controller.abort();
await assert.rejects(
  runSpark({ ...base, signal: controller.signal }, config),
  /运行已取消/,
);
cases.push({ name: "cancelled-before-start", passed: true });
await assert.rejects(
  runSpark({ ...base, timeoutMs: 50 }, config),
  /Spark 执行超时，运行进程已终止/,
);
cases.push({ name: "deadline-terminates-child-process", passed: true });
controller = new AbortController();
const execution = runSpark({ ...base, signal: controller.signal }, config);
const timer = setTimeout(() => controller.abort(), 100);
try {
  await assert.rejects(execution, /运行已取消/);
} finally {
  clearTimeout(timer);
}
cases.push({ name: "cancel-terminates-child-process", passed: true });
const report = { scope: "LOCAL_PROCESS_LIFECYCLE_NOT_CLOUD_ISOLATION", cases };
mkdirSync(".v2-artifacts", { recursive: true });
writeFileSync(
  ".v2-artifacts/runtime-acceptance.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
