import { randomBytes, timingSafeEqual } from "node:crypto";

const internalHeader = "x-shuduo-process-hop";
export const ingressDenialReasons = Object.freeze([
  "TARGET_FORMAT", "TARGET_ENCODING", "CONTROL_DUPLICATE", "CONTROL_INCONSISTENT",
  "CONTROL_MISSING", "CONTROL_UNRECOGNIZED", "CONTROL_EVENT_ROUTE", "CONTROL_INITIALIZE",
  "HTTP_DISABLED", "INTERNAL_PATH", "ROUTE_METHOD",
]);
const deny = (ingressReason) => {
  throw Object.assign(new Error("访问入口不可用"), {
    status: 404, code: "INGRESS_DENIED", ingressReason,
  });
};

// Only for an FC-managed listener, never an internet-facing Node server.
// FC supplies x-fc-control-path. Header overwrite/rejection must be verified
// through the actual FC edge before enabling public HTTP traffic.
export function createFcIngress({ publicHttpEnabled = false, publicReadOnly = false } = {}) {
  const token = randomBytes(32).toString("hex");
  const internalHeaders = Object.freeze({ [internalHeader]: token });
  const matches = value => typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
  return Object.freeze({
    internalHeaders,
    status: Object.freeze({ mode: "FC_CONTROL_PATH", publicHttpEnabled: publicHttpEnabled === true,
      ...(publicReadOnly ? { publicReadOnly: true } : {}) }),
    assertRequest(req) {
      const target = req.url;
      // Reject alternative spellings BEFORE URL normalization or decoding.
      if (typeof target !== "string" || !target.startsWith("/") ||
          target.startsWith("//") || /[\\\s#]/.test(target)) deny("TARGET_FORMAT");
      const path = target.split("?")[0];
      if (path.includes("//") || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) deny("TARGET_ENCODING");
      const values = [];
      for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2)
        if (req.rawHeaders[i].toLowerCase() === "x-fc-control-path") values.push(req.rawHeaders[i + 1]);
      const control = req.headers["x-fc-control-path"];
      if (values.length > 1) deny("CONTROL_DUPLICATE");
      if (values.length === 1 && values[0] !== control) deny("CONTROL_INCONSISTENT");
      // No application identity is inferred from this credential. Session,
      // CSRF, project and role checks still run on the forwarded request.
      if (control === undefined && matches(req.headers[internalHeader]) &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress) &&
          path.startsWith("/api/v2/") && path !== "/api/v2/internal" && !path.startsWith("/api/v2/internal/")) return;
      if (control === "/invoke" && req.method === "POST" && target === "/invoke") return;
      if (control !== "/http-invoke") deny(control === undefined ? "CONTROL_MISSING" : control === "/invoke" ? "CONTROL_EVENT_ROUTE" : control === "/initialize" ? "CONTROL_INITIALIZE" : "CONTROL_UNRECOGNIZED");
      if (publicHttpEnabled !== true) deny("HTTP_DISABLED");
      if (path.startsWith("/api/v2/internal/") || path === "/api/v2/internal") deny("INTERNAL_PATH");
      const api = path.startsWith("/api/v2/"),
        page = path === "/" || path === "/v2" || path.startsWith("/v2/");
      if (!((api && ["GET", "POST"].includes(req.method)) || (page && req.method === "GET"))) deny("ROUTE_METHOD");
      if (publicReadOnly && req.method !== "GET" &&
          !["/api/v2/auth/login", "/api/v2/auth/logout"].includes(path))
        throw Object.assign(new Error("当前入口为只读验收模式，仅支持已有账号登录、查看和退出；任务执行与发布尚未开放"),
          { status: 403, code: "PUBLIC_READ_ONLY" });
    },
  });
}
