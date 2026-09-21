import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

const digest = (value) => createHash("sha256").update(String(value)).digest();
const equalSecret = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string") return false;
  return timingSafeEqual(digest(left), digest(right));
};
const sameStrings = (left, right) =>
  Array.isArray(left) &&
  left.length === right.length &&
  [...left].sort().every((item, index) => item === [...right].sort()[index]);
const layerArn = (item) =>
  typeof item === "string"
    ? item
    : item?.arn ?? item?.layerVersionArn ?? item?.layerArn;

export function verifyV2SparkWorkerFunction(input = {}, evidence = {}) {
  const region = input.ALIBABA_CLOUD_REGION_ID?.trim(),
    expectedName = input.V2_SPARK_WORKER_FUNCTION_NAME?.trim(),
    expectedBytes = Number(input.V2_SPARK_WORKER_PACKAGE_BYTES),
    expectedSecret = input.V2_SPARK_WORKER_SECRET,
    expectedRole = input.V2_FUNCTION_ROLE_ARN?.trim(),
    vpcId = input.V2_VPC_ID?.trim(),
    vSwitchId = input.V2_VSW_ID?.trim(),
    securityGroupId = input.V2_SECURITY_GROUP_ID?.trim(),
    errors = [];
  if (region !== "cn-hangzhou")
    errors.push("UNSUPPORTED:ALIBABA_CLOUD_REGION_ID");
  if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(expectedName ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_FUNCTION_NAME");
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1)
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_BYTES");
  if (
    typeof expectedSecret !== "string" ||
    expectedSecret.length < 32 ||
    expectedSecret.length > 512
  )
    errors.push("INVALID:V2_SPARK_WORKER_SECRET");
  if (!/^acs:ram::\d{12,20}:role\/[a-z0-9-]{1,64}$/.test(expectedRole ?? ""))
    errors.push("INVALID:V2_FUNCTION_ROLE_ARN");
  if (!vpcId?.startsWith("vpc-")) errors.push("INVALID:V2_VPC_ID");
  if (!vSwitchId?.startsWith("vsw-")) errors.push("INVALID:V2_VSW_ID");
  if (!securityGroupId?.startsWith("sg-"))
    errors.push("INVALID:V2_SECURITY_GROUP_ID");
  if (
    !evidence.function ||
    !evidence.concurrency ||
    !evidence.scaling
  )
    errors.push("INVALID:SPARK_WORKER_FUNCTION_EVIDENCE");
  if (errors.length) return { ok: false, errors };

  const fn = evidence.function,
    env = fn.environmentVariables ?? {},
    runtime = fn.customRuntimeConfig ?? {},
    vpc = fn.vpcConfig ?? {},
    expectedLayers = ["Nodejs20", "Python310", "Java17"].map(
      (name) => `acs:fc:${region}:official:layers/${name}/versions/3`,
    ),
    checks = {
      identityMatches: fn.functionName === expectedName,
      stateActive: fn.state === "Active",
      updateSuccessful: fn.lastUpdateStatus === "Successful",
      codeSizeMatches: Number(fn.codeSize) === expectedBytes,
      runtimeMatches: fn.runtime === "custom.debian10",
      resourcesMatch:
        Number(fn.cpu) === 1 &&
        Number(fn.memorySize) === 2048 &&
        Number(fn.diskSize) === 10240 &&
        Number(fn.timeout) === 180,
      singleConcurrency: Number(fn.instanceConcurrency) === 1,
      noInternetEgress: fn.internetAccess === false,
      runtimeRoleMatches: fn.role === expectedRole,
      onDemandAllowed: fn.disableOndemand !== true,
      officialLayersMatch: sameStrings(
        (fn.layers ?? []).map(layerArn).filter(Boolean),
        expectedLayers,
      ),
      runtimeCommandMatches:
        Number(runtime.port) === 9000 &&
        sameStrings(runtime.command, ["/opt/nodejs20/bin/node"]) &&
        sameStrings(runtime.args, ["src/v2/remote-spark-worker.mjs"]),
      languagePathsMatch:
        env.JAVA_HOME === "/opt/java17" &&
        env.V2_PYTHON === "/opt/python3.10/bin/python3" &&
        env.PYTHONPATH === "/code/python" &&
        String(env.PATH ?? "").startsWith(
          "/opt/nodejs20/bin:/opt/python3.10/bin:/opt/java17/bin:",
        ),
      executionBoundsMatch:
        env.V2_ARTIFACT_ROOT === "/tmp" &&
        env.V2_RETAIN_SPARK_ARTIFACTS === "false" &&
        env.V2_SPARK_WORKER_RUN_TIMEOUT_MS === "120000" &&
        env.V2_SPARK_WORKER_MAX_BODY_BYTES === "2097152" &&
        env.V2_SPARK_WORKER_MAX_SKEW_MS === "60000" &&
        env.V2_SPARK_WORKER_PRIVATE_SMOKE_ENABLED === "true",
      protectedSecretMatches: equalSecret(
        env.V2_SPARK_WORKER_SECRET,
        expectedSecret,
      ),
      vpcMatches:
        vpc.vpcId === vpcId &&
        Array.isArray(vpc.vSwitchIds) &&
        vpc.vSwitchIds.length === 1 &&
        vpc.vSwitchIds[0] === vSwitchId &&
        vpc.securityGroupId === securityGroupId,
      reservedConcurrencyOne:
        Number(evidence.concurrency.reservedConcurrency) === 1,
      scalesToZero:
        Number(evidence.scaling.minInstances) === 0 &&
        evidence.scaling.enableOnDemandScaling !== false,
    },
    failed = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name);
  return {
    ok: failed.length === 0,
    checks,
    failed,
    evidence: {
      scope: "W2_FUNCTION_CONFIGURATION",
      publicDeployed: false,
      controlPlaneConnected: false,
      containsSecret: false,
    },
  };
}

function run() {
  let raw = "",
    tooLarge = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    raw += chunk;
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024) tooLarge = true;
  });
  process.stdin.on("end", () => {
    try {
      if (tooLarge) throw new Error("too large");
      const result = verifyV2SparkWorkerFunction(
        process.env,
        JSON.parse(raw || "{}"),
      );
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    } catch {
      process.stderr.write(
        JSON.stringify({ ok: false, code: "SPARK_WORKER_EVIDENCE_INVALID" }) +
          "\n",
      );
      process.exitCode = 1;
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
