import { readFile } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
export async function serveV2Static(res, root, path) {
  const relative = decodeURIComponent(path).replace(/^\/v2\/?/, ""), base = resolve(root, "web-dist"), file = resolve(base, relative || "index.html");
  const missing = message => Object.assign(new Error(message), { status: 404 });
  if (file !== base && !file.startsWith(base + "/")) throw missing("页面不存在");
  let content;
  try { content = await readFile(file); }
  catch { if (extname(file)) throw missing("静态资源不存在"); content = await readFile(join(base, "index.html")); }
  // Only content-hashed build assets are immutable. Never cache HTML or APIs.
  const immutable = /^assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|woff2?)$/.test(relative);
  res.writeHead(200, { "Content-Type": ({ ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".woff": "font/woff", ".woff2": "font/woff2" })[extname(file)] ?? "text/html", "X-Content-Type-Options": "nosniff", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" });
  res.end(content);
}
