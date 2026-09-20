import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderV2SparkWorkerPackagePolicy } from "./render-v2-spark-worker-package-policy.mjs";

const roleArnPattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const policyNamePattern = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const parseJson = (value, code) => {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(code);
  }
};
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
};
const sameDocument = (left, right) =>
  JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const hasAttachedPolicy = (response, policyName) =>
  Array.isArray(response?.Policies?.Policy) &&
  response.Policies.Policy.some(
    (policy) =>
      policy?.PolicyName === policyName && policy?.PolicyType === "Custom",
  );

function defaultRunner(args) {
  const result = spawnSync(process.env.ALIYUN_CLI || "aliyun", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function call(runner, args, code) {
  const result = runner(args);
  if (!result.ok) throw new Error(code);
  return parseJson(result.stdout, `${code}_INVALID_RESPONSE`);
}

export function validateSparkWorkerPolicyApplyInput(input = {}) {
  const rendered = renderV2SparkWorkerPackagePolicy(input),
    deployMatch = roleArnPattern.exec(
      input.V2_DEPLOY_ROLE_ARN?.trim() ?? "",
    ),
    policyName =
      input.V2_SPARK_WORKER_PACKAGE_POLICY_NAME?.trim() ||
      "DataPlatformV2SparkWorkerPackageMinimal",
    errors = [...(rendered.ok ? [] : rendered.errors)];
  if (!deployMatch) errors.push("INVALID:V2_DEPLOY_ROLE_ARN");
  if (
    deployMatch &&
    input.ALIYUN_ACCOUNT_ID &&
    deployMatch[1] !== input.ALIYUN_ACCOUNT_ID.trim()
  )
    errors.push("ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN");
  if (!policyNamePattern.test(policyName))
    errors.push("INVALID:V2_SPARK_WORKER_PACKAGE_POLICY_NAME");
  return {
    ok: errors.length === 0,
    errors,
    policyName,
    deployRoleName: deployMatch?.[2],
    policy: rendered.ok ? rendered.policy : undefined,
  };
}

export function applyV2SparkWorkerPackagePolicy(
  input = {},
  runner = defaultRunner,
) {
  const validated = validateSparkWorkerPolicyApplyInput(input);
  if (!validated.ok) return validated;
  const { policyName, deployRoleName, policy } = validated,
    getArgs = [
      "ram",
      "GetPolicy",
      "--PolicyType",
      "Custom",
      "--PolicyName",
      policyName,
    ],
    existing = runner(getArgs);
  let created = false;
  if (!existing.ok) {
    if (
      !/EntityNotExist\.Policy|EntityNotExists\.Policy/.test(
        `${existing.stdout}\n${existing.stderr}`,
      )
    )
      throw new Error("GET_POLICY_FAILED");
    call(
      runner,
      [
        "ram",
        "CreatePolicy",
        "--PolicyName",
        policyName,
        "--Description",
        "Shuduo V2 Spark Worker exact package object access",
        "--PolicyDocument",
        JSON.stringify(policy),
      ],
      "CREATE_POLICY_FAILED",
    );
    created = true;
  } else {
    const current = parseJson(existing.stdout, "GET_POLICY_INVALID_RESPONSE"),
      versionId = current?.Policy?.DefaultVersion;
    if (typeof versionId !== "string" || !/^v\d+$/.test(versionId))
      throw new Error("POLICY_DEFAULT_VERSION_MISSING");
    const version = call(
        runner,
        [
          "ram",
          "GetPolicyVersion",
          "--PolicyType",
          "Custom",
          "--PolicyName",
          policyName,
          "--VersionId",
          versionId,
        ],
        "GET_POLICY_VERSION_FAILED",
      ),
      document = parseJson(
        version?.PolicyVersion?.PolicyDocument ?? "",
        "POLICY_DOCUMENT_INVALID",
      );
    if (!sameDocument(document, policy))
      throw new Error("POLICY_DOCUMENT_MISMATCH");
  }
  let policies = call(
      runner,
      ["ram", "ListPoliciesForRole", "--RoleName", deployRoleName],
      "LIST_ROLE_POLICIES_FAILED",
    ),
    attached = hasAttachedPolicy(policies, policyName);
  if (!attached) {
    call(
      runner,
      [
        "ram",
        "AttachPolicyToRole",
        "--PolicyType",
        "Custom",
        "--PolicyName",
        policyName,
        "--RoleName",
        deployRoleName,
      ],
      "ATTACH_POLICY_FAILED",
    );
    policies = call(
      runner,
      ["ram", "ListPoliciesForRole", "--RoleName", deployRoleName],
      "VERIFY_ROLE_POLICIES_FAILED",
    );
    attached = hasAttachedPolicy(policies, policyName);
  }
  if (!attached) throw new Error("POLICY_ATTACHMENT_NOT_VERIFIED");
  return {
    ok: true,
    policyName,
    created,
    attached: true,
    verified: true,
  };
}

function run() {
  const validated = validateSparkWorkerPolicyApplyInput(process.env);
  if (!process.argv.includes("--apply")) {
    process.stdout.write(
      JSON.stringify({
        ok: validated.ok,
        errors: validated.errors,
        policyName: validated.policyName,
        apply: false,
      }) + "\n",
    );
    if (!validated.ok) process.exitCode = 1;
    return;
  }
  try {
    process.stdout.write(
      JSON.stringify(applyV2SparkWorkerPackagePolicy(process.env)) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({ ok: false, code: error.message }) + "\n",
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
