import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderV2DeployPolicy } from "./render-v2-deploy-policy.mjs";

const roleArnPattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const policyNamePattern = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

function parseJson(text, code) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(code);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function sameDocument(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function hasAttachedPolicy(response, policyName) {
  const policies = response?.Policies?.Policy;
  return Array.isArray(policies) && policies.some((policy) => policy?.PolicyName === policyName && policy?.PolicyType === "Custom");
}

function defaultRunner(args) {
  const command = process.env.ALIYUN_CLI || "aliyun";
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return {
    ok: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

function call(runner, args, code) {
  const result = runner(args);
  if (!result.ok) throw new Error(code);
  return parseJson(result.stdout, `${code}_INVALID_RESPONSE`);
}

export function validateApplyInput(input = {}) {
  const rendered = renderV2DeployPolicy(input);
  const deployMatch = roleArnPattern.exec(input.V2_DEPLOY_ROLE_ARN?.trim() ?? "");
  const functionMatch = roleArnPattern.exec(input.V2_FUNCTION_ROLE_ARN?.trim() ?? "");
  const policyName = input.V2_DEPLOY_POLICY_NAME?.trim() || "DataPlatformV2DeployMinimal";
  const errors = [...(rendered.ok ? [] : rendered.errors)];
  if (!deployMatch) errors.push("INVALID:V2_DEPLOY_ROLE_ARN");
  if (deployMatch && input.ALIYUN_ACCOUNT_ID && deployMatch[1] !== input.ALIYUN_ACCOUNT_ID.trim())
    errors.push("ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN");
  if (deployMatch && functionMatch && deployMatch[2] === functionMatch[2])
    errors.push("DEPLOYMENT_AND_RUNTIME_ROLES_MUST_DIFFER");
  if (!policyNamePattern.test(policyName)) errors.push("INVALID:V2_DEPLOY_POLICY_NAME");
  return {
    ok: errors.length === 0,
    errors,
    policyName,
    deployRoleName: deployMatch?.[2],
    policy: rendered.ok ? rendered.policy : undefined,
  };
}

export function applyV2DeployPolicy(input = {}, runner = defaultRunner) {
  const validated = validateApplyInput(input);
  if (!validated.ok) return validated;
  const { policyName, deployRoleName, policy } = validated;
  const policyDocument = JSON.stringify(policy);
  const getPolicyArgs = ["ram", "GetPolicy", "--PolicyType", "Custom", "--PolicyName", policyName];
  const existing = runner(getPolicyArgs);
  let created = false;

  if (!existing.ok) {
    if (!/EntityNotExist\.Policy|EntityNotExists\.Policy/.test(`${existing.stdout}\n${existing.stderr}`))
      throw new Error("GET_POLICY_FAILED");
    call(
      runner,
      [
        "ram",
        "CreatePolicy",
        "--PolicyName",
        policyName,
        "--Description",
        "Shuduo V2 GitHub staging deployment minimum permissions",
        "--PolicyDocument",
        policyDocument,
      ],
      "CREATE_POLICY_FAILED",
    );
    created = true;
  } else {
    const policyResponse = parseJson(existing.stdout, "GET_POLICY_INVALID_RESPONSE");
    const versionId = policyResponse?.Policy?.DefaultVersion;
    if (typeof versionId !== "string" || !/^v\d+$/.test(versionId)) throw new Error("POLICY_DEFAULT_VERSION_MISSING");
    const version = call(
      runner,
      ["ram", "GetPolicyVersion", "--PolicyType", "Custom", "--PolicyName", policyName, "--VersionId", versionId],
      "GET_POLICY_VERSION_FAILED",
    );
    const currentDocument = parseJson(version?.PolicyVersion?.PolicyDocument ?? "", "POLICY_DOCUMENT_INVALID");
    if (!sameDocument(currentDocument, policy)) throw new Error("POLICY_DOCUMENT_MISMATCH");
  }

  let policies = call(runner, ["ram", "ListPoliciesForRole", "--RoleName", deployRoleName], "LIST_ROLE_POLICIES_FAILED");
  let attached = hasAttachedPolicy(policies, policyName);
  if (!attached) {
    call(
      runner,
      ["ram", "AttachPolicyToRole", "--PolicyType", "Custom", "--PolicyName", policyName, "--RoleName", deployRoleName],
      "ATTACH_POLICY_FAILED",
    );
    policies = call(runner, ["ram", "ListPoliciesForRole", "--RoleName", deployRoleName], "VERIFY_ROLE_POLICIES_FAILED");
    attached = hasAttachedPolicy(policies, policyName);
  }
  if (!attached) throw new Error("POLICY_ATTACHMENT_NOT_VERIFIED");
  return { ok: true, policyName, created, attached: true, verified: true };
}

function run() {
  const validated = validateApplyInput(process.env);
  if (!process.argv.includes("--apply")) {
    process.stdout.write(`${JSON.stringify({ ok: validated.ok, errors: validated.errors, policyName: validated.policyName, apply: false })}\n`);
    if (!validated.ok) process.exitCode = 1;
    return;
  }
  try {
    const result = applyV2DeployPolicy(process.env);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.message })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
