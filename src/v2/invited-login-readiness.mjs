import {setTimeout as delay} from 'node:timers/promises';
import {normalizeSessionBase} from './session-credential.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const transientCodes=new Set(['EAI_AGAIN','ECONNRESET','ETIMEDOUT','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT']);

async function smallJson(response) {
  const chunks=[];
  let size=0;
  try {
    for await (const chunk of response.body) {
      size+=chunk.byteLength;
      if (size>8192) return;
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return; }
}

// Only the anonymous readiness read can be retried. Password submission is
// owned by the caller and never happens here.
export async function waitForInvitedLogin({baseUrl,fetchImpl=fetch,wait=delay}) {
  let endpoint;
  try {
    const base=normalizeSessionBase(baseUrl);
    if (new URL(base).protocol!=='https:') throw Error();
    endpoint=base+'/auth/session';
  } catch { throw fail('LOGIN_PREFLIGHT_UNCONFIRMED'); }

  let lastCode='LOGIN_PREFLIGHT_UNCONFIRMED';
  for (const ms of [0,1500,3500]) {
    if (ms) {
      try { await wait(ms); } catch { throw fail('LOGIN_PREFLIGHT_UNCONFIRMED'); }
    }
    let response;
    try {
      response=await fetchImpl(endpoint,{method:'GET',headers:{Accept:'application/json'},
        credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
    } catch (e) {
      if (e?.name!=='TimeoutError' && !transientCodes.has(e?.cause?.code??e?.code))
        throw fail('LOGIN_PREFLIGHT_UNCONFIRMED');
      lastCode='LOGIN_PREFLIGHT_UNCONFIRMED';
      continue;
    }
    const status=response && !response.redirected && (!response.url || response.url===endpoint) ? response.status : undefined;
    if (status!==200 && status!==503) {
      await response?.body?.cancel().catch(()=>{});
      if (status===429) throw fail('LOGIN_PREFLIGHT_RATE_LIMITED');
      if (status===502 || status===504) {
        lastCode='LOGIN_PREFLIGHT_UNCONFIRMED';
        continue;
      }
      throw fail('LOGIN_PREFLIGHT_UNCONFIRMED');
    }
    const body=await smallJson(response);
    if (status===200 && body?.mode==='INVITATION_SESSION' && body.authenticated===false) return;
    if (status!==503 || !['CLOUD_STARTUP_PENDING','REQUEST_LANE_BUSY'].includes(body?.code))
      throw fail('LOGIN_PREFLIGHT_UNCONFIRMED');
    lastCode='LOGIN_PREFLIGHT_PENDING';
  }
  throw fail(lastCode);
}
