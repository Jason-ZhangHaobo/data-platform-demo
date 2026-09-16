import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fail = (message) => Object.assign(new Error(message), { safe: true });
const identifier = (value, label, pattern) => {
  if (typeof value !== "string" || !pattern.test(value))
    throw fail(`${label}格式不合法`);
  return value;
};

export function sanitizedFunction(value) {
  if (!value || typeof value !== "object")
    throw fail("FC响应缺少函数信息");
  const env = value.environmentVariables ?? {};
  return {
    available: true,
    runtime: value.runtime ?? null,
    cpu: value.cpu ?? null,
    memoryMiB: value.memorySize ?? null,
    diskMiB: value.diskSize ?? null,
    timeoutSeconds: value.timeout ?? null,
    instanceConcurrency: value.instanceConcurrency ?? null,
    internetAccess: value.internetAccess ?? null,
    roleConfigured: Boolean(value.role),
    vpcConfigured: Boolean(value.vpcConfig?.vpcId),
    environmentKeyCount: Object.keys(env).length,
    v2EnvironmentReady: [
      "V2_MYSQL_HOST",
      "V2_MYSQL_USER",
      "V2_MYSQL_PASSWORD",
      "V2_MYSQL_DATABASE",
      "OSS_BUCKET",
    ].every((key) => Object.hasOwn(env, key)),
  };
}

export function sanitizedError(error) {
  const candidates = [error?.code, error?.data?.Code, error?.data?.code];
  const code = candidates.find(
    (item) => typeof item === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(item),
  );
  const message = String(error?.message ?? ""),
    diagnostic = /missing parameter SecurityToken/i.test(message)
      ? "MISSING_STS_TOKEN"
      : /AccessDenied|Forbidden|not authorized|permission/i.test(message)
        ? "PERMISSION_DENIED"
        : /FunctionNotFound|ResourceNotFound|not found/i.test(message)
          ? "FUNCTION_NOT_FOUND"
          : "UNCLASSIFIED";
  return {
    available: false,
    errorCode: code ?? "FC_QUERY_UNAVAILABLE",
    diagnostic,
  };
}

export async function readOnlyFunctionAudit({
  profile,
  region,
  functionName,
  configPath,
  sdkClientFactory,
  refreshCredentials,
} = {}) {
  identifier(profile, "OAuth配置", /^[A-Za-z0-9_-]{1,64}$/);
  identifier(region, "地域", /^[a-z0-9-]{3,40}$/);
  identifier(functionName, "函数名称", /^[A-Za-z][A-Za-z0-9_-]{1,127}$/);
  const path = configPath ?? join(process.env.HOME ?? "", ".aliyun", "config.json"),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600)
    throw fail("OAuth配置文件必须是非符号链接且权限0600");
  const accountId = refreshCredentials
    ? await refreshCredentials(profile)
    : undefined;
  if (accountId !== undefined)
    identifier(accountId, "账号接入点", /^[0-9]{10,24}$/);
  const config = JSON.parse(readFileSync(path, "utf8"));
  const credential = config.profiles?.find(
    (item) => item.name === profile && item.mode === "OAuth",
  );
  if (
    !credential?.access_key_id ||
    !credential.access_key_secret ||
    !credential.sts_token ||
    (credential.sts_expiration &&
      Date.parse(credential.sts_expiration) <= Date.now() + 30_000)
  )
    throw fail("OAuth临时凭证不存在或即将过期");
  try {
    const response = await sdkClientFactory({
      region,
      functionName,
      accessKeyId: credential.access_key_id,
      accessKeySecret: credential.access_key_secret,
      securityToken: credential.sts_token,
      accountId,
    });
    return sanitizedFunction(response);
  } catch (error) {
    return sanitizedError(error);
  }
}

async function officialSdkReadOnly(input) {
  const require = createRequire(import.meta.url),
    sdkPath = join(repoRoot, ".runtime", "fc-audit", "node_modules"),
    FC = require(join(sdkPath, "@alicloud", "fc20230330")),
    OpenApi = require(join(sdkPath, "@alicloud", "openapi-client")),
    client = new FC.default(
      new OpenApi.Config({
        accessKeyId: input.accessKeyId,
        accessKeySecret: input.accessKeySecret,
        securityToken: input.securityToken,
        regionId: input.region,
        endpoint: `fcv3.${input.region}.aliyuncs.com`,
        protocol: "HTTPS",
        connectTimeout: 5000,
        readTimeout: 10000,
      }),
    );
  const sdkCredential = await client._credential.getCredential();
  if (
    sdkCredential.securityToken !== input.securityToken ||
    sdkCredential.accessKeyId !== input.accessKeyId
  )
    throw Object.assign(new Error("SDK未传播临时STS"), {
      code: "SDK_STS_NOT_PROPAGATED",
    });
  const result = await client.getFunction(
      input.functionName,
      new FC.GetFunctionRequest({}),
    );
  return result.body;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [profile, region, functionName] = process.argv.slice(2);
  try {
    const result = await readOnlyFunctionAudit({
      profile,
      region,
      functionName,
      sdkClientFactory: officialSdkReadOnly,
      refreshCredentials: (name) => {
        const binary = join(repoRoot, ".runtime", "aliyun-cli", "aliyun");
        const result = execFileSync(binary, ["sts", "GetCallerIdentity", "--profile", name], {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 15000,
        });
        return JSON.parse(result.toString("utf8")).AccountId;
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(sanitizedError(error))}\n`);
  }
}
