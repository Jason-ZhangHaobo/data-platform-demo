import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const safeCodePattern = /^[A-Za-z][A-Za-z0-9_.-]{1,127}$/;

function codeFromJson(text) {
  try {
    const parsed = JSON.parse(text);
    for (const candidate of [parsed?.Code, parsed?.code, parsed?.ErrorCode, parsed?.error_code])
      if (typeof candidate === "string" && safeCodePattern.test(candidate)) return candidate;
  } catch {
    return null;
  }
  return null;
}

export function extractAliyunErrorCode(...texts) {
  for (const text of texts) {
    if (typeof text !== "string") continue;
    const jsonCode = codeFromJson(text.trim());
    if (jsonCode) return jsonCode;
    const xmlMatch = text.match(
      /<Code>\s*([A-Za-z][A-Za-z0-9_.-]{1,127})\s*<\/Code>/,
    );
    if (xmlMatch && safeCodePattern.test(xmlMatch[1])) return xmlMatch[1];
    const match = text.match(/(?:^|\n)(?:ErrorCode|Code):[ \t]*([A-Za-z][A-Za-z0-9_.-]{1,127})(?:[ \t]*\r?$)/m);
    if (match && safeCodePattern.test(match[1])) return match[1];
    // ossutil/Go SDK errors may put structured fields on one comma-separated line.
    const inline = text.match(/\bErrorCode\s*[:=]\s*([A-Za-z][A-Za-z0-9_.-]{1,127})(?=\s*(?:,|\r?$))/m);
    if (inline) return inline[1];
  }
  return "UNKNOWN_ALIYUN_ERROR";
}

function run() {
  const paths = process.argv.slice(2);
  if (paths.length === 0 || paths.length > 2) {
    process.stderr.write("USAGE: extract-aliyun-error-code <stdout-file> [stderr-file]\n");
    process.exitCode = 2;
    return;
  }
  try {
    const texts = paths.map((path) => readFileSync(path, { encoding: "utf8", flag: "r" }));
    process.stdout.write(`${extractAliyunErrorCode(...texts)}\n`);
  } catch {
    process.stdout.write("UNKNOWN_ALIYUN_ERROR\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
