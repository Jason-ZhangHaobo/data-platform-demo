import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { sha256 } from "../src/v2/delivery.mjs";
import { boundedBytes } from "./control-code-transport.mjs";

export const WEB_INDEX_LIMIT = 300000;
export const WEB_ENTRY_SCRIPT_LIMIT = 2 * 1024 * 1024;

function requireEntry(condition, safeCode) {
  if (!condition) throw Object.assign(new Error(safeCode), { safeCode });
}

function readArchive(path, application) {
  let fd;
  try {
    requireEntry(isAbsolute(path), "APPLICATION_ZIP_MISMATCH");
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(fd);
    requireEntry(file.isFile() && file.nlink === 1 && (!process.getuid || file.uid === process.getuid()) &&
      (file.mode & 0o777) === 0o600 && file.size === application.bytes, "APPLICATION_ZIP_MISMATCH");
    // A fixed-size read also bounds a file that grows after fstat.
    const buffer = Buffer.allocUnsafe(application.bytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const length = readSync(fd, buffer, total, buffer.length - total, total);
      if (length === 0) break;
      total += length;
    }
    const bytes = buffer.subarray(0, total);
    requireEntry(total === application.bytes && sha256(bytes) === application.sha256, "APPLICATION_ZIP_MISMATCH");
    return bytes;
  } catch {
    requireEntry(false, "APPLICATION_ZIP_MISMATCH");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function inspectedControlEntryScript(zipPath, application) {
  return inspectedControlEntryScriptBytes(readArchive(zipPath, application), application);
}

export function inspectedControlEntryScriptBytes(bytes, application) {
  requireEntry(Buffer.isBuffer(bytes) && bytes.length === application.bytes &&
    sha256(bytes) === application.sha256, "APPLICATION_ZIP_MISMATCH");
  const directory = mkdtempSync(join(tmpdir(), "shuduo-control-entry-"));
  try {
    // Extract only from the exact bytes checked above, never from a reopened
    // input path or a filename taken from the live server.
    const archive = join(directory, "control.zip");
    writeFileSync(archive, bytes, { mode: 0o600, flag: "wx" });
    const extract = (name, limit) => execFileSync("unzip", ["-p", archive, name], {
      timeout: 5000, maxBuffer: limit, stdio: ["ignore", "pipe", "pipe"],
    });
    const index = extract("web-dist/index.html", WEB_INDEX_LIMIT);
    requireEntry(index.length === application.webIndexBytes &&
      sha256(index) === application.webIndexSha256, "APPLICATION_ENTRY_INVALID");
    const scripts = [...index.toString("utf8").matchAll(/<script\b[^>]*>/gi)]
      .filter(([tag]) => /\s+type=(["'])module\1/i.test(tag));
    const src = scripts.length === 1 && /\s+src=(["'])(\/v2\/assets\/index-[A-Za-z0-9_-]+\.js)\1/.exec(scripts[0][0]);
    requireEntry(src, "APPLICATION_ENTRY_INVALID");
    const path = src[2];
    const script = extract("web-dist" + path.slice("/v2".length), WEB_ENTRY_SCRIPT_LIMIT);
    requireEntry(script.length > 0, "APPLICATION_ENTRY_INVALID");
    return { path, bytes: script.length, digest: sha256(script) };
  } catch {
    requireEntry(false, "APPLICATION_ENTRY_INVALID");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function readInspectedWebAsset(client, asset, signal) {
  const started = performance.now();
  let response, headersMs;
  const result = (status, reason, extra = {}) => ({
    status, ...(reason ? {reason} : {}),
    ...(response ? {httpStatus:response.status,headersMs} : {}),
    elapsedMs: Math.round(performance.now() - started), ...extra,
  });
  try {
    const url = new URL(asset.path,client.baseUrl);
    response = await client.fetchImpl(url.href,{
      method:"GET", redirect:"error", cache:"no-store", credentials:"omit", signal,
      headers:{Accept:asset.accept,"Cache-Control":"no-cache"},
    });
    headersMs = Math.round(performance.now() - started);
    if (response.status !== 200 || !asset.contentType.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      return result("UNCONFIRMED",asset.invalidResponse);
    }
    const bytes = await boundedBytes(response,asset.limit);
    return bytes.length === asset.bytes && sha256(bytes) === asset.digest
      ? result("MATCHED",undefined,{observedBytes:bytes.length})
      : result("MISMATCH",`${asset.label}_CONTENT_MISMATCH`,{observedBytes:bytes.length});
  } catch (error) {
    await response?.body?.cancel().catch(() => {});
    const reason = signal.aborted ? "TIMEOUT" : error?.safeCode === "OBJECT_TOO_LARGE" ? "TOO_LARGE" : "TRANSPORT_UNCONFIRMED";
    return result("UNCONFIRMED",`${asset.label}_${reason}`);
  }
}

export function readInspectedWebIndex(client, application, signal) {
  return readInspectedWebAsset(client,{
    path:"/v2/", accept:"text/html", contentType:/^text\/html(?:;|$)/i,
    invalidResponse:"ENTRY_NOT_HTML", label:"ENTRY", limit:WEB_INDEX_LIMIT,
    bytes:application.webIndexBytes, digest:application.webIndexSha256,
  },signal);
}


export function readInspectedWebScript(client, expected, signal) {
  return readInspectedWebAsset(client,{
    ...expected, accept:"text/javascript, application/javascript",
    contentType:/^(?:text|application)\/javascript(?:;|$)/i,
    invalidResponse:"ENTRY_SCRIPT_NOT_JAVASCRIPT", label:"ENTRY_SCRIPT", limit:WEB_ENTRY_SCRIPT_LIMIT,
  },signal);
}
