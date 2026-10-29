import test from "node:test";
import assert from "node:assert/strict";
import zlib, { gunzipSync, gzipSync } from "node:zlib";
import { syncBuiltinESMExports } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync,
  statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compressV2Static, verifyStaticGzip } from "../../scripts/compress-v2-static.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shuduo-precompression-")));
  const webDistDirectory = join(root, "web-dist"), assets = join(webDistDirectory, "assets");
  mkdirSync(assets, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, webDistDirectory, assets, run: options => compressV2Static({ webDistDirectory, ...options }) };
}

test("precompression creates smaller, lossless JS CSS and SVG sidecars and reports only counts and bytes", t => {
  const f = fixture(t);
  const sources = {
    "index-Abc123_x.js": Buffer.from("export const message = 'synthetic asset';\n".repeat(500)),
    "style-Css123_x.css": Buffer.from(".synthetic { color: #123456; }\n".repeat(500)),
    "figure-Svg123_x.svg": Buffer.from(`<svg>${"<path d='M0 0L1 1'/>".repeat(500)}</svg>`),
  };
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(f.assets, name), source);
  const result = f.run();
  assert.equal(result.eligibleFiles, 3); assert.equal(result.compressedFiles, 3);
  let sourceBytes = 0, compressedBytes = 0;
  for (const [name, source] of Object.entries(sources)) {
    const compressed = readFileSync(join(f.assets, `${name}.gz`));
    assert.deepEqual(gunzipSync(compressed), source); assert.ok(compressed.length < source.length);
    assert.equal(compressed[8], 2, "gzip header indicates maximum compression");
    assert.deepEqual(readFileSync(join(f.assets, name)), source);
    sourceBytes += source.length; compressedBytes += compressed.length;
  }
  assert.equal(result.sourceBytes, sourceBytes); assert.equal(result.compressedBytes, compressedBytes);
  assert.equal(result.savedBytes, sourceBytes - compressedBytes);
  assert.ok(Object.values(result).every(value => Number.isSafeInteger(value) && value >= 0));
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test("gzip bytes are deterministic across source timestamps and repeated builds leave identical sidecars intact", t => {
  const f = fixture(t), name = "index-Abc123_x.js", file = join(f.assets, name);
  writeFileSync(file, "console.log('repeatable');\n".repeat(500));
  f.run(); const sidecar = `${file}.gz`, first = readFileSync(sidecar), firstTime = statSync(sidecar).mtimeMs;
  utimesSync(file, new Date("2001-01-01T00:00:00Z"), new Date("2001-01-01T00:00:00Z"));
  f.run(); assert.deepEqual(readFileSync(sidecar), first); assert.equal(statSync(sidecar).mtimeMs, firstTime);
  assert.deepEqual([...first.subarray(4, 8)], [0, 0, 0, 0], "gzip header contains no build timestamp");
  rmSync(sidecar); f.run(); assert.deepEqual(readFileSync(sidecar), first);
});

test("default threshold is 1024 bytes and non-beneficial gzip falls back to the original asset", t => {
  const f = fixture(t);
  writeFileSync(join(f.assets, "small-Abc123_x.js"), "s".repeat(1023));
  writeFileSync(join(f.assets, "threshold-Abc123_x.css"), "t".repeat(1024));
  writeFileSync(join(f.assets, "noise-Abc123_x.js"), randomBytes(4096));
  const result = f.run();
  assert.equal(result.skippedSmallFiles, 1); assert.equal(result.skippedNoBenefitFiles, 1);
  assert.equal(result.compressedFiles, 1); assert.equal(existsSync(join(f.assets, "small-Abc123_x.js.gz")), false);
  assert.equal(existsSync(join(f.assets, "noise-Abc123_x.js.gz")), false);
  assert.equal(existsSync(join(f.assets, "threshold-Abc123_x.css.gz")), true);
  writeFileSync(join(f.assets, "single-Abc123_x.svg"), "x");
  const small = f.run({ minBytes: 1 }); assert.equal(small.skippedNoBenefitFiles, 2);
});

test("cleanup removes only stale sidecars for existing eligible assets and retains unrelated originals and sidecars", t => {
  const f = fixture(t), stale = join(f.assets, "small-Abc123_x.js.gz");
  writeFileSync(join(f.assets, "small-Abc123_x.js"), "short"); writeFileSync(stale, "obsolete gzip");
  const ignored = ["index.html", "plain.js", "short-abc.js", "font-Abc123_x.woff2", "photo-Abc123_x.png", "api-Abc123_x.json", "orphan-Abc123_x.js.gz", "plain.js.gz"];
  for (const name of ignored) writeFileSync(join(f.assets, name), "do not touch".repeat(200));
  writeFileSync(join(f.webDistDirectory, "index.html"), "html".repeat(1000));
  const nested = join(f.assets, "nested"); mkdirSync(nested); writeFileSync(join(nested, "nested-Abc123_x.js"), "n".repeat(2000));
  const result = f.run(); assert.equal(result.removedSidecars, 1); assert.equal(existsSync(stale), false);
  for (const name of ignored) assert.equal(readFileSync(join(f.assets, name), "utf8"), "do not touch".repeat(200));
  assert.equal(existsSync(join(f.webDistDirectory, "index.html.gz")), false);
  assert.equal(existsSync(join(nested, "nested-Abc123_x.js.gz")), false);
  assert.equal(result.eligibleFiles, 1);
});

test("changed eligible content replaces its precise sidecar without leaving temporary output", t => {
  const f = fixture(t), source = join(f.assets, "index-Abc123_x.js");
  writeFileSync(source, "a".repeat(4000)); f.run(); const first = readFileSync(`${source}.gz`);
  writeFileSync(source, "b".repeat(6000)); f.run();
  assert.notDeepEqual(readFileSync(`${source}.gz`), first);
  assert.deepEqual(gunzipSync(readFileSync(`${source}.gz`)), readFileSync(source));
  assert.deepEqual(readdirSync(f.assets).sort(), ["index-Abc123_x.js", "index-Abc123_x.js.gz"]);
});

test("missing, broad or malformed directories and thresholds are rejected without creating output", t => {
  const f = fixture(t);
  for (const webDistDirectory of [undefined, null, "", "/", f.root, "relative/web-dist", join(f.root, "missing", "web-dist")])
    assert.throws(() => compressV2Static({ webDistDirectory }));
  for (const minBytes of [0, -1, 1.5, NaN, Infinity, "1024"])
    assert.throws(() => f.run({ minBytes }), { code: "INVALID_MINIMUM_BYTES" });
  rmSync(f.assets, { recursive: true }); assert.throws(() => f.run(), { code: "STATIC_DIRECTORY_REQUIRED" });
  assert.equal(existsSync(f.assets), false);
});

test("symlinked roots, assets, source files, sidecars and parents are refused before any mutation", t => {
  for (const target of ["root", "assets", "source", "sidecar", "parent"]) {
    const f = fixture(t), outside = join(f.root, "outside"); mkdirSync(outside);
    const external = join(outside, "external.js"); writeFileSync(external, "protected outside".repeat(300));
    writeFileSync(join(f.assets, "first-AAAA0000.js"), "first".repeat(1000));
    if (target === "root") { rmSync(f.webDistDirectory, { recursive: true }); symlinkSync(outside, f.webDistDirectory); }
    if (target === "assets") { rmSync(f.assets, { recursive: true }); symlinkSync(outside, f.assets); }
    if (target === "source") symlinkSync(external, join(f.assets, "later-ZZZZ0000.js"));
    if (target === "sidecar") {
      writeFileSync(join(f.assets, "later-ZZZZ0000.js"), "later".repeat(1000));
      symlinkSync(external, join(f.assets, "later-ZZZZ0000.js.gz"));
    }
    if (target === "parent") {
      const alias = join(f.root, "alias"); symlinkSync(f.root, alias);
      assert.throws(() => compressV2Static({ webDistDirectory: join(alias, "web-dist") }), { code: "STATIC_SYMLINK_REFUSED" });
    } else assert.throws(() => f.run());
    assert.equal(existsSync(join(f.assets, "first-AAAA0000.js.gz")), false);
    assert.equal(readFileSync(external, "utf8"), "protected outside".repeat(300));
  }
});

test("non-file eligible assets and sidecars fail preflight without recursively removing anything", t => {
  for (const name of ["bad-ZZZZ0000.js", "good-AAAA0000.js.gz"]) {
    const f = fixture(t); writeFileSync(join(f.assets, "good-AAAA0000.js"), "good".repeat(1000));
    mkdirSync(join(f.assets, name)); writeFileSync(join(f.assets, name, "keep.txt"), "keep");
    assert.throws(() => f.run()); assert.equal(readFileSync(join(f.assets, name, "keep.txt"), "utf8"), "keep");
  }
});

test("build gzip verification rejects corrupt, different and oversized decoded content within the source byte bound", () => {
  const source = Buffer.from("a".repeat(1024)), compressed = gzipSync(source, { level: 9 });
  assert.doesNotThrow(() => verifyStaticGzip(source, compressed));
  assert.throws(() => verifyStaticGzip(source, compressed.subarray(0, -1)), { code: "STATIC_GZIP_VERIFICATION_FAILED" });
  assert.throws(() => verifyStaticGzip(source, gzipSync(Buffer.from("b".repeat(1024)))), { code: "STATIC_GZIP_CONTENT_MISMATCH" });
  assert.throws(() => verifyStaticGzip(source, gzipSync(Buffer.alloc(1024 * 1024, 97))), { code: "STATIC_GZIP_VERIFICATION_FAILED" });
  assert.throws(() => verifyStaticGzip(source, Buffer.concat([compressed, compressed])), { code: "STATIC_GZIP_VERIFICATION_FAILED" });
  assert.throws(() => verifyStaticGzip(Buffer.alloc(0), gzipSync(Buffer.alloc(0))), { code: "INVALID_STATIC_GZIP_INPUT" });
});

test("a failed build verification preserves the original asset and existing sidecar before any output write", t => {
  const f = fixture(t), name = "index-Abc123_x.js", source = Buffer.from("a".repeat(2048));
  const file = join(f.assets, name), previousSidecar = gzipSync(source);
  writeFileSync(file, source); writeFileSync(`${file}.gz`, previousSidecar);
  const incorrect = gzipSync(Buffer.from("b".repeat(source.length))), originalGzip = zlib.gzipSync;
  try {
    zlib.gzipSync = () => incorrect;
    syncBuiltinESMExports();
    assert.throws(() => f.run(), { code: "STATIC_GZIP_CONTENT_MISMATCH" });
  } finally { zlib.gzipSync = originalGzip; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(file), source);
  assert.deepEqual(readFileSync(`${file}.gz`), previousSidecar);
  assert.deepEqual(readdirSync(f.assets).sort(), [name, `${name}.gz`]);
});
