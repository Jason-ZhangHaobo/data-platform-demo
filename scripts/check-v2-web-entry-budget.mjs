import { gzipSync } from "node:zlib";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const V2_WEB_ENTRY_GZIP_BUDGET_BYTES = 90 * 1024;

export function checkV2WebEntryBudget({
  assetsDirectory,
  budgetBytes = V2_WEB_ENTRY_GZIP_BUDGET_BYTES,
} = {}) {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 1)
    return { ok: false, code: "INVALID:V2_WEB_ENTRY_GZIP_BUDGET_BYTES" };
  let candidates;
  try {
    candidates = readdirSync(assetsDirectory).filter((name) =>
      /^index-[A-Za-z0-9_-]+\.js$/.test(name),
    );
  } catch {
    return { ok: false, code: "V2_WEB_ENTRY_ASSETS_NOT_FOUND" };
  }
  if (candidates.length !== 1)
    return { ok: false, code: "V2_WEB_ENTRY_ASSET_AMBIGUOUS" };
  const filename = candidates[0];
  let source;
  try {
    source = readFileSync(join(assetsDirectory, filename));
  } catch {
    return { ok: false, code: "V2_WEB_ENTRY_ASSET_UNREADABLE" };
  }
  const gzipBytes = gzipSync(source).byteLength;
  return {
    ok: gzipBytes <= budgetBytes,
    code: gzipBytes <= budgetBytes ? "OK" : "V2_WEB_ENTRY_GZIP_BUDGET_EXCEEDED",
    entryFilename: filename,
    entryBytes: source.byteLength,
    entryGzipBytes: gzipBytes,
    budgetBytes,
    measuredAtBuild: true,
    publicPerformanceVerified: false,
  };
}

function run() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const result = checkV2WebEntryBudget({
    assetsDirectory: join(root, "web-dist", "assets"),
  });
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
