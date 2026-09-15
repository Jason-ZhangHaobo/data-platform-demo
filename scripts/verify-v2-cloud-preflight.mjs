import { lstatSync, readFileSync } from "node:fs";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateCloudPreflight,
  hasSensitiveEvidence,
} from "../src/v2/cloud-preflight.mjs";

export { evaluateCloudPreflight, hasSensitiveEvidence };

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function readPreflightEvidence(path) {
  const target = resolve(path),
    prefix = resolve(root, "docs", "evidence"),
    suffix = relative(prefix, target),
    stat = lstatSync(target);
  if (
    !suffix ||
    suffix.startsWith("..") ||
    suffix.includes(sep) ||
    !suffix.endsWith(".json") ||
    !stat.isFile() ||
    stat.isSymbolicLink()
  )
    throw new Error("审计证据必须是docs/evidence下的单个非链接JSON文件");
  const source = readFileSync(target, "utf8");
  if (source.length > 40_000) throw new Error("审计证据过大");
  return JSON.parse(source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new Error("用法：node scripts/verify-v2-cloud-preflight.mjs docs/evidence/审计.json");
    const result = evaluateCloudPreflight(readPreflightEvidence(path), Date.now(), {
      functionName: process.env.FUNCTION_NAME,
      publicUrl: process.env.PUBLIC_URL,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ready) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ ready: false, failedChecks: ["evidenceUnavailable"] })}\n`);
    process.exitCode = 1;
  }
}
