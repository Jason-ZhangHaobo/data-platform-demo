import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server } from "../../src/v2/server.mjs";
import { referenceSql } from "../../src/v2/context.mjs";

const origin = "https://demo.example";
async function request(base, path, { body, cookie, csrf, key = "auth-api" } = {}) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Accept: "application/json",
      Origin: origin,
      "X-Shuzhan-Client": "workbench",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(body === undefined ? {} : { "Idempotency-Key": key }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = response.headers.getSetCookie?.() ?? [];
  return {
    status: response.status,
    body: await response.json(),
    cookie: setCookies.map((value) => value.split(";", 1)[0]).join("; "),
    setCookies,
  };
}

test("public invitation sessions enforce CSRF and project role permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-auth-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root,
      store,
      env: {
        V2_LOCAL_DEVELOPMENT: "false",
        V2_PUBLIC_ORIGIN: origin,
        V2_BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
        V2_BOOTSTRAP_ADMIN_PASSWORD: "StrongAdmin#2026",
        V2_BOOTSTRAP_ADMIN_NAME: "虚构管理员",
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const anonymous = await request(base, "/revisions", {
      body: { sql: referenceSql, contextId: "holdings-t1" },
      key: "anonymous-write",
    });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.code, "AUTHENTICATION_REQUIRED");
    const login = await request(base, "/auth/login", {
      body: {
        email: "admin@example.test",
        password: "StrongAdmin#2026",
      },
      key: "admin-login",
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.role, "ADMIN");
    assert.ok(login.cookie.includes("shuzhan_session="));
    assert.ok(login.cookie.includes("shuzhan_csrf="));
    assert.ok(login.setCookies.every((value) => value.includes("Secure")));
    const noCsrf = await request(base, "/auth/invitations", {
      body: { email: "engineer@example.test", role: "ENGINEER" },
      cookie: login.cookie,
      key: "missing-csrf",
    });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.body.code, "CSRF_REQUIRED");
    const invitation = await request(base, "/auth/invitations", {
      body: { email: "engineer@example.test", role: "ENGINEER" },
      cookie: login.cookie,
      csrf: login.body.csrfToken,
      key: "create-invite",
    });
    assert.equal(invitation.status, 201);
    assert.match(invitation.body.inviteCode, /^invite_/);
    const redeemed = await request(base, "/auth/redeem", {
      body: {
        inviteCode: invitation.body.inviteCode,
        displayName: "虚构工程师",
        password: "Engineer#Pass2026",
      },
      key: "redeem-invite",
    });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.role, "ENGINEER");
    const revision = await request(base, "/revisions", {
      body: { sql: referenceSql, contextId: "holdings-t1" },
      cookie: redeemed.cookie,
      csrf: redeemed.body.csrfToken,
      key: "engineer-revision",
    });
    assert.equal(revision.status, 201);
    const forbiddenInvite = await request(base, "/auth/invitations", {
      body: { email: "other@example.test", role: "VIEWER" },
      cookie: redeemed.cookie,
      csrf: redeemed.body.csrfToken,
      key: "engineer-invite",
    });
    assert.equal(forbiddenInvite.status, 403);
    assert.equal(forbiddenInvite.body.code, "PROJECT_PERMISSION_DENIED");
    const modelKey = await request(base, "/settings/model-key", {
      body: { apiKey: "sk-" + "LOCAL_TEST_ONLY_".repeat(3) },
      cookie: login.cookie,
      csrf: login.body.csrfToken,
      key: "public-model-key",
    });
    assert.equal(modelKey.status, 403);
    const session = await request(base, "/auth/session", {
      cookie: redeemed.cookie,
    });
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.user.email, "engineer@example.test");
    const logout = await request(base, "/auth/logout", {
      body: {},
      cookie: redeemed.cookie,
      csrf: redeemed.body.csrfToken,
      key: "logout",
    });
    assert.equal(logout.body.loggedOut, true);
    assert.equal(
      (await request(base, "/auth/session", { cookie: redeemed.cookie })).body
        .authenticated,
      false,
    );
    const status = await request(base, "/status");
    assert.equal(status.body.mode, "PUBLIC_INVITATION");
    assert.equal(status.body.authentication.publicSessionEnforced, true);
    assert.equal(status.body.authentication.users, 2);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
