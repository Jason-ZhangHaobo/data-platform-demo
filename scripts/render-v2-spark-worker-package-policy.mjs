import { fileURLToPath } from "node:url";

const accountPattern = /^\d{12,20}$/;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function renderV2SparkWorkerPackagePolicy(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim(),
    bucket = input.V2_OSS_BUCKET?.trim(),
    digest = input.V2_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    errors = [];
  if (!accountPattern.test(accountId ?? ""))
    errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (!bucketPattern.test(bucket ?? "")) errors.push("INVALID:V2_OSS_BUCKET");
  if (!digestPattern.test(digest ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_SHA256");
  if (errors.length) return { ok: false, errors };
  const objectName = `data-platform-demo/v2/spark-worker/${digest}.zip`;
  return {
    ok: true,
    objectName,
    policy: {
      Version: "1",
      Statement: [
        {
          Effect: "Allow",
          Action: ["oss:GetObject", "oss:PutObject"],
          Resource: `acs:oss:*:${accountId}:${bucket}/${objectName}`,
        },
      ],
    },
  };
}

function run() {
  const result = renderV2SparkWorkerPackagePolicy(process.env);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result.policy, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
