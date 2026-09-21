import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const accountPattern = /^\d{12,20}$/;
const roleArnPattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const functionPattern = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_HANGZHOU_ZIP_BYTES = 500 * 1024 * 1024;

export const W3_QUEUE = Object.freeze({
  jobsPrefix: "data-platform-demo/v2/spark-queue/jobs/",
  resultsPrefix: "data-platform-demo/v2/spark-queue/results/",
  cancellationsPrefix: "data-platform-demo/v2/spark-queue/cancellations/",
  suffix: ".json",
  triggerName: "shuduo-v2-spark-queue-put-v1",
});

const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

function validRole(value, accountId, key, errors) {
  const match = roleArnPattern.exec(value ?? "");
  if (!match) errors.push(`INVALID:${key}`);
  else if (accountId && match[1] !== accountId)
    errors.push(`ACCOUNT_MISMATCH:${key}`);
  return match;
}

export function renderV2W3OssTriggerPlan(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim(),
    regionId = input.ALIBABA_CLOUD_REGION_ID?.trim(),
    controlRole = input.V2_FUNCTION_ROLE_ARN?.trim(),
    workerRuntimeRole = input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN?.trim(),
    triggerRole = input.V2_W3_OSS_TRIGGER_ROLE_ARN?.trim(),
    workerFunction = input.V2_SPARK_WORKER_FUNCTION_NAME?.trim(),
    bucket = input.V2_OSS_BUCKET?.trim(),
    currentDigest = input.V2_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    nextDigest = input.V2_W3_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    nextBytes = Number(input.V2_W3_SPARK_WORKER_PACKAGE_BYTES),
    errors = [];
  if (!accountPattern.test(accountId ?? ""))
    errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (regionId !== "cn-hangzhou")
    errors.push("UNSUPPORTED:ALIBABA_CLOUD_REGION_ID");
  const control = validRole(
    controlRole,
    accountId,
    "V2_FUNCTION_ROLE_ARN",
    errors,
  );
  const runtime = validRole(
    workerRuntimeRole,
    accountId,
    "V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN",
    errors,
  );
  validRole(triggerRole, accountId, "V2_W3_OSS_TRIGGER_ROLE_ARN", errors);
  if (control && runtime && controlRole === workerRuntimeRole)
    errors.push("W3_WORKER_RUNTIME_ROLE_MUST_DIFFER_FROM_CONTROL_ROLE");
  if (!functionPattern.test(workerFunction ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_FUNCTION_NAME");
  if (!bucketPattern.test(bucket ?? "")) errors.push("INVALID:V2_OSS_BUCKET");
  if (!digestPattern.test(currentDigest ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_SHA256");
  if (!digestPattern.test(nextDigest ?? ""))
    errors.push("INVALID:V2_W3_SPARK_WORKER_PACKAGE_SHA256");
  if (currentDigest && nextDigest && currentDigest === nextDigest)
    errors.push("W3_WORKER_PACKAGE_MUST_CHANGE");
  if (
    !Number.isSafeInteger(nextBytes) ||
    nextBytes < 1 ||
    nextBytes > MAX_HANGZHOU_ZIP_BYTES
  )
    errors.push("INVALID:V2_W3_SPARK_WORKER_PACKAGE_BYTES");
  if (errors.length) return { ok: false, errors };

  const packageObject = `data-platform-demo/v2/spark-worker/${nextDigest}.zip`;
  const objectArn = (key) => `acs:oss:*:${accountId}:${bucket}/${key}`;
  const runtimePolicy = {
    Version: "1",
    Statement: [
      {
        Effect: "Allow",
        Action: "oss:GetObject",
        Resource: [
          objectArn(packageObject),
          objectArn(`${W3_QUEUE.jobsPrefix}*`),
          objectArn(`${W3_QUEUE.cancellationsPrefix}*`),
        ],
      },
      {
        Effect: "Allow",
        Action: "oss:PutObject",
        Resource: objectArn(`${W3_QUEUE.resultsPrefix}*`),
      },
    ],
  };
  const triggerConfig = {
    events: ["oss:ObjectCreated:PutObject"],
    filter: { key: { prefix: W3_QUEUE.jobsPrefix, suffix: W3_QUEUE.suffix } },
  };

  return {
    ok: true,
    decision: "PENDING_EXPLICIT_W3_CLOUD_APPROVAL",
    apply: false,
    redacted: {
      controlRoleHash: hash(controlRole),
      workerRuntimeRoleHash: hash(workerRuntimeRole),
      triggerRoleHash: hash(triggerRole),
      workerFunctionHash: hash(workerFunction),
      bucketHash: hash(bucket),
    },
    immutablePackage: {
      sha256: nextDigest,
      bytes: nextBytes,
      ossObjectName: packageObject,
      uploadMustBeCreateOnly: true,
    },
    workerRuntimeRole: {
      mustDifferFromControlRole: true,
      trustPolicy: {
        Version: "1",
        Statement: [
          {
            Effect: "Allow",
            Action: "sts:AssumeRole",
            Principal: { Service: ["fc.aliyuncs.com"] },
          },
        ],
      },
      queueOnlyPolicy: runtimePolicy,
    },
    ossTrigger: {
      triggerType: "oss",
      triggerName: W3_QUEUE.triggerName,
      sourceArn: `acs:oss:${regionId}:${accountId}:${bucket}`,
      invocationRole: triggerRole,
      qualifier: "LATEST",
      triggerConfig: JSON.stringify(triggerConfig),
      emitsOnlyFor: {
        event: "oss:ObjectCreated:PutObject",
        prefix: W3_QUEUE.jobsPrefix,
        suffix: W3_QUEUE.suffix,
      },
      outputPrefixesExcluded: [
        W3_QUEUE.resultsPrefix,
        W3_QUEUE.cancellationsPrefix,
      ],
    },
    controlPlane: {
      fcInvokePermission: false,
      requiredObjectCapabilities: {
        createOnlyJob: W3_QUEUE.jobsPrefix,
        writeCancellation: W3_QUEUE.cancellationsPrefix,
        readSignedResult: W3_QUEUE.resultsPrefix,
      },
    },
    requiredCloudActions: [
      "ram:CreateRole",
      "ram:CreatePolicy",
      "ram:AttachPolicyToRole",
      "ram:PassRole",
      "fc:UpdateFunction",
      "fc:CreateTrigger",
      "fc:GetTrigger",
    ],
    resourceScoping: {
      queueObjects: "EXACT_PREFIXES_ONLY",
      fcCreateTrigger: "ACCOUNT_WIDE_ACTION_PER_OFFICIAL_RAM_TABLE",
      fcInvokeFunctionOnControlRole: "NOT_GRANTED",
    },
    verification: [
      "rebuild the Linux Worker package and verify digest and byte count",
      "upload the new package create-only and create a fresh private-OSS receipt",
      "read back the Worker role and verify the queue-only policy",
      "read back one OSS trigger and require its event plus exact prefix and suffix",
      "submit one signed synthetic job, verify one signed result and reject tampering",
      "verify cancellation, timeout, cold-start recovery and no control-role fc:InvokeFunction",
    ],
    rollback: [
      "disable or delete only the named OSS trigger",
      "stop creating queue job objects",
      "restore the already verified Worker code only after its immutable receipt is revalidated",
      "retain signed job/result evidence for audit; do not delete artifacts as rollback",
    ],
  };
}

function run() {
  const result = renderV2W3OssTriggerPlan(process.env);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
