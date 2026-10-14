// Provider response bodies, URLs, exception messages and causes are never persisted.
const trusted = new WeakMap();
const phases = new Set(["PREPARE", "REQUEST", "RESPONSE", "PARSE", "LEASE"]);
const codes = new Set(["MODEL_KEY_MISSING", "MODEL_CONFIG_INVALID", "MODEL_CONTEXT_BUDGET",
  "MODEL_HTTP_ERROR", "MODEL_TIMEOUT", "MODEL_TRANSPORT_ERROR", "MODEL_RESPONSE_INVALID",
  "MODEL_INTERRUPTED", "MODEL_STEP_ERROR", "MONTHLY_MODEL_BUDGET_EXCEEDED", "MONTHLY_HARD_BUDGET_EXCEEDED"]);
const networkCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

export function modelFailure(code, phase, { httpStatus, elapsedMs = 0, networkCode } = {}) {
  const messages = { MODEL_KEY_MISSING: "尚未配置模型 API", MODEL_CONFIG_INVALID: "模型 API 或预算配置不合法",
    MODEL_CONTEXT_BUDGET: "上下文超过本次预算，请缩小代码与元数据范围",
    MODEL_RESPONSE_INVALID: "模型未返回可解析且符合契约的 SQL 产物",
    MODEL_HTTP_ERROR: "模型服务返回错误，请查看安全诊断中的 HTTP 状态" };
  const error = Object.assign(new Error(messages[code] ?? "模型步骤未完成；请查看安全诊断分类"), { code });
  trusted.set(error, { code: codes.has(code) ? code : "MODEL_STEP_ERROR",
    phase: phases.has(phase) ? phase : "REQUEST",
    requestMayHaveBeenSent: phase !== "PREPARE",
    ...(Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? { httpStatus } : {}),
    ...(networkCodes.has(networkCode) ? { networkCode } : {}),
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs)) : 0 });
  return error;
}

export function safeModelDiagnostic(error, elapsedMs = 0) {
  if (trusted.has(error)) return { ...trusted.get(error) };
  if (["MONTHLY_MODEL_BUDGET_EXCEEDED", "MONTHLY_HARD_BUDGET_EXCEEDED"].includes(error?.code))
    return { code: error.code, phase: "PREPARE", requestMayHaveBeenSent: false, elapsedMs: Math.max(0, Math.floor(elapsedMs)) };
  return { code: "MODEL_STEP_ERROR", phase: "REQUEST", requestMayHaveBeenSent: true,
    elapsedMs: Math.max(0, Math.floor(elapsedMs)) };
}
