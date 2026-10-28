import { open, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, extname, join } from "node:path";
import { gunzip as gunzipCallback } from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(gunzipCallback);
const compressedAsset = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg)$/;

function encodingPreferences(header) {
  // No header or an empty header takes the compatible, unencoded path.
  if (typeof header !== "string" || !header.trim()) return { gzip: 0, identity: 1 };
  const weights = new Map();
  for (const item of header.split(",")) {
    const [name, ...parameters] = item.trim().toLowerCase().split(/\s*;\s*/);
    if (!/^(?:gzip|identity|\*)$/.test(name)) continue;
    const match = parameters.length === 1 && /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.exec(parameters[0]);
    const weight = parameters.length === 0 ? 1 : match ? Number(match[1]) : 0;
    // Conflicting duplicates must not turn an explicit refusal into consent.
    weights.set(name, Math.min(weights.get(name) ?? 1, weight));
  }
  return {
    gzip: weights.get("gzip") ?? weights.get("*") ?? 0,
    identity: weights.get("identity") ?? (weights.get("*") === 0 ? 0 : 1),
    identityExplicit: weights.has("identity"),
  };
}

async function verifiedSidecar(file, content) {
  let handle;
  try {
    handle = await open(`${file}.gz`, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size >= content.length) return undefined;
    const compressed = await handle.readFile();
    if (compressed.length >= content.length) return undefined;
    // A stale/corrupt artifact must not create a browser white screen. This is
    // bounded validation, not request-time compression; APIs remain untouched.
    const restored = await gunzip(compressed, { maxOutputLength: content.length + 1 });
    return restored.equals(content) ? compressed : undefined;
  } catch { return undefined; }
  finally { await handle?.close(); }
}

export async function serveV2Static(res, root, path, acceptEncoding) {
  const missing = message => Object.assign(new Error(message), { status: 404 });
  let relative;
  try { relative = decodeURIComponent(path).replace(/^\/v2\/?/, ""); }
  catch { throw missing("页面不存在"); }
  const base = resolve(root, "web-dist"), file = resolve(base, relative || "index.html");
  if (file !== base && !file.startsWith(base + "/")) throw missing("页面不存在");
  // Sidecars are representations of their original URL, not public files.
  if (extname(file) === ".gz") throw missing("静态资源不存在");
  let content;
  try { content = await readFile(file); }
  catch { if (extname(file)) throw missing("静态资源不存在"); content = await readFile(join(base, "index.html")); }
  // Only content-hashed build assets are immutable. Never cache HTML or APIs.
  const immutable = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|woff2?)$/.test(relative);
  const preference = encodingPreferences(acceptEncoding);
  const compressed = compressedAsset.test(relative) && preference.gzip > 0 &&
    (!preference.identityExplicit || preference.gzip >= preference.identity)
    ? await verifiedSidecar(file, content) : undefined;
  if (!compressed && preference.identity === 0) {
    res.writeHead(406, { Vary: "Accept-Encoding", "Cache-Control": "no-store", "Content-Length": "0" });
    return res.end();
  }
  const body = compressed ?? content;
  res.writeHead(200, {
    "Content-Type": ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" })[extname(file)] ?? "text/html",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    Vary: "Accept-Encoding", "Content-Length": String(body.length),
    ...(compressed ? { "Content-Encoding": "gzip" } : {}),
  });
  res.end(body);
}
