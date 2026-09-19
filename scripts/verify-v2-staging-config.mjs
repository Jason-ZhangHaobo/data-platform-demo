import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSecretBundle, validateSecretValues } from "./export-v2-staging-secret-bundle.mjs";

const required = [
  "OSS_BUCKET",
  "V2_MYSQL_HOST",
  "V2_MYSQL_USER",
  "V2_MYSQL_PASSWORD",
  "V2_MYSQL_DATABASE",
  "V2_BOOTSTRAP_ADMIN_EMAIL",
  "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH",
  "DASHSCOPE_API_KEY",
  "FUNCTION_NAME",
  "V2_FUNCTION_ROLE_ARN",
  "ALIYUN_ROLE_ARN",
  "ALIYUN_OIDC_PROVIDER_ARN",
  "V2_VPC_ID",
  "V2_VSW_ID",
  "V2_SECURITY_GROUP_ID",
];
const publicRequired = ["V2_PUBLIC_URL", "V2_PUBLIC_ORIGIN"];

const functionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{1,127}$/;

export function validateV2StagingConfig(input = {}) {
  const effectiveInput = mergeSecretBundle(input);
  const provisioningOnly = effectiveInput.V2_PROVISIONING_ONLY === "true";
  const requiredNames = provisioningOnly ? required : [...publicRequired, ...required];
  const missing = requiredNames.filter((name) => {
    const value = effectiveInput[name];
    return typeof value !== "string" || value.length === 0;
  });
  const errors = [];
  errors.push(...validateSecretValues(effectiveInput));
  if (!provisioningOnly && typeof effectiveInput.V2_PUBLIC_URL === "string" && !/^https:\/\//.test(effectiveInput.V2_PUBLIC_URL))
    errors.push("V2_PUBLIC_URL_MUST_USE_HTTPS");
  if (
    !provisioningOnly &&
    typeof effectiveInput.V2_PUBLIC_URL === "string" &&
    typeof effectiveInput.V2_PUBLIC_ORIGIN === "string" &&
    effectiveInput.V2_PUBLIC_ORIGIN !== effectiveInput.V2_PUBLIC_URL.replace(/\/$/, "")
  )
    errors.push("V2_PUBLIC_ORIGIN_MISMATCH");
  if (typeof effectiveInput.FUNCTION_NAME === "string" && !functionNamePattern.test(effectiveInput.FUNCTION_NAME))
    errors.push("FUNCTION_NAME_INVALID");
  if (
    typeof effectiveInput.V2_FUNCTION_ROLE_ARN === "string" &&
    typeof effectiveInput.ALIYUN_ROLE_ARN === "string" &&
    effectiveInput.V2_FUNCTION_ROLE_ARN === effectiveInput.ALIYUN_ROLE_ARN
  )
    errors.push("EXECUTION_AND_DEPLOYMENT_ROLES_MUST_DIFFER");
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateV2StagingConfig(process.env);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
