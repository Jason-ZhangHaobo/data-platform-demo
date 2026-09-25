import { fileURLToPath } from "node:url";

const accountPattern = /^\d{12,20}$/;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const digestPattern = /^[a-f0-9]{64}$/;
export const controlPackageObject = (digest) =>
  `data-platform-demo/v2/control-plane/${digest}.zip`;

export function renderV2ControlPackagePolicy(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim(),
    bucket = input.V2_OSS_BUCKET?.trim(),
    digest = input.V2_CONTROL_PACKAGE_SHA256?.trim(),
    bytes = Number(input.V2_CONTROL_PACKAGE_BYTES),
    errors = [];
  if (!accountPattern.test(accountId ?? ""))
    errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (!bucketPattern.test(bucket ?? "")) errors.push("INVALID:V2_OSS_BUCKET");
  if (!digestPattern.test(digest ?? ""))
    errors.push("INVALID:V2_CONTROL_PACKAGE_SHA256");
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 73400320)
    errors.push("INVALID:V2_CONTROL_PACKAGE_BYTES");
  if (errors.length) return { ok: false, errors };
  const objectName = controlPackageObject(digest);
  return {
    ok: true,
    objectName,
    policy: {
      Version: "1",
      Statement: [{
        Effect: "Allow",
        Action: ["oss:GetObject", "oss:PutObject"],
        Resource: `acs:oss:*:${accountId}:${bucket}/${objectName}`,
      }],
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = renderV2ControlPackagePolicy(process.env);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
  } else process.stdout.write(JSON.stringify(result.policy, null, 2) + "\n");
}
