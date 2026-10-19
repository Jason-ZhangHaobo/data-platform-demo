import { randomBytes, timingSafeEqual } from "node:crypto";

const internalHeader = "x-shuduo-process-hop";
const deny = () => {
  throw Object.assign(new Error("访问入口不可用"), {
    status: 404, code: "INGRESS_DENIED",
  });
};

// Only for an FC-managed listener, never an internet-facing Node server.
// FC supplies x-fc-control-path. Header overwrite/rejection must be verified
// through the actual FC edge before enabling public HTTP traffic.
export function createFcIngress({ publicHttpEnabled = false } = {}) {
  const token = randomBytes(32).toString("hex");
  const internalHeaders = Object.freeze({ [internalHeader]: token });
  const matches = value => typeof value === "string" &&
    Buffer.byteLength(value) === Buffer.byteLength(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
  return Object.freeze({
    internalHeaders,
    status: Object.freeze({ mode: "FC_CONTROL_PATH", publicHttpEnabled: publicHttpEnabled === true }),
    assertRequest(req) {
      const target = req.url;
      // Reject alternative spellings BEFORE URL normalization or decoding.
      if (typeof target !== "string" || !target.startsWith("/") ||
          target.startsWith("//") || /[\\\s#]/.test(target)) deny();
      const path = target.split("?")[0];
      if (path.includes("//") || /%|(?:^|\/)\.{1,2}(?:\/|$)/.test(path)) deny();
      const values = [];
      for (let i = 0; i < (req.rawHeaders?.length ?? 0); i += 2)
        if (req.rawHeaders[i].toLowerCase() === "x-fc-control-path") values.push(req.rawHeaders[i + 1]);
      const control = req.headers["x-fc-control-path"];
      if (values.length > 1 || (values.length === 1 && values[0] !== control)) deny();
      // No application identity is inferred from this credential. Session,
      // CSRF, project and role checks still run on the forwarded request.
      if (control === undefined && matches(req.headers[internalHeader]) &&
          ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress) &&
          path.startsWith("/api/v2/") && path !== "/api/v2/internal" && !path.startsWith("/api/v2/internal/")) return;
      if (control === "/invoke" && req.method === "POST" && target === "/invoke") return;
      if (control !== "/http-invoke" || publicHttpEnabled !== true) deny();
      if (path.startsWith("/api/v2/internal/") || path === "/api/v2/internal") deny();
      const api = path.startsWith("/api/v2/"),
        page = path === "/" || path === "/v2" || path.startsWith("/v2/");
      if (!((api && ["GET", "POST"].includes(req.method)) || (page && req.method === "GET"))) deny();
    },
  });
}
