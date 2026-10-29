import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";
import { serveV2Static } from "../../src/v2/static-response.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "shuduo-static-response-"));
  const assets = join(root, "web-dist", "assets");
  await mkdir(assets, { recursive: true });
  const source = Buffer.from("export const sample = 'fictional securities';\n".repeat(300));
  const name = "fixture-abcd1234.js", file = join(assets, name), encoded = gzipSync(source);
  await writeFile(file, source); await writeFile(`${file}.gz`, encoded);
  await writeFile(join(root, "web-dist", "index.html"), "<html>fictional fixture</html>");
  const server = createServer(async (req, res) => {
    try { await serveV2Static(res, root, req.url, req.headers["accept-encoding"]); }
    catch (error) { res.writeHead(error.status ?? 500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const call = (encoding, path = `/v2/assets/${name}`) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: server.address().port, path,
      headers: encoding === undefined ? {} : { "accept-encoding": encoding } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error("static test timeout")));
    req.on("error", reject); req.end();
  });
  return { root, assets, source, encoded, file, call };
}

test("gzip uses original URL/MIME/cache, actual wire length and byte-identical content", async t => {
  const { call, source, encoded } = await fixture(t);
  const result = await call("br, gzip");
  assert.equal(result.status, 200); assert.equal(result.headers["content-encoding"], "gzip");
  assert.equal(result.headers["content-type"], "text/javascript");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.match(result.headers["cache-control"], /immutable/);
  assert.equal(result.headers.vary, "Accept-Encoding");
  assert.equal(Number(result.headers["content-length"]), encoded.length);
  assert.deepEqual(result.body, encoded); assert.deepEqual(gunzipSync(result.body), source);
});

test("encoding negotiation respects explicit rejection, wildcard, case and preferences", async t => {
  const { call, source } = await fixture(t);
  for (const header of [undefined, "", "br", "gzip;q=0", "*;q=1, gzip;q=0", "gzip;q=0.3, identity;q=0.8",
    "gzip;q=1.1", "gzip;q=bad", "gzip;q=1, gzip;q=0", "gzip;q=0.1234"]) {
    const response = await call(header);
    assert.equal(response.status, 200, header); assert.equal(response.headers["content-encoding"], undefined, header);
    assert.equal(response.headers.vary, "Accept-Encoding"); assert.deepEqual(response.body, source);
  }
  for (const header of ["GZIP", "gzip;q=0.5", "*;q=0.5", "gzip;q=0.7, identity;q=0.3", "*;q=0, gzip;q=1", "gzip, identity;q=0"]) {
    const response = await call(header); assert.equal(response.status, 200, header);
    assert.equal(response.headers["content-encoding"], "gzip", header);
  }
  for (const header of ["*;q=0", "identity;q=0", "gzip;q=0, identity;q=0", "*;q=0.5, gzip;q=0, identity;q=0"]) {
    const response = await call(header); assert.equal(response.status, 406, header);
    assert.equal(response.body.length, 0); assert.equal(response.headers["cache-control"], "no-store");
  }
});

test("missing sidecar safely falls back unless identity is explicitly forbidden", async t => {
  const { call, file, source } = await fixture(t); await rm(`${file}.gz`);
  assert.deepEqual((await call("gzip")).body, source);
  assert.equal((await call("gzip, identity;q=0")).status, 406);
});

test("compressed CSS and SVG retain their original MIME", async t => {
  const { call, assets } = await fixture(t);
  for (const [extension, type, text] of [["css", "text/css", ".fixture { color: green; }\n"], ["svg", "image/svg+xml", "<svg><!-- fictional --></svg>\n"]]) {
    const name = `fixture-abcd1234.${extension}`, bytes = Buffer.from(text.repeat(100));
    await writeFile(join(assets, name), bytes); await writeFile(join(assets, `${name}.gz`), gzipSync(bytes));
    const response = await call("gzip", `/v2/assets/${name}`);
    assert.equal(response.headers["content-type"], type); assert.equal(response.headers["content-encoding"], "gzip");
    assert.deepEqual(gunzipSync(response.body), bytes);
  }
});

test("corrupt, stale, oversized and symlink sidecars cannot produce encoded garbage", async t => {
  const { call, file, source, root } = await fixture(t);
  for (const invalid of [Buffer.from("not gzip"), gzipSync(Buffer.from("a different valid but stale file")),
    gzipSync(Buffer.alloc(source.length + 1000, 65)), Buffer.alloc(source.length + 1)]) {
    await writeFile(`${file}.gz`, invalid);
    const response = await call("gzip"); assert.equal(response.headers["content-encoding"], undefined);
    assert.deepEqual(response.body, source); assert.equal((await call("gzip, identity;q=0")).status, 406);
  }
  const outside = join(root, "outside.gz"); await writeFile(outside, gzipSync(source));
  await rm(`${file}.gz`); await symlink(outside, `${file}.gz`);
  assert.equal((await call("gzip")).headers["content-encoding"], undefined);
});

test("HTML, SPA fallback, unhashed files and fonts remain uncompressed", async t => {
  const { call, assets } = await fixture(t);
  for (const name of ["plain.js", "font-abcd1234.woff2"]) {
    await writeFile(join(assets, name), "unchanged".repeat(200));
    await writeFile(join(assets, `${name}.gz`), gzipSync(Buffer.from("unchanged".repeat(200))));
  }
  for (const path of ["/v2/", "/v2/fictional-route", "/v2/assets/plain.js", "/v2/assets/font-abcd1234.woff2"]) {
    const response = await call("gzip", path); assert.equal(response.status, 200, path);
    assert.equal(response.headers["content-encoding"], undefined, path);
    assert.equal(response.headers["cache-control"], path.endsWith("woff2") ? "public, max-age=31536000, immutable" : "no-cache");
  }
});

test("missing original, direct sidecars, traversal and malformed paths are rejected", async t => {
  const { call, file } = await fixture(t);
  for (const path of ["/v2/assets/fixture-abcd1234.js.gz", "/v2/%2e%2e/outside", "/v2/%E0%A4%A"]) {
    assert.equal((await call("gzip", path)).status, 404, path);
  }
  await rm(file); assert.equal((await call("gzip")).status, 404);
});
