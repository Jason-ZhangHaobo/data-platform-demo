import { fileURLToPath } from "node:url";

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

function boolean(value) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export function verifyV2SparkWorkerOssPrivacy(evidence = {}) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return { ok: false, errors: ["INVALID:OSS_PRIVACY_EVIDENCE"] };
  const bucketAcl = String(
      findValue(evidence.bucketAcl, ["grant", "acl"]) ?? "",
    ).toLowerCase(),
    objectAcl = String(
      findValue(evidence.objectAcl, ["grant", "acl"]) ?? "",
    ).toLowerCase(),
    policyIsPublic = boolean(
      findValue(evidence.bucketPolicyStatus, ["isPublic"]),
    ),
    blockPublicAccess = boolean(
      findValue(evidence.bucketPublicAccessBlock, ["blockPublicAccess"]),
    ),
    checks = {
      bucketAclPrivate: bucketAcl === "private",
      objectAclPrivateOrInherited: ["private", "default"].includes(objectAcl),
      bucketPolicyNotPublic: policyIsPublic === false,
      bucketPublicAccessBlocked: blockPublicAccess === true,
    },
    failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    evidence: {
      publicAccessVerified: failed.length === 0,
      verifiedBy: [
        "GetBucketAcl",
        "GetObjectAcl",
        "GetBucketPolicyStatus",
        "GetBucketPublicAccessBlock",
      ],
      containsResourceNames: false,
    },
  };
}

function run() {
  let raw = "",
    tooLarge = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) tooLarge = true;
  });
  process.stdin.on("end", () => {
    try {
      if (tooLarge) throw new Error("too large");
      const result = verifyV2SparkWorkerOssPrivacy(JSON.parse(raw || "{}"));
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    } catch {
      process.stderr.write(
        JSON.stringify({ ok: false, code: "OSS_PRIVACY_EVIDENCE_INVALID" }) +
          "\n",
      );
      process.exitCode = 1;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
