import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const secretNames = [
  "V2_MYSQL_HOST",
  "V2_MYSQL_PORT",
  "V2_MYSQL_USER",
  "V2_MYSQL_PASSWORD",
  "V2_MYSQL_DATABASE",
  "V2_BOOTSTRAP_ADMIN_EMAIL",
  "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH",
  "V2_BOOTSTRAP_ADMIN_NAME",
  "DASHSCOPE_API_KEY",
  "V2_SPARK_EXECUTOR_SECRET",
  "V2_SCHEDULER_TICK_SECRET",
];

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parseDotenv(raw) {
  const values = {};
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !keyPattern.test(match[1]))
      throw new Error(`JASONSECRETS第${index + 1}行格式不合法`);
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    )
      value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export function parseSecretBundle(raw) {
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  let values;
  try {
    values = JSON.parse(raw);
  } catch {
    values = parseDotenv(raw);
  }
  if (!values || typeof values !== "object" || Array.isArray(values))
    throw new Error("JASONSECRETS必须是JSON对象或KEY=VALUE文本");
  const unknown = Object.keys(values).filter((key) => !secretNames.includes(key));
  if (unknown.length > 0) throw new Error("JASONSECRETS包含不支持的键");
  const result = {};
  for (const key of secretNames) {
    if (values[key] === undefined || values[key] === null) continue;
    if (typeof values[key] !== "string" || /[\r\n\u0000]/.test(values[key]))
      throw new Error("JASONSECRETS的值必须是单行文本");
    result[key] = values[key];
  }
  return result;
}

export function mergeSecretBundle(input = {}, raw = input.JASONSECRETS) {
  const bundle = parseSecretBundle(raw);
  return {
    ...input,
    ...Object.fromEntries(
      Object.entries(bundle).filter(([key]) => !input[key]),
    ),
  };
}

function run() {
  try {
    const bundle = parseSecretBundle(process.env.JASONSECRETS);
    const target = process.env.GITHUB_ENV;
    if (target) {
      for (const [key, value] of Object.entries(bundle)) {
        if (!process.env[key]) appendFileSync(target, `${key}=${value}\n`, { mode: 0o600 });
      }
    }
    process.stdout.write(
      JSON.stringify({ ok: true, bundlePresent: Object.keys(bundle).length > 0, loadedKeys: Object.keys(bundle) }) +
        "\n",
    );
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: "JASONSECRETS_FORMAT_INVALID" }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
