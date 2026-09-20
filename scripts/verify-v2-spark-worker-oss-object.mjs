import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const digestPattern = /^[a-f0-9]{64}$/;
const normalize = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

function findValue(value, names) {
  if (!value || typeof value !== "object") return undefined;
  const expected = new Set(names.map(normalize));
  for (const [key, item] of Object.entries(value)) {
    if (expected.has(normalize(key))) return item;
  }
  for (const item of Object.values(value)) {
    const found = findValue(item, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function verifyV2SparkWorkerOssObject(input = {}, rawEvidence) {
  const digest = input.V2_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    expectedBytes = Number(input.V2_SPARK_WORKER_PACKAGE_BYTES),
    objectName = input.V2_SPARK_WORKER_CODE_OBJECT?.trim(),
    errors = [];
  if (!digestPattern.test(digest ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_SHA256");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_BYTES");
  if (
    !objectName ||
    objectName !== `data-platform-demo/v2/spark-worker/${digest}.zip`
  )
    errors.push("INVALID:V2_SPARK_WORKER_CODE_OBJECT");
  if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence))
    errors.push("INVALID:OSS_HEAD_EVIDENCE");
  if (errors.length) return { ok: false, errors };

  const observedBytes = Number(
      findValue(rawEvidence, ["content-length", "contentLength", "size"]),
    ),
    observedDigest = String(
      findValue(rawEvidence, [
        "x-oss-meta-shuduo-sha256",
        "shuduo-sha256",
        "shuduoSha256",
      ]) ?? "",
    ).toLowerCase(),
    etag = String(findValue(rawEvidence, ["etag"]) ?? "")
      .replace(/"/g, "")
      .trim(),
    checks = {
      sizeMatches:
        Number.isSafeInteger(observedBytes) && observedBytes === expectedBytes,
      digestMetadataMatches: observedDigest === digest,
      etagPresent: /^[a-f0-9-]{16,128}$/i.test(etag),
    },
    failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    evidence: {
      objectKeyHash: createHash("sha256").update(objectName).digest("hex"),
      packageSha256: digest,
      packageBytes: expectedBytes,
      contentAddressedKey: true,
      overwriteProtectionVerified: false,
      publicAccessVerified: false,
    },
  };
}

function run() {
  try {
    const file = process.env.V2_SPARK_WORKER_HEAD_EVIDENCE_FILE;
    if (!file) throw new Error("MISSING:V2_SPARK_WORKER_HEAD_EVIDENCE_FILE");
    const evidence = JSON.parse(readFileSync(file, "utf8")),
      result = verifyV2SparkWorkerOssObject(process.env, evidence);
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        ok: false,
        code:
          typeof error.message === "string" &&
          /^[A-Z][A-Z0-9_:.-]{2,100}$/.test(error.message)
            ? error.message
            : "OSS_HEAD_EVIDENCE_INVALID",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
