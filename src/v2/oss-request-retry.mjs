const transientStatuses = new Set([429, 500, 502, 503, 504]);
const transientCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const retriedResponses = new WeakSet();

const safeFailure = (exhausted) =>
  Object.assign(
    new Error(
      exhausted
        ? "OSS请求暂不可用，已完成有界重试"
        : "OSS请求失败",
    ),
    {
      status: 503,
      code: exhausted ? "OSS_REQUEST_RETRIES_EXHAUSTED" : "OSS_REQUEST_FAILED",
    },
  );

function transientNetworkError(error) {
  return (
    error?.name === "TypeError" ||
    transientCodes.has(error?.code) ||
    transientCodes.has(error?.cause?.code)
  );
}

export async function requestOssWithRetry(
  createRequest,
  fetchImpl,
  options = {},
) {
  const attempts = options.attempts ?? 3,
    delayMs = options.delayMs ?? 500,
    sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 6)
    throw Object.assign(new Error("OSS重试次数不合法"), {
      code: "OSS_RETRY_CONFIG_INVALID",
    });
  if (!Number.isSafeInteger(delayMs) || delayMs < 100 || delayMs > 5000)
    throw Object.assign(new Error("OSS重试间隔不合法"), {
      code: "OSS_RETRY_CONFIG_INVALID",
    });
  let retried = false;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const request = createRequest(),
        response = await fetchImpl(request.url, request.options);
      if (!transientStatuses.has(response.status) || attempt === attempts) {
        if (retried) retriedResponses.add(response);
        return response;
      }
      retried = true;
    } catch (error) {
      if (!transientNetworkError(error)) throw safeFailure(false);
      if (attempt === attempts) throw safeFailure(true);
      retried = true;
    }
    await sleep(Math.min(delayMs * attempt, 5000));
  }
  throw safeFailure(true);
}

export function wasOssRequestRetried(response) {
  return retriedResponses.has(response);
}
