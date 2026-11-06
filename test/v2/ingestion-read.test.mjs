import test from "node:test";
import assert from "node:assert/strict";
import { createIngestionReader } from "../../web/src/ingestion-read.ts";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const previewPath = "/sync/targets/raw_positions/rows";
function fixture(api) {
  const catalogs = [], previews = [], calls = [];
  const reader = createIngestionReader({ api: (...args) => { calls.push(args); return api(...args); }, onCatalog: value => catalogs.push(value), onPreview: value => previews.push(value) });
  return { reader, catalogs, previews, calls };
}

test("a slow optional preview cannot hold a confirmed catalog in loading", async () => {
  const rows = deferred();
  const f = fixture(async path => path === previewPath ? rows.promise : []);
  assert.equal(await f.reader.reload(), true);
  assert.deepEqual(f.catalogs.map(r => r.state), ["LOADING", "READY"]);
  assert.deepEqual(f.previews.map(r => r.state), ["LOADING"]);
  rows.resolve([{ position_id: "synthetic-position" }]); await rows.promise; await Promise.resolve();
  assert.equal(f.previews.at(-1).state, "READY");
  assert.equal(f.previews.at(-1).rows.length, 1);
  assert(f.calls.every(args => args.length === 1), "reads have no body or mutation");
});

test("404 preview is unknown, while successful empty directories remain usable", async () => {
  const f = fixture(async path => { if (path === previewPath) throw Object.assign(Error("默认表不可见"), { status: 404 }); return []; });
  assert.equal(await f.reader.reload(), true);
  assert.deepEqual(f.catalogs.at(-1), { state: "READY", sources: [], tasks: [], plans: [] });
  assert.equal(f.previews.at(-1).state, "ERROR");
  assert.equal(f.previews.at(-1).rows, undefined);
  assert.equal(f.previews.at(-1).loginRequired, false);
});

test("401 catalog read is not empty; explicit recovery replaces only its read error", async () => {
  let allowed = false;
  const f = fixture(async path => { if (!allowed && path !== previewPath) throw Object.assign(Error("请先登录"), { status: 401 }); return []; });
  await assert.rejects(f.reader.reload(), /请先登录/);
  assert.equal(f.catalogs.at(-1).state, "ERROR");
  assert.equal(f.catalogs.at(-1).loginRequired, true);
  assert.equal(f.catalogs.at(-1).sources, undefined);
  allowed = true; assert.equal(await f.reader.reload(), true);
  assert.deepEqual(f.catalogs.at(-1), { state: "READY", sources: [], tasks: [], plans: [] });
});

test("malformed catalog and preview payloads cannot become confirmed zero counts", async () => {
  const f = fixture(async path => path === "/sources" || path === previewPath ? null : []);
  await assert.rejects(f.reader.reload(), /接入目录响应不完整/);
  assert.equal(f.catalogs.at(-1).state, "ERROR");
  assert.equal(f.previews.at(-1).state, "ERROR");
  assert.equal(f.previews.at(-1).rows, undefined);
});

test("late catalog and preview responses cannot replace a newer successful refresh", async () => {
  const first = new Map(), used = new Set();
  const f = fixture(path => {
    if (!used.has(path)) { used.add(path); const pending = deferred(); first.set(path, pending); return pending.promise; }
    return Promise.resolve(path === previewPath ? [{ position_id: "new-position" }] : [{ id: "new-" + path }]);
  });
  const old = f.reader.reload();
  assert.equal(await f.reader.reload(), true);
  for (const [path, pending] of first) pending.resolve(path === previewPath ? [{ position_id: "old-position" }] : [{ id: "old-" + path }]);
  assert.equal(await old, false); await Promise.resolve();
  assert(f.catalogs.at(-1).sources[0].id.startsWith("new-"));
  assert.equal(f.previews.at(-1).rows[0].position_id, "new-position");
  assert.equal(f.catalogs.filter(r => r.state === "READY").length, 1);
});

test("a stale failure cannot erase the result of a newer read", async () => {
  const pending = deferred(); let sourceReads = 0;
  const f = fixture(async path => path === "/sources" && sourceReads++ === 0 ? pending.promise : []);
  const old = f.reader.reload(); await f.reader.reload(); pending.reject(Error("旧读取失败"));
  assert.equal(await old, false); assert.equal(f.catalogs.at(-1).state, "READY");
});

test("closing a reader suppresses late effects, including a StrictMode-style replacement", async () => {
  const pending = deferred();
  const old = fixture(() => pending.promise); const first = old.reader.reload(); old.reader.close();
  const replacement = fixture(async () => []); await replacement.reader.reload();
  const oldEvents = old.catalogs.length + old.previews.length;
  pending.resolve([]); assert.equal(await first, false); await Promise.resolve();
  assert.equal(old.catalogs.length + old.previews.length, oldEvents);
  assert.equal(replacement.catalogs.at(-1).state, "READY");
  assert.equal(await old.reader.reload(), false); assert.equal(await old.reader.readPreview(), false);
});

test("preview-only retry neither reloads the catalog nor invents a task", async () => {
  let visible = false;
  const f = fixture(async path => { assert.equal(path, previewPath); if (!visible) throw Object.assign(Error("预览拒绝"), { status: 403 }); return []; });
  assert.equal(await f.reader.readPreview(), false); assert.equal(f.previews.at(-1).state, "ERROR");
  visible = true; assert.equal(await f.reader.readPreview(), true);
  assert.deepEqual(f.previews.at(-1), { state: "READY", rows: [] });
  assert.deepEqual(f.catalogs, []); assert.equal(f.calls.length, 2);
});
