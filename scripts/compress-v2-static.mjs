import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";

const hashedAsset = /^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg)$/;
const failure = (code) => Object.assign(new Error(code), { code, safeCompressionError: true });
const requireThat = (condition, code) => { if (!condition) throw failure(code); };
function optionalStat(file) {
  try { return lstatSync(file); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
function regularFile(info) {
  return info?.isFile() && !info.isSymbolicLink() && info.nlink === 1;
}
function assertDirectory(directory) {
  const info = optionalStat(directory);
  requireThat(info?.isDirectory() && !info.isSymbolicLink(), "STATIC_DIRECTORY_REQUIRED");
  // Canonical paths prevent parent symlinks from moving the selected tree.
  requireThat(realpathSync(directory) === directory, "STATIC_SYMLINK_REFUSED");
}
function readAsset(file) {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requireThat(regularFile(fstatSync(descriptor)), "STATIC_FILE_REQUIRED");
    return readFileSync(descriptor);
  } finally { closeSync(descriptor); }
}

export function verifyStaticGzip(source, compressed) {
  requireThat(Buffer.isBuffer(source) && source.byteLength > 0 && Buffer.isBuffer(compressed), "INVALID_STATIC_GZIP_INPUT");
  let restored;
  try {
    // Never allocate beyond the known source size, including concatenated gzip
    // members or malformed compressor output. Verification runs only at build.
    restored = gunzipSync(compressed, { maxOutputLength: source.byteLength });
  } catch { throw failure("STATIC_GZIP_VERIFICATION_FAILED"); }
  requireThat(restored.equals(source), "STATIC_GZIP_CONTENT_MISMATCH");
}

// Only immediate, content-hashed text assets are eligible. Sidecars for unrelated
// files, HTML, APIs, font/image binaries and absent originals are never touched.
export function compressV2Static({ webDistDirectory, minBytes = 1024 } = {}) {
  requireThat(typeof webDistDirectory === "string" && isAbsolute(webDistDirectory) &&
    resolve(webDistDirectory) === webDistDirectory && basename(webDistDirectory) === "web-dist", "INVALID_STATIC_DIRECTORY");
  requireThat(Number.isSafeInteger(minBytes) && minBytes >= 1, "INVALID_MINIMUM_BYTES");
  try {
    assertDirectory(webDistDirectory);
    const assetsDirectory = join(webDistDirectory, "assets");
    assertDirectory(assetsDirectory);
    const candidates = [];
    // Validate every entry and every target sidecar before producing any output.
    for (const name of readdirSync(assetsDirectory).sort()) {
      const file = join(assetsDirectory, name), info = lstatSync(file);
      requireThat(!info.isSymbolicLink(), "STATIC_SYMLINK_REFUSED");
      if (!hashedAsset.test(name)) continue;
      requireThat(regularFile(info), "STATIC_FILE_REQUIRED");
      const sidecar = `${file}.gz`, sidecarInfo = optionalStat(sidecar);
      requireThat(!sidecarInfo || regularFile(sidecarInfo), "STATIC_SIDECAR_INVALID");
      candidates.push({ file, sidecar });
    }
    const summary = { eligibleFiles: candidates.length, compressedFiles: 0, skippedSmallFiles: 0,
      skippedNoBenefitFiles: 0, removedSidecars: 0, sourceBytes: 0, compressedBytes: 0, savedBytes: 0 };
    for (const { file, sidecar } of candidates) {
      assertDirectory(assetsDirectory);
      const source = readAsset(file);
      summary.sourceBytes += source.byteLength;
      const compressed = source.byteLength >= minBytes ? gzipSync(source, { level: 9 }) : undefined;
      const useful = compressed && compressed.byteLength < source.byteLength;
      const existing = optionalStat(sidecar);
      requireThat(!existing || regularFile(existing), "STATIC_SIDECAR_INVALID");
      if (!useful) {
        if (!compressed) summary.skippedSmallFiles++;
        else summary.skippedNoBenefitFiles++;
        if (existing) { unlinkSync(sidecar); summary.removedSidecars++; }
        continue;
      }
      verifyStaticGzip(source, compressed);
      summary.compressedFiles++;
      summary.compressedBytes += compressed.byteLength;
      summary.savedBytes += source.byteLength - compressed.byteLength;
      if (existing && readAsset(sidecar).equals(compressed)) continue;
      const temporary = `${sidecar}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, compressed, { mode: 0o644, flag: "wx" });
        assertDirectory(assetsDirectory);
        renameSync(temporary, sidecar);
      } finally { if (optionalStat(temporary)) unlinkSync(temporary); }
    }
    return summary;
  } catch (error) {
    throw error.safeCompressionError ? error : failure("STATIC_COMPRESSION_IO_FAILED");
  }
}

function run() {
  requireThat(process.argv.length === 2, "INVALID_STATIC_COMPRESSION_ARGUMENTS");
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const summary = compressV2Static({ webDistDirectory: join(root, "web-dist") });
  // Build evidence only: no filenames, local paths or public performance claims.
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, code: error.safeCompressionError ? error.code : "STATIC_COMPRESSION_FAILED" })}\n`);
    process.exitCode = 1;
  }
}
