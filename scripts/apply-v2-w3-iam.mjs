import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderV2W3OssTriggerPlan } from "./render-v2-w3-oss-trigger-plan.mjs";

const rolePattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const policyNames = Object.freeze({
  packages: "ShuduoV2W3ExactPackages",
  control: "ShuduoV2W3ControlQueue",
  worker: "ShuduoV2W3WorkerQueue",
  trigger: "ShuduoV2W3OssInvoke",
});
const parse = (text, code) => {
  try { return JSON.parse(text); }
  catch { throw new Error(code); }
};
const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const document = (value, code) => {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch {
    if (!value.startsWith("%7B") && !value.startsWith("%7b")) throw new Error(code);
    return parse(decodeURIComponent(value), code);
  }
};
const isMissing = (response, type) =>
  new RegExp(`EntityNotExist(?:s)?\\.${type}`).test(`${response.stdout}\n${response.stderr}`);

function defaultRunner(args) {
  const profile = process.env.V2_ALIYUN_CLI_PROFILE;
  if (profile && !/^[A-Za-z0-9_-]{1,64}$/.test(profile))
    throw new Error("W3_CLI_PROFILE_INVALID");
  const result = spawnSync(process.env.ALIYUN_CLI || "aliyun", profile ? [...args, "--profile", profile] : args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
}
function call(runner, args, code) {
  const result = runner(args);
  if (!result.ok) throw new Error(code);
  return parse(result.stdout, `${code}_INVALID_RESPONSE`);
}
function getOptional(runner, args, type, code) {
  const result = runner(args);
  if (result.ok) return parse(result.stdout, `${code}_INVALID_RESPONSE`);
  if (isMissing(result, type)) return undefined;
  throw new Error(code);
}
function roleName(arn) { return rolePattern.exec(arn)?.[2]; }

export function validateV2W3IamInput(input = {}) {
  const plan = renderV2W3OssTriggerPlan(input),
    deploy = rolePattern.exec(input.V2_DEPLOY_ROLE_ARN?.trim() ?? ""),
    errors = plan.ok ? [] : [...plan.errors];
  if (!deploy) errors.push("INVALID:V2_DEPLOY_ROLE_ARN");
  else if (deploy[1] !== input.ALIYUN_ACCOUNT_ID?.trim())
    errors.push("ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN");
  const roleArns = [
    input.V2_DEPLOY_ROLE_ARN?.trim(),
    input.V2_FUNCTION_ROLE_ARN?.trim(),
    input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN?.trim(),
    input.V2_W3_OSS_TRIGGER_ROLE_ARN?.trim(),
  ];
  if (roleArns.every((arn) => rolePattern.test(arn ?? "")) && new Set(roleArns).size !== 4)
    errors.push("W3_ALL_FOUR_ROLES_MUST_BE_DISTINCT");
  return { ok: errors.length === 0, errors, plan: plan.ok ? plan : undefined, deployRoleName: deploy?.[2] };
}

export function applyV2W3Iam(input = {}, runner = defaultRunner) {
  const checked = validateV2W3IamInput(input);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const { plan, deployRoleName } = checked;
  const identity = call(runner, ["sts", "GetCallerIdentity"], "W3_IDENTITY_FAILED");
  if (identity?.AccountId !== input.ALIYUN_ACCOUNT_ID.trim())
    throw new Error("W3_ACCOUNT_MISMATCH");

  const roles = [
    { name: deployRoleName, kind: "existing" },
    { name: roleName(input.V2_FUNCTION_ROLE_ARN), kind: "existing" },
    { name: roleName(input.V2_W3_SPARK_WORKER_RUNTIME_ROLE_ARN), kind: "new", trust: plan.workerRuntimeRole.trustPolicy },
    { name: roleName(input.V2_W3_OSS_TRIGGER_ROLE_ARN), kind: "new", trust: plan.triggerInvocationRole.trustPolicy },
  ];
  const policies = [
    { name: policyNames.packages, role: deployRoleName, body: plan.packageUploadRole.exactObjectPolicy },
    { name: policyNames.control, role: roles[1].name, body: plan.controlPlane.queueOnlyPolicy },
    { name: policyNames.worker, role: roles[2].name, body: plan.workerRuntimeRole.queueOnlyPolicy },
    { name: policyNames.trigger, role: roles[3].name, body: plan.triggerInvocationRole.invocationPolicy },
  ];

  // Complete all read-only drift checks before the first write.
  for (const role of roles) {
    role.current = getOptional(runner, ["ram", "GetRole", "--RoleName", role.name], "Role", "W3_GET_ROLE_FAILED")?.Role;
    if (role.kind === "existing" && role.current?.RoleName !== role.name)
      throw new Error("W3_EXISTING_ROLE_MISSING");
    if (role.kind === "new" && role.current &&
        (role.current.RoleName !== role.name ||
         !same(document(role.current.AssumeRolePolicyDocument, "W3_ROLE_TRUST_INVALID"), role.trust)))
      throw new Error("W3_ROLE_TRUST_MISMATCH");
  }
  for (const policy of policies) {
    const existing = getOptional(runner,
      ["ram", "GetPolicy", "--PolicyType", "Custom", "--PolicyName", policy.name],
      "Policy", "W3_GET_POLICY_FAILED")?.Policy;
    if (existing) {
      const versionId = existing.DefaultVersion;
      if (!/^v\d+$/.test(versionId ?? "")) throw new Error("W3_POLICY_VERSION_INVALID");
      const version = call(runner,
        ["ram", "GetPolicyVersion", "--PolicyType", "Custom", "--PolicyName", policy.name, "--VersionId", versionId],
        "W3_GET_POLICY_VERSION_FAILED");
      if (!same(document(version?.PolicyVersion?.PolicyDocument, "W3_POLICY_DOCUMENT_INVALID"), policy.body))
        throw new Error("W3_POLICY_DOCUMENT_MISMATCH");
    }
    policy.exists = Boolean(existing);
  }
  for (const role of roles) {
    if (!role.current && role.kind === "new") continue;
    const attached = call(runner, ["ram", "ListPoliciesForRole", "--RoleName", role.name], "W3_LIST_POLICIES_FAILED")?.Policies?.Policy;
    if (!Array.isArray(attached)) throw new Error("W3_ROLE_POLICIES_INVALID");
    const permitted = policies.filter((p) => p.role === role.name).map((p) => p.name);
    if (role.kind === "new" && attached.some((p) => p.PolicyType !== "Custom" || !permitted.includes(p.PolicyName)))
      throw new Error("W3_NEW_ROLE_HAS_UNEXPECTED_POLICY");
  }

  const createdRoles = [], createdPolicies = [];
  for (const role of roles.filter((item) => item.kind === "new" && !item.current)) {
    call(runner,
      ["ram", "CreateRole", "--RoleName", role.name, "--Description", "Shuduo V2 W3 isolated private execution", "--AssumeRolePolicyDocument", JSON.stringify(role.trust)],
      "W3_CREATE_ROLE_FAILED");
    createdRoles.push(role.name);
  }
  for (const policy of policies.filter((item) => !item.exists)) {
    call(runner,
      ["ram", "CreatePolicy", "--PolicyName", policy.name, "--Description", "Shuduo V2 W3 fixed private boundary", "--PolicyDocument", JSON.stringify(policy.body)],
      "W3_CREATE_POLICY_FAILED");
    createdPolicies.push(policy.name);
  }
  for (const policy of policies) {
    const current = call(runner, ["ram", "ListPoliciesForRole", "--RoleName", policy.role], "W3_LIST_POLICIES_FAILED")?.Policies?.Policy;
    if (!Array.isArray(current)) throw new Error("W3_ROLE_POLICIES_INVALID");
    if (!current.some((p) => p.PolicyType === "Custom" && p.PolicyName === policy.name))
      call(runner,
        ["ram", "AttachPolicyToRole", "--PolicyType", "Custom", "--PolicyName", policy.name, "--RoleName", policy.role],
        "W3_ATTACH_POLICY_FAILED");
  }

  for (const role of roles.filter((item) => item.kind === "new")) {
    const found = call(runner, ["ram", "GetRole", "--RoleName", role.name], "W3_VERIFY_ROLE_FAILED")?.Role;
    if (found?.RoleName !== role.name ||
        !same(document(found.AssumeRolePolicyDocument, "W3_ROLE_TRUST_INVALID"), role.trust))
      throw new Error("W3_ROLE_TRUST_NOT_VERIFIED");
  }
  for (const policy of policies) {
    const metadata = call(runner,
      ["ram", "GetPolicy", "--PolicyType", "Custom", "--PolicyName", policy.name],
      "W3_VERIFY_POLICY_FAILED")?.Policy;
    if (!/^v\d+$/.test(metadata?.DefaultVersion ?? ""))
      throw new Error("W3_POLICY_VERSION_INVALID");
    const version = call(runner,
      ["ram", "GetPolicyVersion", "--PolicyType", "Custom", "--PolicyName", policy.name, "--VersionId", metadata.DefaultVersion],
      "W3_VERIFY_POLICY_VERSION_FAILED");
    if (!same(document(version?.PolicyVersion?.PolicyDocument, "W3_POLICY_DOCUMENT_INVALID"), policy.body))
      throw new Error("W3_POLICY_DOCUMENT_NOT_VERIFIED");
    const attached = call(runner, ["ram", "ListPoliciesForRole", "--RoleName", policy.role], "W3_VERIFY_ATTACHMENT_FAILED")?.Policies?.Policy;
    if (!Array.isArray(attached) || !attached.some((p) => p.PolicyType === "Custom" && p.PolicyName === policy.name))
      throw new Error("W3_POLICY_ATTACHMENT_NOT_VERIFIED");
  }
  return {
    ok: true,
    createdRoles,
    createdPolicies,
    attachedPolicies: policies.map(({ name }) => name),
    controlHasFcInvoke: false,
    cloudFunctionUpdated: false,
    ossTriggerCreated: false,
  };
}

function run() {
  const checked = validateV2W3IamInput(process.env);
  if (!process.argv.includes("--apply")) {
    process.stdout.write(JSON.stringify({ ok: checked.ok, errors: checked.errors, apply: false }) + "\n");
    if (!checked.ok) process.exitCode = 1;
    return;
  }
  if (process.env.V2_W3_IAM_APPROVAL !== "CONFIRMED") {
    process.stderr.write('{"ok":false,"code":"W3_IAM_APPROVAL_MISSING"}\n');
    process.exitCode = 1;
    return;
  }
  try { process.stdout.write(JSON.stringify(applyV2W3Iam(process.env)) + "\n"); }
  catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, code: /^[A-Z0-9_]{4,80}$/.test(error.message) ? error.message : "W3_IAM_APPLY_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
