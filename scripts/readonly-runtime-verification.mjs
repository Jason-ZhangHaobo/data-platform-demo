import { boundedBytes } from './control-code-transport.mjs';

const sessionPath = '/api/v2/auth/session';
const statusPath = '/api/v2/status';
const waits = [1000, 2000, 4000, 8000, 12000];
const transientCodes = new Set(['CLOUD_STARTUP_PENDING', 'REQUEST_LANE_BUSY']);
const observedCodes = new Set([...transientCodes, 'PUBLIC_READ_ONLY', 'AUTHENTICATION_REQUIRED', 'INGRESS_DENIED']);
const failure = safeCode => Object.assign(new Error(safeCode), { safeCode });

export async function readReadonlyRuntimeProbe(endpoint, { baseUrl, signal, fetchImpl = fetch }) {
  if (![sessionPath, statusPath].includes(endpoint)) throw failure('PUBLICATION_HTTP_SCOPE_INVALID');
  const started = performance.now();
  const response = await fetchImpl(new URL(endpoint, baseUrl), {
    method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
    headers: { Accept: 'application/json' },
  });
  const headersMs = Math.round(performance.now() - started);
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    return { status: response.status, headersMs, format: 'NON_JSON' };
  }
  // boundedBytes rejects non-2xx before reading; decode a bounded error
  // body only to identify known startup and access responses.
  try {
    const bodyResponse = new Response(response.body, { headers: response.headers });
    const body = JSON.parse((await boundedBytes(bodyResponse, 128 * 1024)).toString('utf8'));
    return { status: response.status, headersMs, body };
  } catch (error) {
    if (signal.aborted) throw error;
    return { status: response.status, headersMs, format: 'INVALID_JSON' };
  }
}

function classify(endpoint, result) {
  const { status, body } = result ?? {};
  const code = observedCodes.has(body?.code) ? body.code : undefined;
  const evidence = { ...(Number.isInteger(status) ? { httpStatus: status } : {}),
    ...(Number.isFinite(result?.headersMs) ? { headersMs: result.headersMs } : {}), ...(code ? { code } : {}),
    ...(['NON_JSON', 'INVALID_JSON'].includes(result?.format) ? { format: result.format } : {}) };
  if ([502, 504].includes(status)) return { ...evidence, outcome: 'GATEWAY_UNAVAILABLE' };
  if (status === 503 && transientCodes.has(code)) return { ...evidence, outcome: 'APPLICATION_PENDING' };
  if ([401, 403].includes(status)) return { ...evidence, outcome: 'ACCESS_REJECTED' };
  if (status !== 200 || !body || typeof body !== 'object' || Array.isArray(body))
    return { ...evidence, outcome: 'RESPONSE_UNCONFIRMED' };
  if (endpoint === sessionPath) {
    const guest = body.authenticated === false, readOnly = body.readOnly === true,
      invitationMode = body.mode === 'INVITATION_SESSION',
      scoped = ![body.developmentOnly, body.publicationOnly, body.consumptionOnly].every(flag => flag === undefined || flag === false);
    return { ...evidence, outcome: guest && readOnly && invitationMode && !scoped ? 'MATCHED' : 'SESSION_BOUNDARY_MISMATCH',
      guest, readOnly, invitationMode, scoped };
  }
  const invitationMode = body.mode === 'PUBLIC_INVITATION', publicSessionEnforced = body.authentication?.publicSessionEnforced === true,
    publicWritesClosed = body.publicReady === false;
  return { ...evidence, outcome: invitationMode && publicSessionEnforced && publicWritesClosed ? 'MATCHED' : 'STATUS_BOUNDARY_MISMATCH',
    invitationMode, publicSessionEnforced, publicWritesClosed, sparkReady: body.spark?.healthVerified === true };
}

export async function verifyReadonlyRuntime({ read, reserve, record, now = Date.now, wait, deadline }) {
  const until = Math.min(now() + 65000, deadline);
  const probe = async (attempt, endpoint) => {
    reserve();
    const started = now();
    let result;
    try {
      result = classify(endpoint, await read(endpoint, AbortSignal.timeout(Math.max(1, Math.min(20000, until - started)))));
    } catch (error) {
      if (!['TypeError', 'TimeoutError', 'AbortError'].includes(error.name)) throw error;
      result = { outcome: 'TRANSPORT_UNCONFIRMED' };
    }
    record({ attempt, endpoint, elapsedMs: Math.max(0, now() - started), ...result });
    return result;
  };
  const retryable = new Set(['GATEWAY_UNAVAILABLE', 'APPLICATION_PENDING', 'TRANSPORT_UNCONFIRMED']);
  for (let index = 0; index <= waits.length && now() < until; index++) {
    const session = await probe(index + 1, sessionPath);
    const status = session.outcome === 'MATCHED' && now() < until ? await probe(index + 1, statusPath) : undefined;
    if (status?.outcome === 'MATCHED' && now() <= until)
      return { ready: true, readOnlyAnonymous: true, publicationOnly: false, consumptionOnly: false, sparkReady: status.sparkReady };
    const result = status ?? session;
    if (result.outcome !== 'MATCHED' && !retryable.has(result.outcome))
      throw failure(result.outcome.endsWith('_MISMATCH') || result.outcome === 'ACCESS_REJECTED'
        ? 'READONLY_RUNTIME_BOUNDARY_MISMATCH' : 'READONLY_RUNTIME_RESPONSE_UNCONFIRMED');
    if (waits[index] === undefined || now() + waits[index] >= until) break;
    await wait(waits[index]);
  }
  throw failure('READONLY_RUNTIME_RECOVERY_UNCONFIRMED');
}
