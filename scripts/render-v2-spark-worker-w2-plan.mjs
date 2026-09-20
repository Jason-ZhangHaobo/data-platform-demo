import { fileURLToPath } from "node:url";
import { renderV2SparkWorkerPackagePolicy } from "./render-v2-spark-worker-package-policy.mjs";

const accountPattern = /^\d{12,20}$/;
const functionPattern = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const resourceIdPattern = /^[a-z][a-z0-9-]{5,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const MAX_HANGZHOU_ZIP_BYTES = 500 * 1024 * 1024;

export function renderV2SparkWorkerW2Plan(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim(),
    regionId = input.ALIBABA_CLOUD_REGION_ID?.trim(),
    functionName = input.V2_SPARK_WORKER_FUNCTION_NAME?.trim(),
    controlFunctionName = input.V2_FUNCTION_NAME?.trim(),
    bucket = input.V2_OSS_BUCKET?.trim(),
    digest = input.V2_SPARK_WORKER_PACKAGE_SHA256?.trim(),
    packageBytes = Number(input.V2_SPARK_WORKER_PACKAGE_BYTES),
    vpcId = input.V2_VPC_ID?.trim(),
    vSwitchId = input.V2_VSW_ID?.trim(),
    securityGroupId = input.V2_SECURITY_GROUP_ID?.trim(),
    secret = input.V2_SPARK_WORKER_SECRET,
    errors = [];
  if (!accountPattern.test(accountId ?? ""))
    errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (regionId !== "cn-hangzhou")
    errors.push("UNSUPPORTED:ALIBABA_CLOUD_REGION_ID");
  if (!functionPattern.test(functionName ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_FUNCTION_NAME");
  if (
    functionPattern.test(functionName ?? "") &&
    functionName === controlFunctionName
  )
    errors.push("WORKER_AND_CONTROL_FUNCTIONS_MUST_DIFFER");
  if (!bucketPattern.test(bucket ?? "")) errors.push("INVALID:V2_OSS_BUCKET");
  if (!digestPattern.test(digest ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_SHA256");
  if (
    !Number.isSafeInteger(packageBytes) ||
    packageBytes < 1 ||
    packageBytes > MAX_HANGZHOU_ZIP_BYTES
  )
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_BYTES");
  if (!resourceIdPattern.test(vpcId ?? "") || !vpcId.startsWith("vpc-"))
    errors.push("INVALID:V2_VPC_ID");
  if (
    !resourceIdPattern.test(vSwitchId ?? "") ||
    !vSwitchId.startsWith("vsw-")
  )
    errors.push("INVALID:V2_VSW_ID");
  if (
    !resourceIdPattern.test(securityGroupId ?? "") ||
    !securityGroupId.startsWith("sg-")
  )
    errors.push("INVALID:V2_SECURITY_GROUP_ID");
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512)
    errors.push("INVALID:V2_SPARK_WORKER_SECRET");
  const packagePolicy = renderV2SparkWorkerPackagePolicy(input);
  for (const error of packagePolicy.ok ? [] : packagePolicy.errors)
    if (!errors.includes(error)) errors.push(error);
  if (errors.length) return { ok: false, errors };

  const objectName = `data-platform-demo/v2/spark-worker/${digest}.zip`,
    layer = (name) =>
      `acs:fc:${regionId}:official:layers/${name}/versions/3`;
  return {
    ok: true,
    plan: {
      scope: "W2_PREPARED_NOT_DEPLOYED",
      publicDeployed: false,
      package: {
        bytes: packageBytes,
        sha256: digest,
        ossBucketName: bucket,
        ossObjectName: objectName,
        immutableUpload: true,
        uploadCommand: "ossutil api put-object --forbid-overwrite true",
        uploadMetadata: { "shuduo-sha256": digest },
        evidenceCommand: "ossutil api head-object --output-format json",
      },
      deploymentPermissionDelta: packagePolicy.policy,
      function: {
        functionName,
        description: "数舵V2隔离Spark Worker（W2私有验证）",
        code: { ossBucketName: bucket, ossObjectName: objectName },
        runtime: "custom.debian10",
        handler: "not-used",
        cpu: 1,
        memorySize: 2048,
        diskSize: 10240,
        timeout: 180,
        instanceConcurrency: 1,
        internetAccess: false,
        layers: [layer("Nodejs20"), layer("Python310"), layer("Java17")],
        customRuntimeConfig: {
          port: 9000,
          command: ["/opt/nodejs20/bin/node"],
          args: ["src/v2/remote-spark-worker.mjs"],
        },
        vpcConfig: {
          vpcId,
          vSwitchIds: [vSwitchId],
          securityGroupId,
        },
        environmentVariables: {
          PATH: "/opt/nodejs20/bin:/opt/python3.10/bin:/opt/java17/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:/opt/bin",
          JAVA_HOME: "/opt/java17",
          PYTHONPATH: "/code/python",
          V2_PYTHON: "/opt/python3.10/bin/python3",
          V2_ARTIFACT_ROOT: "/tmp",
          V2_RETAIN_SPARK_ARTIFACTS: "false",
          V2_SPARK_WORKER_RUN_TIMEOUT_MS: "120000",
          V2_SPARK_WORKER_MAX_BODY_BYTES: "2097152",
          V2_SPARK_WORKER_MAX_SKEW_MS: "60000",
          V2_SPARK_WORKER_PRIVATE_SMOKE_ENABLED: "true",
          V2_SPARK_WORKER_SECRET: "PROTECTED_SECRET_REFERENCE",
        },
      },
      concurrency: { reservedConcurrency: 1 },
      scaling: { minInstances: 0, enableOnDemandScaling: true },
      manualPrivateSmoke: {
        invoker: "LOGGED_IN_CLOUD_SHELL_ADMIN",
        protocol: "shuduo-spark-execution/v1",
        controlPlaneConnected: false,
      },
      futureControlPlanePermission: {
        authorized: false,
        action: "fc:InvokeFunction",
        resource: "*",
        requiredFrom: "W3_CONTROL_PLANE_INTEGRATION",
      },
    },
  };
}

function run() {
  const result = renderV2SparkWorkerW2Plan(process.env);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
