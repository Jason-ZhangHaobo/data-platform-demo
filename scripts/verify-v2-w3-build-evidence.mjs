import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const runPattern = /^https:\/\/github\.com\/Jason-ZhangHaobo\/data-platform-demo\/actions\/runs\/\d{6,20}$/;

export function verifyV2W3BuildEvidence(kind, env, evidence, sourceText) {
  if (!["worker", "controlPlane"].includes(kind))
    return { ok: false, code: "W3_BUILD_KIND_INVALID" };
  const record = evidence?.[kind];
  if (evidence?.schema !== "shuduo-v2-w3-package-build-evidence/v1" ||
      !commitPattern.test(evidence.sourceCommit ?? "") ||
      evidence.sourceModule !== "src/v2/remote-spark-queue.mjs" ||
      !shaPattern.test(evidence.sourceModuleSha256 ?? "") ||
      createHash("sha256").update(sourceText).digest("hex") !== evidence.sourceModuleSha256 ||
      !runPattern.test(record?.buildRun ?? "") || record?.buildStatus !== "success" ||
      record?.zipIntegrityVerified !== true || record?.embeddedSourceModuleMatches !== true ||
      !shaPattern.test(record?.innerZipSha256 ?? "") ||
      !Number.isSafeInteger(record?.innerZipBytes) || record.innerZipBytes < 1 ||
      (kind === "worker" && record.realSyntheticSparkSmokeInBuild !== true))
    return { ok: false, code: "W3_BUILD_EVIDENCE_INVALID" };
  const sha = kind === "worker" ? env.V2_SPARK_WORKER_PACKAGE_SHA256 : env.V2_CONTROL_PACKAGE_SHA256;
  const bytes = Number(kind === "worker" ? env.V2_SPARK_WORKER_PACKAGE_BYTES : env.V2_CONTROL_PACKAGE_BYTES);
  if (sha !== record.innerZipSha256 || bytes !== record.innerZipBytes)
    return { ok: false, code: "W3_BUILD_IDENTITY_MISMATCH" };
  if (kind === "controlPlane") {
    const runId = record.buildRun.split("/").at(-1);
    if (env.V2_CONTROL_PACKAGE_BUILD_RUN_ID !== runId ||
        env.V2_CONTROL_PACKAGE_BUILD_HEAD_SHA !== evidence.sourceCommit)
      return { ok: false, code: "W3_CONTROL_BUILD_RUN_MISMATCH" };
  }
  return { ok: true, kind, sha256: sha, bytes };
}

function run() {
  try {
    const kind = process.argv[2];
    if (!["worker", "controlPlane"].includes(kind)) throw new Error("W3_BUILD_KIND_INVALID");
    const evidence = JSON.parse(readFileSync(new URL("../docs/evidence/v2-w3-package-build-20260928.json", import.meta.url), "utf8"));
    const source = readFileSync(new URL("../src/v2/remote-spark-queue.mjs", import.meta.url), "utf8");
    const result = verifyV2W3BuildEvidence(kind, process.env, evidence, source);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z0-9_]{4,80}$/.test(error.message) ? error.message : "W3_BUILD_EVIDENCE_INVALID" }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
