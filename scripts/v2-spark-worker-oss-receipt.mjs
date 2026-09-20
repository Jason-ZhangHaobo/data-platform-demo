import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { verifyV2SparkWorkerOssObject } from "./verify-v2-spark-worker-oss-object.mjs";
import { verifyV2SparkWorkerOssPrivacy } from "./verify-v2-spark-worker-oss-privacy.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const runPattern = /^\d{6,20}$/;
const RECEIPT_TTL_MS = 6 * 60 * 60 * 1000;

const expectedObjectKeyHash = (input) =>
  createHash("sha256")
    .update(input.V2_SPARK_WORKER_CODE_OBJECT ?? "")
    .digest("hex");

function validateIdentity(input = {}) {
  const sha = input.V2_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    bytes = Number(input.V2_SPARK_WORKER_PACKAGE_BYTES),
    object = input.V2_SPARK_WORKER_CODE_OBJECT?.trim(),
    runId = input.V2_SPARK_WORKER_UPLOAD_RUN_ID?.trim(),
    headSha = input.V2_SPARK_WORKER_UPLOAD_HEAD_SHA?.trim(),
    errors = [];
  if (!sha256Pattern.test(sha ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_SHA256");
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_BYTES");
  if (object !== `data-platform-demo/v2/spark-worker/${sha}.zip`)
    errors.push("INVALID:V2_SPARK_WORKER_CODE_OBJECT");
  if (!runPattern.test(runId ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_UPLOAD_RUN_ID");
  if (!commitPattern.test(headSha ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_UPLOAD_HEAD_SHA");
  return { ok: errors.length === 0, errors, sha, bytes, runId, headSha };
}

export function createV2SparkWorkerOssReceipt(
  input = {},
  evidence = {},
  now = new Date(),
) {
  const identity = validateIdentity(input);
  if (!identity.ok) return identity;
  const content = verifyV2SparkWorkerOssObject(input, evidence.head),
    privacy = verifyV2SparkWorkerOssPrivacy(evidence);
  if (!content.ok || !privacy.ok)
    return {
      ok: false,
      errors: [
        ...(content.ok ? [] : ["OSS_CONTENT_EVIDENCE_FAILED"]),
        ...(privacy.ok ? [] : ["OSS_PRIVACY_EVIDENCE_FAILED"]),
      ],
      content: content.ok ? content.checks : undefined,
      privacy: privacy.ok ? privacy.checks : undefined,
    };
  const verifiedAt = now.toISOString();
  return {
    ok: true,
    receipt: {
      schema: "shuduo-spark-worker-oss-receipt/v1",
      packageSha256: identity.sha,
      packageBytes: identity.bytes,
      objectKeyHash: content.evidence.objectKeyHash,
      uploadRun: { id: identity.runId, headSha: identity.headSha },
      verifiedAt,
      validUntil: new Date(now.getTime() + RECEIPT_TTL_MS).toISOString(),
      contentChecks: content.checks,
      privacyChecks: privacy.checks,
      publicAccessVerified: true,
      containsResourceNames: false,
    },
  };
}

export function verifyV2SparkWorkerOssReceipt(
  input = {},
  receipt,
  now = new Date(),
) {
  const identity = validateIdentity(input);
  if (!identity.ok) return identity;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    return { ok: false, errors: ["INVALID:OSS_RECEIPT"] };
  const verifiedAt = Date.parse(receipt.verifiedAt),
    validUntil = Date.parse(receipt.validUntil),
    nowMs = now.getTime(),
    allTrue = (value) =>
      value &&
      typeof value === "object" &&
      Object.values(value).length > 0 &&
      Object.values(value).every((item) => item === true),
    checks = {
      schemaMatches: receipt.schema === "shuduo-spark-worker-oss-receipt/v1",
      packageMatches:
        receipt.packageSha256 === identity.sha &&
        Number(receipt.packageBytes) === identity.bytes,
      objectKeyMatches:
        receipt.objectKeyHash === expectedObjectKeyHash(input),
      uploadRunMatches:
        receipt.uploadRun?.id === identity.runId &&
        receipt.uploadRun?.headSha === identity.headSha,
      contentChecksPass: allTrue(receipt.contentChecks),
      privacyChecksPass: allTrue(receipt.privacyChecks),
      publicAccessVerified: receipt.publicAccessVerified === true,
      containsNoResourceNames: receipt.containsResourceNames === false,
      timeWindowValid:
        Number.isFinite(verifiedAt) &&
        Number.isFinite(validUntil) &&
        verifiedAt <= nowMs + 5 * 60 * 1000 &&
        validUntil > nowMs &&
        validUntil - verifiedAt === RECEIPT_TTL_MS,
    },
    failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    evidence: {
      scope: "W2_OSS_CREATE_GATE",
      publicAccessVerified: failed.length === 0,
      containsResourceNames: false,
    },
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
        reject(new Error("OSS_RECEIPT_INPUT_TOO_LARGE"));
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", reject);
  });
}

async function run() {
  try {
    let result;
    if (process.argv.includes("--create")) {
      result = createV2SparkWorkerOssReceipt(
        process.env,
        JSON.parse((await readStdin()) || "{}"),
      );
    } else if (process.argv.includes("--verify")) {
      const configured = process.env.V2_SPARK_WORKER_OSS_RECEIPT_FILE;
      if (!configured) throw new Error("MISSING:V2_SPARK_WORKER_OSS_RECEIPT_FILE");
      const evidenceRoot = realpathSync(resolve("docs/evidence")),
        file = resolve(configured),
        relation = relative(evidenceRoot, file);
      if (
        relation.startsWith("..") ||
        relation.includes("/") ||
        !/^v2-spark-worker-oss-receipt-[0-9TZ_.-]+\.json$/.test(relation) ||
        lstatSync(file).isSymbolicLink() ||
        realpathSync(file) !== file
      )
        throw new Error("UNSAFE:V2_SPARK_WORKER_OSS_RECEIPT_FILE");
      result = verifyV2SparkWorkerOssReceipt(
        process.env,
        JSON.parse(readFileSync(file, "utf8")),
      );
    } else throw new Error("USAGE:OSS_RECEIPT_MODE_REQUIRED");
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const code =
      typeof error.message === "string" &&
      /^[A-Z][A-Z0-9_:.-]{2,100}$/.test(error.message)
        ? error.message
        : "OSS_RECEIPT_INVALID";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  await run();
