import { fileURLToPath } from "node:url";
import { verifyV2SparkWorkerFunction } from "./verify-v2-spark-worker-function.mjs";

const recoverable = new Set([
  "runtimeRoleMatches",
  "reservedConcurrencyOne",
  "scalesToZero",
]);

export function verifyV2SparkWorkerRepair(input = {}, evidence = {}) {
  const result = verifyV2SparkWorkerFunction(input, evidence);
  if (result.errors?.length)
    return { ok: false, errors: result.errors, containsSecret: false };
  const failed = result.failed ?? [];
  if (failed.some((check) => !recoverable.has(check)))
    return {
      ok: false,
      code: "WORKER_REPAIR_SCOPE_EXCEEDED",
      failed,
      containsSecret: false,
    };
  return {
    ok: true,
    repairRequired: failed.length > 0,
    repairableChecks: failed,
    containsSecret: false,
  };
}

async function run() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) {
      process.stderr.write('{"ok":false,"code":"WORKER_REPAIR_EVIDENCE_TOO_LARGE"}\n');
      process.exitCode = 1;
      return;
    }
  }
  try {
    const result = verifyV2SparkWorkerRepair(process.env, JSON.parse(raw || "{}"));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch {
    process.stderr.write('{"ok":false,"code":"WORKER_REPAIR_EVIDENCE_INVALID"}\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await run();
