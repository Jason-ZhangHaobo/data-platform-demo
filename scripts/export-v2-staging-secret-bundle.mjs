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
];

const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const placeholderPattern = /^(?:\.{3}|x{3,}|<[^>]+>|(?:change|replace)[-_ ]?me|example|todo|tbd|null|undefined)$/i;

export function validateSecretValues(values = {}) {
  const errors = [];
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && placeholderPattern.test(value.trim()))
      errors.push(`PLACEHOLDER_VALUE:${key}`);
  }
  if (
    typeof values.V2_MYSQL_PORT === "string" &&
    values.V2_MYSQL_PORT.length > 0 &&
    (!/^\d{1,5}$/.test(values.V2_MYSQL_PORT) || Number(values.V2_MYSQL_PORT) < 1 || Number(values.V2_MYSQL_PORT) > 65535)
  )
    errors.push("INVALID_VALUE:V2_MYSQL_PORT");
  for (const key of ["V2_MYSQL_USER", "V2_MYSQL_DATABASE"])
    if (typeof values[key] === "string" && values[key].length > 0 && !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(values[key]))
      errors.push(`INVALID_VALUE:${key}`);
  if (
    typeof values.V2_MYSQL_HOST === "string" &&
    values.V2_MYSQL_HOST.length > 0 &&
    (values.V2_MYSQL_HOST.length < 3 || /\s|:\/\//.test(values.V2_MYSQL_HOST))
  )
    errors.push("INVALID_VALUE:V2_MYSQL_HOST");
  if (
    typeof values.V2_MYSQL_PASSWORD === "string" &&
    values.V2_MYSQL_PASSWORD.length > 0 &&
    (values.V2_MYSQL_PASSWORD.length < 8 || values.V2_MYSQL_PASSWORD.length > 256)
  )
    errors.push("INVALID_VALUE:V2_MYSQL_PASSWORD");
  if (
    typeof values.V2_BOOTSTRAP_ADMIN_EMAIL === "string" &&
    values.V2_BOOTSTRAP_ADMIN_EMAIL.length > 0 &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.V2_BOOTSTRAP_ADMIN_EMAIL)
  )
    errors.push("INVALID_VALUE:V2_BOOTSTRAP_ADMIN_EMAIL");
  if (
    typeof values.V2_BOOTSTRAP_ADMIN_NAME === "string" &&
    values.V2_BOOTSTRAP_ADMIN_NAME.length > 0 &&
    (values.V2_BOOTSTRAP_ADMIN_NAME.trim().length < 2 || values.V2_BOOTSTRAP_ADMIN_NAME.length > 50)
  )
    errors.push("INVALID_VALUE:V2_BOOTSTRAP_ADMIN_NAME");
  if (typeof values.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH === "string") {
    const [algorithm, n, r, p, salt, expected, extra] = values.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH.split("$");
    if (values.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH.length > 0 && (
      algorithm !== "scrypt" ||
      Number(n) !== 16384 ||
      Number(r) !== 8 ||
      Number(p) !== 1 ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/.test(salt ?? "") ||
      !/^[A-Za-z0-9_-]+$/.test(expected ?? "") ||
      Buffer.from(salt ?? "", "base64url").length !== 16 ||
      Buffer.from(expected ?? "", "base64url").length !== 64
    ))
      errors.push("INVALID_VALUE:V2_BOOTSTRAP_ADMIN_PASSWORD_HASH");
  }
  if (
    typeof values.DASHSCOPE_API_KEY === "string" &&
    values.DASHSCOPE_API_KEY.length > 0 &&
    (values.DASHSCOPE_API_KEY.length < 16 || /\s/.test(values.DASHSCOPE_API_KEY))
  )
    errors.push("INVALID_VALUE:DASHSCOPE_API_KEY");
  if (
    typeof values.V2_SPARK_EXECUTOR_SECRET === "string" &&
    values.V2_SPARK_EXECUTOR_SECRET.length > 0 &&
    values.V2_SPARK_EXECUTOR_SECRET.length < 16
  )
    errors.push("INVALID_VALUE:V2_SPARK_EXECUTOR_SECRET");
  return [...new Set(errors)];
}

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
    const errors = validateSecretValues(bundle);
    if (errors.length > 0) {
      process.stdout.write(JSON.stringify({ ok: false, error: "JASONSECRETS_VALUE_INVALID", errors }) + "\n");
      process.exitCode = 1;
      return;
    }
    const target = process.env.GITHUB_ENV;
    if (target) {
      for (const [key, value] of Object.entries(bundle)) {
        if (!process.env[key]) {
          if (process.env.GITHUB_ACTIONS === "true")
            process.stdout.write(`::add-mask::${value.replaceAll("%", "%25")}\n`);
          appendFileSync(target, `${key}=${value}\n`, { mode: 0o600 });
        }
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
