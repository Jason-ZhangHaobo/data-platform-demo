import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { controlPackageObject, renderV2ControlPackagePolicy } from "./render-v2-control-package-policy.mjs";
import { verifyV2SparkWorkerOssPrivacy } from "./verify-v2-spark-worker-oss-privacy.mjs";

const shaPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const runPattern = /^\d{6,20}$/;
const TTL_MS = 6 * 60 * 60 * 1000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

function findValue(value, names) {
  if (!value || typeof value !== "object") return undefined;
  const wanted = new Set(names.map(normalize));
  for (const [key, item] of Object.entries(value))
    if (wanted.has(normalize(key))) return item;
  for (const item of Object.values(value)) {
    const found = findValue(item, names);
    if (found !== undefined) return found;
  }
  return undefined;
}

function identity(input) {
  const policy = renderV2ControlPackagePolicy(input);
  const sha = input.V2_CONTROL_PACKAGE_SHA256?.trim();
  const bytes = Number(input.V2_CONTROL_PACKAGE_BYTES);
  const object = controlPackageObject(sha);
  const uploadRunId = input.V2_CONTROL_PACKAGE_UPLOAD_RUN_ID?.trim();
  const uploadHeadSha = input.V2_CONTROL_PACKAGE_UPLOAD_HEAD_SHA?.trim();
  const errors = [...(policy.ok ? [] : policy.errors)];
  if (input.V2_CONTROL_CODE_OBJECT !== object)
    errors.push("INVALID:V2_CONTROL_CODE_OBJECT");
  if (!runPattern.test(uploadRunId ?? ""))
    errors.push("INVALID:V2_CONTROL_PACKAGE_UPLOAD_RUN_ID");
  if (!commitPattern.test(uploadHeadSha ?? ""))
    errors.push("INVALID:V2_CONTROL_PACKAGE_UPLOAD_HEAD_SHA");
  return { ok: errors.length === 0, errors, sha, bytes, object, uploadRunId, uploadHeadSha };
}

export function createV2ControlPackageOssReceipt(input = {}, evidence = {}, now = new Date()) {
  const id = identity(input);
  if (!id.ok) return id;
  const head = evidence.head;
  const observedBytes = Number(findValue(head, ["content-length", "contentLength", "size"]));
  const observedSha = String(findValue(head, ["x-oss-meta-shuduo-sha256", "shuduo-sha256", "shuduoSha256"]) ?? "").toLowerCase();
  const etag = String(findValue(head, ["etag"]) ?? "").replace(/"/g, "").trim();
  const contentChecks = {
    sizeMatches: Number.isSafeInteger(observedBytes) && observedBytes === id.bytes,
    digestMetadataMatches: shaPattern.test(observedSha) && observedSha === id.sha,
    etagPresent: /^[a-f0-9-]{16,128}$/i.test(etag),
    downloadedBytesVerified: evidence.downloadedSha256 === id.sha && Number(evidence.downloadedBytes) === id.bytes,
  };
  const privacy = verifyV2SparkWorkerOssPrivacy(evidence);
  if (Object.values(contentChecks).some((passed) => !passed) || !privacy.ok)
    return { ok: false, errors: [
      ...(Object.values(contentChecks).every(Boolean) ? [] : ["OSS_CONTENT_EVIDENCE_FAILED"]),
      ...(privacy.ok ? [] : ["OSS_PRIVACY_EVIDENCE_FAILED"]),
    ] };
  return { ok: true, receipt: {
    schema: "shuduo-v2-control-oss-receipt/v1",
    packageSha256: id.sha,
    packageBytes: id.bytes,
    objectKeyHash: hash(id.object),
    uploadRun: { id: id.uploadRunId, headSha: id.uploadHeadSha },
    verifiedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + TTL_MS).toISOString(),
    contentChecks,
    privacyChecks: privacy.checks,
    publicAccessVerified: true,
    containsResourceNames: false,
  } };
}

export function verifyV2ControlPackageOssReceipt(input = {}, receipt, now = new Date()) {
  const id = identity(input);
  if (!id.ok) return id;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    return { ok: false, failed: ["receiptPresent"] };
  const verifiedAt = Date.parse(receipt.verifiedAt);
  const validUntil = Date.parse(receipt.validUntil);
  const allTrue = (value) => value && typeof value === "object" &&
    Object.values(value).length > 0 && Object.values(value).every((item) => item === true);
  const checks = {
    schemaMatches: receipt.schema === "shuduo-v2-control-oss-receipt/v1",
    packageMatches: receipt.packageSha256 === id.sha && Number(receipt.packageBytes) === id.bytes,
    objectMatches: receipt.objectKeyHash === hash(id.object),
    uploadRunMatches: receipt.uploadRun?.id === id.uploadRunId && receipt.uploadRun?.headSha === id.uploadHeadSha,
    contentChecksPass: allTrue(receipt.contentChecks),
    privacyChecksPass: allTrue(receipt.privacyChecks),
    publicAccessVerified: receipt.publicAccessVerified === true,
    resourceNamesAbsent: receipt.containsResourceNames === false,
    timeWindowValid: Number.isFinite(verifiedAt) && Number.isFinite(validUntil) &&
      verifiedAt <= now.getTime() + 5 * 60 * 1000 && validUntil > now.getTime() && validUntil - verifiedAt === TTL_MS,
  };
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { ok: failed.length === 0, checks, failed, publicDeployed: false };
}

async function stdinJson() {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("OSS_RECEIPT_INPUT_TOO_LARGE");
  }
  return JSON.parse(raw || "{}");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    let result;
    if (process.argv.includes("--create"))
      result = createV2ControlPackageOssReceipt(process.env, await stdinJson());
    else if (process.argv.includes("--verify")) {
      const configured = process.env.V2_CONTROL_PACKAGE_OSS_RECEIPT_FILE;
      if (!configured) throw new Error("MISSING:V2_CONTROL_PACKAGE_OSS_RECEIPT_FILE");
      const root = realpathSync(resolve("docs/evidence"));
      const target = resolve(configured);
      const rel = relative(root, target);
      if (rel.startsWith("..") || rel.includes("/") ||
          !/^v2-control-oss-receipt-[0-9TZ_.-]+\.json$/.test(rel) ||
          lstatSync(target).isSymbolicLink() || realpathSync(target) !== target)
        throw new Error("UNSAFE:V2_CONTROL_PACKAGE_OSS_RECEIPT_FILE");
      result = verifyV2ControlPackageOssReceipt(process.env, JSON.parse(readFileSync(target, "utf8")));
    } else throw new Error("USAGE:OSS_RECEIPT_MODE_REQUIRED");
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    const code = typeof error.message === "string" && /^[A-Z][A-Z0-9_:.-]{2,100}$/.test(error.message)
      ? error.message : "OSS_RECEIPT_INVALID";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}
