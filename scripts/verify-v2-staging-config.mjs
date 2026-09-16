const required = [
  "V2_PUBLIC_URL",
  "V2_PUBLIC_ORIGIN",
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

const functionNamePattern = /^[A-Za-z][A-Za-z0-9_-]{1,127}$/;

export function validateV2StagingConfig(input = {}) {
  const missing = required.filter((name) => {
    const value = input[name];
    return typeof value !== "string" || value.length === 0;
  });
  const errors = [];
  if (typeof input.V2_PUBLIC_URL === "string" && !/^https:\/\//.test(input.V2_PUBLIC_URL))
    errors.push("V2_PUBLIC_URL_MUST_USE_HTTPS");
  if (
    typeof input.V2_PUBLIC_URL === "string" &&
    typeof input.V2_PUBLIC_ORIGIN === "string" &&
    input.V2_PUBLIC_ORIGIN !== input.V2_PUBLIC_URL.replace(/\/$/, "")
  )
    errors.push("V2_PUBLIC_ORIGIN_MISMATCH");
  if (typeof input.FUNCTION_NAME === "string" && !functionNamePattern.test(input.FUNCTION_NAME))
    errors.push("FUNCTION_NAME_INVALID");
  if (
    typeof input.V2_FUNCTION_ROLE_ARN === "string" &&
    typeof input.ALIYUN_ROLE_ARN === "string" &&
    input.V2_FUNCTION_ROLE_ARN === input.ALIYUN_ROLE_ARN
  )
    errors.push("EXECUTION_AND_DEPLOYMENT_ROLES_MUST_DIFFER");
  return { ok: missing.length === 0 && errors.length === 0, missing, errors };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const result = validateV2StagingConfig();
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
