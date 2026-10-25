import test from "node:test";
import assert from "node:assert/strict";
import { AuthManager } from "../../src/v2/auth.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { MemorySnapshotBackend, ReplicatedMetadataStore } from "../../src/v2/metadata-replica.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";

const admin = { email: "admin@example.test", password: "StrongAdmin#2026", displayName: "虚构管理员" };
const other = { email: "other@example.test", password: "StrongOther#2026", displayName: "虚构成员" };
const wrong = { email: admin.email, password: "WrongPassword#1" };
const open = (backend) => ReplicatedMetadataStore.open({ backend, project: PROJECT, autoFlush: false });
const manager = (store, now) => new AuthManager({ store, project: PROJECT, env: {}, ...(now && { now }) });

test("account limit survives replica replacement and cannot be reset by client address or casing", async () => {
  const backend = new MemorySnapshotBackend();
  let now = Date.parse("2026-01-01T00:00:00Z");
  let store = await open(backend), auth = manager(store, () => now);
  auth.bootstrapAdmin(admin);
  auth.bootstrapAdmin(other);
  await store.flush();
  for (let index = 0; index < 5; index++) {
    await assert.rejects(auth.authenticate("login", wrong), { code: "INVALID_LOGIN" });
    await store.closeReplicated();
    store = await open(backend);
    auth = manager(store, () => now);
  }
  try {
    assert.throws(() => auth.login({ ...admin, email: " ADMIN@EXAMPLE.TEST " }, { attemptKey: "new-ip" }),
      { status: 429, code: "AUTH_RATE_LIMITED" });
    assert.equal((await auth.authenticate("login", other)).user.email, other.email);
    now += 15 * 60 * 1000;
    const result = await auth.authenticate("login", admin);
    assert.equal(result.user.email, admin.email);
    const persisted = JSON.stringify(store.list("auth_attempt", PROJECT));
    for (const secret of [admin.email, admin.password, wrong.password, "new-ip"])
      assert.equal(persisted.includes(secret), false);
    assert.equal(store.list("auth_attempt", PROJECT).length, 2);
  } finally { await store.closeReplicated(); }
});

test("a failed attempt reservation never inspects the password or creates a session", async () => {
  const store = new MetadataStore(":memory:"), auth = manager(store);
  auth.bootstrapAdmin(admin);
  let inspected = false;
  try {
    await assert.rejects(auth.authenticate("login", {
      email: admin.email,
      get password() { inspected = true; return admin.password; },
    }, { persist: async () => { throw Object.assign(new Error("unavailable"), { status: 503 }); } }), { status: 503 });
    assert.equal(inspected, false);
    assert.equal(store.list("auth_session", PROJECT).length, 0);
    assert.equal(store.list("auth_audit", PROJECT).length, 0);
  } finally { store.close(); }
});

test("competing replicas cannot both consume the fifth password attempt", async () => {
  const backend = new MemorySnapshotBackend(), seed = await open(backend), seeded = manager(seed);
  seeded.bootstrapAdmin(admin);
  for (let i = 0; i < 4; i++)
    await assert.rejects(seeded.authenticate("login", wrong), { code: "INVALID_LOGIN" });
  await seed.closeReplicated();
  const first = await open(backend), second = await open(backend);
  let checks = 0;
  const input = { email: admin.email, get password() { checks++; return wrong.password; } };
  try {
    const results = await Promise.allSettled([
      manager(first).authenticate("login", input), manager(second).authenticate("login", input),
    ]);
    assert.deepEqual(results.map((value) => value.reason.code).sort(), ["CLOUD_METADATA_CONFLICT", "INVALID_LOGIN"]);
    assert.equal(checks, 1);
    await first.refresh();
    await second.refresh();
    assert.equal(first.list("auth_attempt", PROJECT)[0].count, 5);
    await assert.rejects(manager(second).authenticate("login", admin), { code: "AUTH_RATE_LIMITED" });
    assert.equal(first.list("auth_session", PROJECT).length, 0);
  } finally { await first.closeReplicated(); await second.closeReplicated(); }
});

test("random unknown accounts and invitation codes have bounded persistent storage", () => {
  const store = new MetadataStore(":memory:"), auth = manager(store);
  try {
    for (let i = 0; i < 600; i++) {
      assert.throws(() => auth.login({ email: `unknown-${i}@example.test`, password: "wrong" }),
        (error) => ["INVALID_LOGIN", "AUTH_RATE_LIMITED"].includes(error.code));
      assert.throws(() => auth.redeemInvitation({ inviteCode: `unknown-invitation-code-${i}`, password: "wrong" }),
        (error) => ["INVALID_INVITATION", "AUTH_RATE_LIMITED"].includes(error.code));
    }
    assert.ok(store.list("auth_attempt", PROJECT).length <= 256);
    assert.equal(JSON.stringify(store.list("auth_attempt", PROJECT)).includes("unknown-invitation-code"), false);
    auth.bootstrapAdmin(admin);
    assert.equal(auth.login(admin).user.email, admin.email);
  } finally { store.close(); }
});

test("a known invitation has its own quota and failed validation is reserved before password hashing", async () => {
  const backend = new MemorySnapshotBackend(), store = await open(backend), auth = manager(store);
  auth.bootstrapAdmin(admin);
  const session = await auth.authenticate("login", admin);
  const actor = auth.sessionFromHeaders({ cookie: `shuduo_session=${session.rawToken}` });
  const invitation = auth.createInvitation(actor, { email: other.email, role: "ENGINEER" });
  try {
    for (let i = 0; i < 5; i++)
      await assert.rejects(auth.authenticate("redeem", { inviteCode: invitation.inviteCode, displayName: "虚构成员", password: "weak" }),
        { code: "WEAK_PASSWORD" });
    const restored = await open(backend);
    try {
      await assert.rejects(manager(restored).authenticate("redeem", {
        inviteCode: invitation.inviteCode, displayName: "虚构成员", password: other.password,
      }), { code: "AUTH_RATE_LIMITED" });
      assert.equal(restored.list("auth_user", PROJECT).length, 1);
      assert.equal(restored.list("auth_invitation", PROJECT)[0].status, "PENDING");
    } finally { await restored.closeReplicated(); }
  } finally { await store.closeReplicated(); }
});

async function httpApp(backend) {
  const store = await open(backend);
  const app = createV2Server({ store, env: {
    V2_LOCAL_DEVELOPMENT: "false", V2_PUBLIC_ORIGIN: "https://demo.example",
    V2_META_DRIVER: "mysql-project-snapshot-cas",
    V2_BOOTSTRAP_ADMIN_EMAIL: admin.email, V2_BOOTSTRAP_ADMIN_PASSWORD: admin.password,
  } });
  await store.flush();
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2/auth`;
  return { store, app, base, close: async () => {
    await new Promise((resolve) => app.server.close(resolve));
    await store.refresh();
    await store.closeReplicated();
  } };
}

const request = (app, body, headers = {}) => fetch(`${app.base}/login`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Shuduo-Client": "workbench", Origin: "https://demo.example", ...headers },
  body: JSON.stringify(body),
});

test("real HTTP failure counters persist and another account behind the same proxy can log in", async () => {
  const backend = new MemorySnapshotBackend();
  let app = await httpApp(backend);
  manager(app.store).bootstrapAdmin(other);
  await app.store.flush();
  try {
    for (let i = 0; i < 5; i++) {
      const response = await request(app, wrong, { "X-Forwarded-For": `192.0.2.${i}` });
      assert.equal(response.status, 401);
      assert.equal(response.headers.get("set-cookie"), null);
    }
    await app.close();
    app = await httpApp(backend);
    const limited = await request(app, admin, { "X-Forwarded-For": "198.51.100.1" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("set-cookie"), null);
    const accepted = await request(app, other);
    assert.equal(accepted.status, 200);
    const sessionCookie = accepted.headers.getSetCookie()[0];
    assert.ok(["HttpOnly", "SameSite=Strict", "Secure"].every((flag) => sessionCookie.split("; ").includes(flag)));
    const body = await accepted.json();
    const cookie = accepted.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const logout = await fetch(`${app.base}/logout`, { method: "POST", headers: {
      "Content-Type": "application/json", "X-Shuduo-Client": "workbench", "X-CSRF-Token": body.csrfToken, Cookie: cookie, Origin: "https://demo.example",
    }, body: "{}" });
    assert.equal(logout.status, 200);
    await app.close();
    app = await httpApp(backend);
    const session = await fetch(`${app.base}/session`, { headers: { Cookie: cookie } }).then((value) => value.json());
    assert.equal(session.authenticated, false);
  } finally { await app.close(); }
});

test("HTTP session flush failure never returns cookies or an authenticated success", async () => {
  const backend = new MemorySnapshotBackend(), app = await httpApp(backend);
  const original = backend.compareAndSwap.bind(backend);
  backend.compareAndSwap = async (project, version, payload) => {
    if (payload.documents.some((item) => item.kind === "auth_session"))
      throw Object.assign(new Error("持久化不可用"), { status: 503, code: "TEST_STORAGE_DOWN" });
    return original(project, version, payload);
  };
  try {
    const response = await request(app, admin);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    const restored = await open(backend);
    try {
      assert.equal(restored.list("auth_session", PROJECT).length, 0);
      assert.equal(restored.list("auth_attempt", PROJECT)[0].count, 1);
    } finally { await restored.closeReplicated(); }
  } finally { await app.close(); }
});
