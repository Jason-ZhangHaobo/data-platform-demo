import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  applyV2DeployPolicy,
  validateApplyInput,
} from "./apply-v2-deploy-policy.mjs";
import {
  applyV2SparkWorkerPackagePolicy,
  validateSparkWorkerPolicyApplyInput,
} from "./apply-v2-spark-worker-package-policy.mjs";

function defaultRunner(args) {
  const result = spawnSync(process.env.ALIYUN_CLI || "aliyun", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

export function validateV2W2MinimumPolicies(input = {}) {
  const deployment = validateApplyInput(input),
    workerPackage = validateSparkWorkerPolicyApplyInput(input),
    errors = [
      ...deployment.errors.map((error) => `DEPLOYMENT:${error}`),
      ...workerPackage.errors.map((error) => `WORKER_PACKAGE:${error}`),
    ];
  return {
    ok: errors.length === 0,
    errors,
    policies: {
      deployment: deployment.policyName,
      workerPackage: workerPackage.policyName,
    },
  };
}

export function applyV2W2MinimumPolicies(
  input = {},
  runner = defaultRunner,
) {
  const validated = validateV2W2MinimumPolicies(input);
  if (!validated.ok) return validated;
  const deployment = applyV2DeployPolicy(input, runner),
    workerPackage = applyV2SparkWorkerPackagePolicy(input, runner);
  if (!deployment.ok || !workerPackage.ok)
    throw new Error("W2_POLICY_BUNDLE_NOT_VERIFIED");
  return {
    ok: true,
    policies: {
      deployment: {
        policyName: deployment.policyName,
        created: deployment.created,
        attached: deployment.attached,
        verified: deployment.verified,
      },
      workerPackage: {
        policyName: workerPackage.policyName,
        created: workerPackage.created,
        attached: workerPackage.attached,
        verified: workerPackage.verified,
      },
    },
    boundaries: {
      productWildcards: false,
      ossListOrDelete: false,
      fcInvoke: false,
      policyReplacement: false,
    },
  };
}

function run() {
  const validated = validateV2W2MinimumPolicies(process.env);
  if (!process.argv.includes("--apply")) {
    process.stdout.write(JSON.stringify({ ...validated, apply: false }) + "\n");
    if (!validated.ok) process.exitCode = 1;
    return;
  }
  try {
    const result = applyV2W2MinimumPolicies(process.env);
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const code =
      typeof error.message === "string" &&
      /^[A-Z][A-Z0-9_:.-]{2,100}$/.test(error.message)
        ? error.message
        : "W2_POLICY_BUNDLE_APPLY_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();

