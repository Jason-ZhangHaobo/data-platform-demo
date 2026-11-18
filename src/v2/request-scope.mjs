export const PROJECT = "project-securities-lab";
const fail = (status, message) => Object.assign(new Error(message), { status });
export function assertV2RequestScope(req, { env, local }) {
  const origin = req.headers.origin;
  let localOriginAllowed = false;
  if (local && typeof origin === "string") {
    try {
      const parsedOrigin = new URL(origin),
        localPort = String(req.socket.localPort ?? env.V2_PORT ?? 3100);
      localOriginAllowed =
        origin === parsedOrigin.origin &&
        parsedOrigin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname) &&
        [localPort, "5173"].includes(parsedOrigin.port);
    } catch {
      localOriginAllowed = false;
    }
  }
  if (
    origin &&
    !(
      localOriginAllowed ||
      (!local &&
        typeof env.V2_PUBLIC_ORIGIN === "string" &&
        origin === env.V2_PUBLIC_ORIGIN)
    )
  )
    throw fail(403, "请求来源不允许");
  if (
    req.headers["x-project-id"] &&
    req.headers["x-project-id"] !== PROJECT
  )
    throw fail(403, "无权访问此项目");
}
