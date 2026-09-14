import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { AuthManager } from "../../src/v2/auth.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-auth-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    auth = new AuthManager({ store, project: PROJECT, env: {} });
  return { store, auth, close: () => store.close() };
}

test("single-use invitation creates a hashed-password member and revocable session", () => {
  const app = setup();
  try {
    app.auth.bootstrapAdmin({
      email: "admin@example.test",
      password: "StrongAdmin#2026",
      displayName: "虚构管理员",
    });
    const adminLogin = app.auth.login({
        email: "admin@example.test",
        password: "StrongAdmin#2026",
      }),
      admin = app.auth.sessionFromHeaders({
        cookie: `shuzhan_session=${adminLogin.rawToken}`,
      }),
      issued = app.auth.createInvitation(admin, {
        email: "engineer@example.test",
        role: "ENGINEER",
      });
    assert.match(issued.inviteCode, /^invite_/);
    assert.equal(issued.secretShownOnce, true);
    assert.doesNotMatch(
      JSON.stringify(app.store.list("auth_invitation", PROJECT)),
      new RegExp(issued.inviteCode),
    );
    const redeemed = app.auth.redeemInvitation({
      inviteCode: issued.inviteCode,
      displayName: "虚构工程师",
      password: "Engineer#Pass2026",
    });
    assert.equal(redeemed.role, "ENGINEER");
    assert.throws(
      () =>
        app.auth.redeemInvitation({
          inviteCode: issued.inviteCode,
          displayName: "重复兑换",
          password: "Another#Pass2026",
        }),
      { status: 401, code: "INVALID_INVITATION" },
    );
    const users = app.store.list("auth_user", PROJECT),
      engineer = users.find((user) => user.email === "engineer@example.test");
    assert.match(engineer.passwordHash, /^scrypt\$/);
    assert.doesNotMatch(JSON.stringify(engineer), /Engineer#Pass2026/);
    const context = app.auth.sessionFromHeaders({
      cookie: `shuzhan_session=${redeemed.rawToken}`,
    });
    assert.equal(context.user.email, "engineer@example.test");
    assert.ok(context.permissions.includes("DEVELOPMENT"));
    assert.equal(
      app.auth.requireMutation(
        {
          cookie: `shuzhan_session=${redeemed.rawToken}`,
          "x-csrf-token": redeemed.csrfToken,
        },
        "/api/v2/revisions",
      ).role,
      "ENGINEER",
    );
    assert.throws(
      () =>
        app.auth.requireMutation(
          { cookie: `shuzhan_session=${redeemed.rawToken}` },
          "/api/v2/revisions",
        ),
      { status: 403, code: "CSRF_REQUIRED" },
    );
    assert.throws(
      () =>
        app.auth.requireMutation(
          {
            cookie: `shuzhan_session=${redeemed.rawToken}`,
            "x-csrf-token": redeemed.csrfToken,
          },
          "/api/v2/auth/invitations",
        ),
      { status: 403, code: "PROJECT_PERMISSION_DENIED" },
    );
    app.auth.logout({ cookie: `shuzhan_session=${redeemed.rawToken}` });
    assert.equal(
      app.auth.sessionFromHeaders({
        cookie: `shuzhan_session=${redeemed.rawToken}`,
      }),
      undefined,
    );
  } finally {
    app.close();
  }
});

test("password policy and login rate limit fail closed without storing secrets", () => {
  const app = setup();
  try {
    assert.throws(
      () =>
        app.auth.bootstrapAdmin({
          email: "weak@example.test",
          password: "weak",
          displayName: "弱密码用户",
        }),
      { status: 400, code: "WEAK_PASSWORD" },
    );
    app.auth.bootstrapAdmin({
      email: "admin@example.test",
      password: "StrongAdmin#2026",
      displayName: "虚构管理员",
    });
    for (let index = 0; index < 5; index++)
      assert.throws(
        () =>
          app.auth.login(
            {
              email: "admin@example.test",
              password: "WrongPassword#1",
            },
            { attemptKey: "same-client" },
          ),
        { status: 401, code: "INVALID_LOGIN" },
      );
    assert.throws(
      () =>
        app.auth.login(
          {
            email: "admin@example.test",
            password: "StrongAdmin#2026",
          },
          { attemptKey: "same-client" },
        ),
      { status: 429, code: "AUTH_RATE_LIMITED" },
    );
    assert.ok(
      app.store
        .list("auth_audit", PROJECT)
        .every((audit) => audit.containsSecret === false),
    );
  } finally {
    app.close();
  }
});
