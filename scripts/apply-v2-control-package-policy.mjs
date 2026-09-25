import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderV2ControlPackagePolicy } from "./render-v2-control-package-policy.mjs";

const roleArnPattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const policyName = "DataPlatformV2ControlPackageMinimal";

const canonical = (value) => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const parse = (value, code) => {
  try { return JSON.parse(value); } catch { throw new Error(code); }
};
const defaultRunner = (args) => {
  const result = spawnSync(process.env.ALIYUN_CLI || "aliyun", args, {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
  });
  return { ok: result.status === 0, stdout: result.stdout || "", stderr: result.stderr || "" };
};
const call = (runner, args, code) => {
  const result = runner(args);
  if (!result.ok) throw new Error(code);
  return parse(result.stdout, `${code}_INVALID_RESPONSE`);
};

export function validateControlPackageApply(input = {}) {
  const rendered = renderV2ControlPackagePolicy(input);
  const deploy = roleArnPattern.exec(input.V2_DEPLOY_ROLE_ARN?.trim() ?? "");
  const errors = [...(rendered.ok ? [] : rendered.errors)];
  if (!deploy) errors.push("INVALID:V2_DEPLOY_ROLE_ARN");
  if (deploy && input.ALIYUN_ACCOUNT_ID && deploy[1] !== input.ALIYUN_ACCOUNT_ID.trim())
    errors.push("ACCOUNT_MISMATCH:V2_DEPLOY_ROLE_ARN");
  return { ok: errors.length === 0, errors, policyName, roleName: deploy?.[2], policy: rendered.ok ? rendered.policy : undefined };
}

export function applyV2ControlPackagePolicy(input = {}, runner = defaultRunner) {
  const validated = validateControlPackageApply(input);
  if (!validated.ok) return validated;
  const existing = runner(["ram", "GetPolicy", "--PolicyType", "Custom", "--PolicyName", policyName]);
  let created = false;
  if (!existing.ok) {
    if (!/EntityNotExist\.Policy|EntityNotExists\.Policy/.test(`${existing.stdout}\n${existing.stderr}`))
      throw new Error("GET_POLICY_FAILED");
    call(runner, [
      "ram", "CreatePolicy", "--PolicyName", policyName,
      "--Description", "Shuduo V2 control exact private OSS code object",
      "--PolicyDocument", JSON.stringify(validated.policy),
    ], "CREATE_POLICY_FAILED");
    created = true;
  } else {
    const versionId = parse(existing.stdout, "GET_POLICY_INVALID_RESPONSE")?.Policy?.DefaultVersion;
    if (typeof versionId !== "string" || !/^v\d+$/.test(versionId))
      throw new Error("POLICY_DEFAULT_VERSION_MISSING");
    const version = call(runner, [
      "ram", "GetPolicyVersion", "--PolicyType", "Custom",
      "--PolicyName", policyName, "--VersionId", versionId,
    ], "GET_POLICY_VERSION_FAILED");
    const current = parse(version?.PolicyVersion?.PolicyDocument ?? "", "POLICY_DOCUMENT_INVALID");
    if (!same(current, validated.policy)) throw new Error("POLICY_DOCUMENT_MISMATCH");
  }
  const hasPolicy = (value) => Array.isArray(value?.Policies?.Policy) &&
    value.Policies.Policy.some((item) => item.PolicyName === policyName && item.PolicyType === "Custom");
  let attached = hasPolicy(call(runner, [
    "ram", "ListPoliciesForRole", "--RoleName", validated.roleName,
  ], "LIST_ROLE_POLICIES_FAILED"));
  if (!attached) {
    call(runner, [
      "ram", "AttachPolicyToRole", "--PolicyType", "Custom",
      "--PolicyName", policyName, "--RoleName", validated.roleName,
    ], "ATTACH_POLICY_FAILED");
    attached = hasPolicy(call(runner, [
      "ram", "ListPoliciesForRole", "--RoleName", validated.roleName,
    ], "VERIFY_ROLE_POLICIES_FAILED"));
  }
  if (!attached) throw new Error("POLICY_ATTACHMENT_NOT_VERIFIED");
  return { ok: true, policyName, created, attached: true, verified: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (!process.argv.includes("--apply")) {
      const result = validateControlPackageApply(process.env);
      process.stdout.write(JSON.stringify({ok:result.ok,errors:result.errors,policyName,apply:false}) + "\n");
      if (!result.ok) process.exitCode = 1;
    } else {
      const result = applyV2ControlPackagePolicy(process.env);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(JSON.stringify({ok:false,code:error.message}) + "\n");
    process.exitCode = 1;
  }
}
