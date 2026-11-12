import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { sha256 } from "../src/v2/delivery.mjs";

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
  const bytes = readArchive(zipPath, application);
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
