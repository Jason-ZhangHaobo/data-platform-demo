import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const fail = (code) => Object.assign(new Error(code), { code });
const fields = ["functionName", "codeChecksum", "codeSize", "runtime", "handler", "role", "vpcConfig", "customRuntimeConfig", "customDNS", "layers", "logConfig", "nasConfig", "ossMountConfig", "cpu", "memorySize", "diskSize", "timeout", "instanceConcurrency", "internetAccess", "disableOndemand", "instanceLifecycleConfig", "invocationRestriction", "environmentVariables"];
const snapshot = value => Object.fromEntries(fields.map(key => [key, value[key]]));

export async function syncMysqlSecret({ name, password, api }) {
  if (!/^dataplatform-v2-[a-z0-9-]{1,45}$/.test(name ?? "") || typeof password !== "string" || password.length < 8 || password.length > 256 || /[\r\n\u0000]/.test(password))
    throw fail("MYSQL_SYNC_INPUT_INVALID");
  const path = `/2023-03-30/functions/${name}`;
  const before = await api("GET", path);
  const env = before.environmentVariables;
  if (before.functionName !== name || before.runtime !== "custom.debian12" || before.instanceConcurrency !== 1 || env?.V2_LOCAL_DEVELOPMENT !== "false" || env?.V2_PROVISIONING_ONLY !== "true" || env?.V2_PRIVATE_SMOKE_ENABLED !== "true" || env?.V2_MYSQL_USER !== "platform_app" || env?.V2_MYSQL_DATABASE !== "platform_meta")
    throw fail("PRIVATE_CONTROL_BOUNDARY_MISMATCH");
  if (!isDeepStrictEqual(snapshot(before), snapshot(await api("GET", path))))
    throw fail("FUNCTION_CHANGED_BEFORE_UPDATE");
  const changed = env.V2_MYSQL_PASSWORD !== password;
  if (changed) await api("PUT", path, { environmentVariables: { ...env, V2_MYSQL_PASSWORD: password } });
  const expected = snapshot(before);
  expected.environmentVariables = { ...env, V2_MYSQL_PASSWORD: password };
  if (!isDeepStrictEqual(expected, snapshot(await api("GET", path))))
    throw fail("FUNCTION_READBACK_MISMATCH");
  return { ok: true, changed, configurationVerified: true, databaseConnectionVerified: false, databasePasswordReset: false, containsSecretValues: false };
}

function run() {
  const dir = mkdtempSync(join(tmpdir(), "shuduo-mysql-sync-"));
  try {
    const api = (method, path, body) => {
      const args = ["fc", method, path, "--region", "cn-hangzhou", "--read-timeout", "45"];
      if (body) {
        const target = join(dir, "update.json");
        writeFileSync(target, JSON.stringify(body), { mode: 0o600 });
        args.push("--body-file", target);
      }
      try {
        return JSON.parse(execFileSync("aliyun", args, { encoding: "utf8", timeout: 50000, maxBuffer: 2097152, stdio: ["ignore", "pipe", "pipe"] }));
      } catch { throw fail("FC_CONFIG_REQUEST_FAILED"); }
    };
    return syncMysqlSecret({ name: process.env.FUNCTION_NAME, password: process.env.V2_MYSQL_PASSWORD, api })
      .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch(error => {
        const allowed = new Set(["MYSQL_SYNC_INPUT_INVALID", "PRIVATE_CONTROL_BOUNDARY_MISMATCH", "FUNCTION_CHANGED_BEFORE_UPDATE", "FUNCTION_READBACK_MISMATCH", "FC_CONFIG_REQUEST_FAILED"]);
        process.stdout.write(`${JSON.stringify({ ok: false, code: allowed.has(error.code) ? error.code : "MYSQL_SYNC_FAILED", containsSecretValues: false })}\n`);
        process.exitCode = 1;
      }).finally(() => rmSync(dir, { recursive: true, force: true }));
  } catch {
    rmSync(dir, { recursive: true, force: true });
    process.stdout.write('{"ok":false,"code":"MYSQL_SYNC_FAILED","containsSecretValues":false}\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await run();
