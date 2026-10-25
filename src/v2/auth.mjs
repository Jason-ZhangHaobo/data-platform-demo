import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const hash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const text = (value, name, min = 1, max = 120) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};
const email = (value) => {
  const result = text(value, "邮箱", 5, 160).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw fail(400, "邮箱格式不合法", "INVALID_EMAIL");
  return result;
};
const ROLES = Object.freeze([
  "ADMIN",
  "ENGINEER",
  "PRODUCT_MANAGER",
  "VIEWER",
]);
const PERMISSIONS = Object.freeze({
  ADMIN: ["*"],
  ENGINEER: [
    "SESSION",
    "AGENT",
    "DEVELOPMENT",
    "DELIVERY",
    "INGESTION",
    "REALTIME",
    "ASSETS",
    "QUALITY",
    "SERVICES",
    "REPORTS",
    "OPS",
    "ACCESS_REQUEST",
  ],
  PRODUCT_MANAGER: [
    "SESSION",
    "AGENT",
    "ASSETS",
    "SERVICES",
    "REPORTS",
    "ACCESS_REQUEST",
  ],
  VIEWER: ["SESSION"],
});
const SESSION_SECONDS = 8 * 60 * 60;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 5;
const UNKNOWN_ATTEMPT_BUCKETS = 128;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

export class AuthManager {
  constructor({ store, project, now = () => Date.now(), env = process.env }) {
    this.store = store;
    this.project = project;
    this.now = now;
    if (
      env.V2_BOOTSTRAP_ADMIN_EMAIL &&
      (env.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH ||
        env.V2_BOOTSTRAP_ADMIN_PASSWORD)
    )
      this.bootstrapAdmin({
        email: env.V2_BOOTSTRAP_ADMIN_EMAIL,
        password: env.V2_BOOTSTRAP_ADMIN_PASSWORD,
        passwordHash: env.V2_BOOTSTRAP_ADMIN_PASSWORD_HASH,
        displayName: env.V2_BOOTSTRAP_ADMIN_NAME ?? "平台管理员",
      });
  }

  bootstrapAdmin(input) {
    const address = email(input.email),
      existing = this.store
        .list("auth_user", this.project)
        .find((user) => user.email === address);
    if (existing) return publicUser(existing, this.project);
    const user = this.store.create("auth_user", this.project, {
      email: address,
      displayName: text(input.displayName, "显示名称", 2, 50),
      passwordHash: input.passwordHash
        ? validatePasswordHash(input.passwordHash)
        : createPasswordHash(input.password),
      status: "ACTIVE",
      memberships: [{ projectId: this.project, role: "ADMIN" }],
      source: "BOOTSTRAP_ENV",
    });
    return publicUser(user, this.project);
  }

  createInvitation(actor, input) {
    this.#requireRole(actor, "ADMIN");
    const address = email(input.email),
      role = text(input.role, "角色", 3, 30);
    if (!ROLES.includes(role) || role === "ADMIN")
      throw fail(400, "邀请角色必须是ENGINEER、PRODUCT_MANAGER或VIEWER", "INVALID_INVITE_ROLE");
    if (
      this.store
        .list("auth_user", this.project)
        .some((user) => user.email === address)
    )
      throw fail(409, "该邮箱已经是项目成员", "USER_ALREADY_EXISTS");
    const rawCode = `invite_${randomBytes(24).toString("base64url")}`,
      invitation = this.store.create("auth_invitation", this.project, {
        email: address,
        role,
        projectId: this.project,
        codeHash: hash(rawCode),
        status: "PENDING",
        invitedBy: actor.user.id,
        expiresAt: new Date(this.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      });
    this.#audit("INVITATION_CREATED", actor.user.id, {
      invitationId: invitation.id,
      role,
    });
    return {
      invitation: publicInvitation(invitation),
      inviteCode: rawCode,
      secretShownOnce: true,
    };
  }

  listInvitations(actor) {
    this.#requireRole(actor, "ADMIN");
    return this.store
      .list("auth_invitation", this.project)
      .map(publicInvitation);
  }

  // HTTP authentication must persist the attempt BEFORE testing a credential.
  // A CAS loser or unavailable database must not get a password oracle/session.
  async authenticate(operation, input, { persist } = {}) {
    const attempt = this.#reserveAttempt(operation, input);
    const flush = persist ?? (() => this.store.flush?.());
    await flush();
    const result = operation === "login"
      ? this.#login(input, attempt)
      : this.#redeemInvitation(input, attempt);
    await flush();
    return result;
  }

  // Synchronous entry points are for local callers; cloud HTTP uses authenticate.
  redeemInvitation(input) {
    return this.#redeemInvitation(input, this.#reserveAttempt("redeem", input));
  }

  #redeemInvitation(input, attempt) {
    const code = text(input.inviteCode, "邀请码", 20, 160),
      invitation = this.store
        .list("auth_invitation", this.project)
        .find((item) => item.codeHash === hash(code));
    if (
      !invitation ||
      invitation.status !== "PENDING" ||
      Date.parse(invitation.expiresAt) <= this.now()
    ) {
      throw fail(401, "邀请码无效或已过期", "INVALID_INVITATION");
    }
    if (
      this.store
        .list("auth_user", this.project)
        .some((user) => user.email === invitation.email)
    )
      throw fail(409, "该邮箱已经注册", "USER_ALREADY_EXISTS");
    const user = this.store.create("auth_user", this.project, {
      email: invitation.email,
      displayName: text(input.displayName, "显示名称", 2, 50),
      passwordHash: createPasswordHash(input.password),
      status: "ACTIVE",
      memberships: [
        { projectId: this.project, role: invitation.role },
      ],
      source: "INVITATION",
      invitationId: invitation.id,
    });
    this.store.update("auth_invitation", invitation.id, this.project, {
      status: "REDEEMED",
      redeemedBy: user.id,
      redeemedAt: new Date(this.now()).toISOString(),
    });
    this.#clearAttempt(attempt);
    this.#audit("INVITATION_REDEEMED", user.id, {
      invitationId: invitation.id,
    });
    return this.#createSession(user);
  }

  login(input) {
    return this.#login(input, this.#reserveAttempt("login", input));
  }

  #login(input, attempt) {
    const address = email(input.email);
    const user = this.store
      .list("auth_user", this.project)
      .find((item) => item.email === address && item.status === "ACTIVE");
    if (!user || !verifyPassword(input.password, user.passwordHash)) {
      throw fail(401, "邮箱或密码不正确", "INVALID_LOGIN");
    }
    this.#clearAttempt(attempt);
    this.#audit("LOGIN_SUCCEEDED", user.id, {});
    return this.#createSession(user);
  }

  changePassword(context, input) {
    const user = this.store.get("auth_user", context.user.id, this.project);
    if (!user || !verifyPassword(input.currentPassword, user.passwordHash)) {
      this.#audit("PASSWORD_CHANGE_REJECTED", context.user.id, {
        reason: "CURRENT_PASSWORD_MISMATCH",
      });
      throw fail(401, "当前密码不正确", "CURRENT_PASSWORD_INVALID");
    }
    if (verifyPassword(input.newPassword, user.passwordHash))
      throw fail(400, "新密码不能与当前密码相同", "PASSWORD_UNCHANGED");
    const updated = this.store.update("auth_user", user.id, this.project, {
      passwordHash: createPasswordHash(input.newPassword),
      passwordChangedAt: new Date(this.now()).toISOString(),
    });
    this.#audit("PASSWORD_CHANGED", user.id, {
      revokedPriorSessions: true,
    });
    return this.#createSession(updated);
  }

  sessionFromHeaders(headers = {}) {
    const cookies = parseCookies(headers.cookie),
      token = cookies.shuduo_session;
    if (!token) return undefined;
    const session = this.store
      .list("auth_session", this.project)
      .find(
        (item) =>
          item.tokenHash === hash(token) &&
          item.status === "ACTIVE" &&
          Date.parse(item.expiresAt) > this.now(),
      );
    if (!session) return undefined;
    const user = this.store.get("auth_user", session.userId, this.project);
    if (!user || user.status !== "ACTIVE") return undefined;
    const membership = user.memberships.find(
      (item) => item.projectId === this.project,
    );
    if (!membership) return undefined;
    return {
      session,
      user: publicUser(user, this.project),
      role: membership.role,
      permissions: PERMISSIONS[membership.role],
    };
  }

  requireMutation(headers, path) {
    const context = this.sessionFromHeaders(headers);
    if (!context)
      throw fail(401, "请先登录受邀账号", "AUTHENTICATION_REQUIRED");
    const csrf = headers["x-csrf-token"];
    if (
      typeof csrf !== "string" ||
      hash(csrf) !== context.session.csrfHash
    )
      throw fail(403, "写请求缺少有效CSRF令牌", "CSRF_REQUIRED");
    const permission = permissionForPath(path);
    if (
      !context.permissions.includes("*") &&
      !context.permissions.includes(permission)
    )
      throw fail(403, "当前项目角色无权执行该操作", "PROJECT_PERMISSION_DENIED");
    return context;
  }

  requireAdmin(headers) {
    const context = this.sessionFromHeaders(headers);
    if (!context) throw fail(401, "请先登录受邀账号", "AUTHENTICATION_REQUIRED");
    this.#requireRole(context, "ADMIN");
    if (
      typeof headers["x-csrf-token"] !== "string" ||
      hash(headers["x-csrf-token"]) !== context.session.csrfHash
    )
      throw fail(403, "写请求缺少有效CSRF令牌", "CSRF_REQUIRED");
    return context;
  }

  logout(headers) {
    const context = this.sessionFromHeaders(headers);
    if (context)
      this.store.update("auth_session", context.session.id, this.project, {
        status: "REVOKED",
        revokedAt: new Date(this.now()).toISOString(),
      });
    return { loggedOut: true };
  }

  sessionResponse(result, secure) {
    return {
      body: {
        user: publicUser(result.user, this.project),
        role: result.role,
        permissions: result.permissions,
        csrfToken: result.csrfToken,
        expiresAt: result.session.expiresAt,
      },
      cookies: [
        sessionCookie(result.rawToken, secure),
        csrfCookie(result.csrfToken, secure),
      ],
    };
  }

  clearCookie(secure) {
    return [
      `shuduo_session=; Path=/api/v2; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
      `shuduo_csrf=; Path=/; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`,
    ];
  }

  overview() {
    const users = this.store.list("auth_user", this.project),
      invitations = this.store.list("auth_invitation", this.project),
      sessions = this.store.list("auth_session", this.project);
    return {
      users: users.length,
      pendingInvitations: invitations.filter(
        (item) =>
          item.status === "PENDING" && Date.parse(item.expiresAt) > this.now(),
      ).length,
      activeSessions: sessions.filter(
        (item) => item.status === "ACTIVE" && Date.parse(item.expiresAt) > this.now(),
      ).length,
      passwordHash: "scrypt",
      cookie: "HttpOnly; SameSite=Strict; Secure(public)",
    };
  }

  #createSession(user) {
    for (const prior of this.store.list("auth_session", this.project))
      if (prior.userId === user.id && prior.status === "ACTIVE")
        this.store.update("auth_session", prior.id, this.project, {
          status: "REVOKED",
          revokedAt: new Date(this.now()).toISOString(),
        });
    const rawToken = `sess_${randomBytes(32).toString("base64url")}`,
      csrfToken = `csrf_${randomBytes(24).toString("base64url")}`,
      session = this.store.create("auth_session", this.project, {
        userId: user.id,
        tokenHash: hash(rawToken),
        csrfHash: hash(csrfToken),
        status: "ACTIVE",
        expiresAt: new Date(this.now() + SESSION_SECONDS * 1000).toISOString(),
      }),
      membership = user.memberships.find(
        (item) => item.projectId === this.project,
      );
    return {
      user,
      role: membership.role,
      permissions: PERMISSIONS[membership.role],
      rawToken,
      csrfToken,
      session,
    };
  }

  #requireRole(context, role) {
    if (context.role !== role)
      throw fail(403, "当前项目角色无权执行该操作", "PROJECT_PERMISSION_DENIED");
  }

  #reserveAttempt(operation, input) {
    let identity, registered;
    if (operation === "login") {
      identity = email(input.email);
      registered = this.store.list("auth_user", this.project)
        .find((item) => item.email === identity);
    } else if (operation === "redeem") {
      identity = hash(text(input.inviteCode, "邀请码", 20, 160));
      registered = this.store.list("auth_invitation", this.project)
        .find((item) => item.codeHash === identity);
    } else {
      throw fail(400, "不支持的认证操作", "INVALID_AUTH_OPERATION");
    }
    // Registered identities have independent quotas. Unknown identities share a
    // bounded set of slots, so random emails/codes cannot grow metadata forever.
    // Never trust caller IP/forwarding headers as a way to reset an account quota.
    const bucket = registered
      ? `registered:${registered.id}`
      : `unknown:${parseInt(hash(identity).slice(0, 8), 16) % UNKNOWN_ATTEMPT_BUCKETS}`;
    const keyHash = hash(`${operation}:${bucket}`);
    const prior = this.store.list("auth_attempt", this.project)
      .find((item) => item.keyHash === keyHash);
    const now = this.now();
    if (prior && (!Number.isSafeInteger(prior.count) || prior.count < 0 ||
      !Number.isSafeInteger(prior.resetAt)))
      throw fail(503, "认证保护状态异常，请稍后重试", "AUTH_ATTEMPT_STATE_INVALID");
    const active = prior && prior.resetAt > now;
    if (active && prior.count >= ATTEMPT_LIMIT)
      throw fail(429, "认证尝试过多，请在15分钟窗口结束后再试", "AUTH_RATE_LIMITED");
    const data = {
      keyHash,
      count: active ? prior.count + 1 : 1,
      resetAt: active ? prior.resetAt : now + ATTEMPT_WINDOW_MS,
    };
    return prior
      ? this.store.update("auth_attempt", prior.id, this.project, data, { expectedVersion: prior.version })
      : this.store.create("auth_attempt", this.project, data);
  }

  #clearAttempt(attempt) {
    const current = this.store.get("auth_attempt", attempt.id, this.project);
    // Do not erase another in-flight attempt. A single successful login resets
    // its own window only if no newer reservation has been made.
    if (current?.version === attempt.version)
      this.store.update("auth_attempt", current.id, this.project,
        { count: 0, resetAt: 0 }, { expectedVersion: attempt.version });
  }

  #audit(action, actorId, data) {
    this.store.create("auth_audit", this.project, {
      action,
      actorId,
      ...data,
      containsSecret: false,
      observedAt: new Date(this.now()).toISOString(),
    });
  }
}

export function createPasswordHash(password) {
  validatePassword(password);
  const salt = randomBytes(16),
    derived = scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

function validatePasswordHash(encoded) {
  if (typeof encoded !== "string")
    throw fail(400, "密码哈希格式不合法", "INVALID_PASSWORD_HASH");
  const [algorithm, n, r, p, salt, expected, extra] = encoded.split("$");
  if (
    algorithm !== "scrypt" ||
    Number(n) !== SCRYPT.N ||
    Number(r) !== SCRYPT.r ||
    Number(p) !== SCRYPT.p ||
    extra !== undefined ||
    !/^[A-Za-z0-9_-]+$/.test(salt ?? "") ||
    !/^[A-Za-z0-9_-]+$/.test(expected ?? "") ||
    Buffer.from(salt, "base64url").length !== 16 ||
    Buffer.from(expected, "base64url").length !== 64
  )
    throw fail(400, "密码哈希格式不合法", "INVALID_PASSWORD_HASH");
  return encoded;
}

function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [algorithm, n, r, p, salt, expected] = encoded.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  try {
    const actual = scryptSync(
        password,
        Buffer.from(salt, "base64url"),
        64,
        {
          N: Number(n),
          r: Number(r),
          p: Number(p),
          maxmem: SCRYPT.maxmem,
        },
      ),
      expectedBuffer = Buffer.from(expected, "base64url");
    return (
      actual.length === expectedBuffer.length &&
      timingSafeEqual(actual, expectedBuffer)
    );
  } catch {
    return false;
  }
}

function validatePassword(value) {
  if (
    typeof value !== "string" ||
    value.length < 12 ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw fail(400, "密码长度必须为12—128个字符", "WEAK_PASSWORD");
  const categories = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((rule) =>
    rule.test(value),
  ).length;
  if (categories < 3)
    throw fail(400, "密码需包含大小写字母、数字、符号中的至少三类", "WEAK_PASSWORD");
}

function publicUser(user, project) {
  const membership = user.memberships.find((item) => item.projectId === project);
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    role: membership?.role,
    projectId: project,
  };
}

function publicInvitation(invitation) {
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    projectId: invitation.projectId,
    status: invitation.status,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt,
    redeemedBy: invitation.redeemedBy,
    redeemedAt: invitation.redeemedAt,
  };
}

function parseCookies(value) {
  return Object.fromEntries(
    String(value ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf("=");
        return separator < 1
          ? [item, ""]
          : [item.slice(0, separator), item.slice(separator + 1)];
      }),
  );
}

function sessionCookie(token, secure) {
  return `shuduo_session=${token}; Path=/api/v2; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

function csrfCookie(token, secure) {
  return `shuduo_csrf=${token}; Path=/; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

function permissionForPath(path) {
  if (path === "/api/v2/auth/logout") return "SESSION";
  if (path === "/api/v2/auth/password") return "SESSION";
  if (path.startsWith("/api/v2/auth/invitations")) return "ADMIN";
  if (path.includes("/security/requests/") && path.endsWith("/review"))
    return "ADMIN";
  if (path.startsWith("/api/v2/security/requests")) return "ACCESS_REQUEST";
  if (path.startsWith("/api/v2/security")) return "ADMIN";
  if (path.startsWith("/api/v2/agent/tools")) return "AGENT";
  if (path.startsWith("/api/v2/agent/intents")) return "AGENT";
  if (path.startsWith("/api/v2/python")) return "DEVELOPMENT";
  if (path.startsWith("/api/v2/revisions") || path.startsWith("/api/v2/runs") || path.startsWith("/api/v2/agent"))
    return "DEVELOPMENT";
  if (path.startsWith("/api/v2/delivery") || path.startsWith("/api/v2/releases"))
    return "DELIVERY";
  if (path.startsWith("/api/v2/sources") || path.startsWith("/api/v2/sync"))
    return "INGESTION";
  if (path.startsWith("/api/v2/streams")) return "REALTIME";
  if (
    path.startsWith("/api/v2/assets") ||
    path.startsWith("/api/v2/metrics") ||
    path.startsWith("/api/v2/standards") ||
    path.startsWith("/api/v2/contracts")
  )
    return "ASSETS";
  if (path.startsWith("/api/v2/quality")) return "QUALITY";
  if (path.startsWith("/api/v2/data-services")) return "SERVICES";
  if (path.startsWith("/api/v2/reports")) return "REPORTS";
  if (path.startsWith("/api/v2/operations")) return "OPS";
  return "ADMIN";
}
