import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForInvitedLogin} from '../../src/v2/invited-login-readiness.mjs';

const baseUrl='https://securities.example.invalid/api/v2';
const ready=()=>Response.json({authenticated:false,mode:'INVITATION_SESSION'});
const sentinel='synthetic-response-detail-not-for-display';

function attempt(sequence) {
  const calls=[], waits=[];
  const fetchImpl=async(url,options)=>{
    calls.push(url);
    assert.equal(url,baseUrl+'/auth/session');
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'omit');
    assert.equal(options.cache,'no-store');
    assert.deepEqual([...new Headers(options.headers).keys()],['accept']);
    assert.equal(options.body,undefined);
    assert.ok(options.signal instanceof AbortSignal);
    const next=sequence[calls.length-1];
    if (next instanceof Error) throw next;
    return next;
  };
  return {calls,waits,run:()=>waitForInvitedLogin({baseUrl,fetchImpl,wait:async ms=>{waits.push(ms);}})};
}

test('cold and busy invitation service requires only anonymous same-origin reads until ready',async()=>{
  const r=attempt([Response.json({code:'CLOUD_STARTUP_PENDING'},{status:503}),
    Response.json({code:'REQUEST_LANE_BUSY'},{status:503}),ready()]);
  await r.run();
  assert.equal(r.calls.length,3);
  assert.deepEqual(r.waits,[1500,3500]);
});

test('a known transient transport or gateway failure can recover on the next read',async()=>{
  for(const initial of [new DOMException(sentinel,'TimeoutError'),
    new TypeError(sentinel,{cause:{code:'ECONNRESET'}}),new Response('',{status:502}),new Response('',{status:504})]){
    const r=attempt([initial,ready()]);
    await r.run();
    assert.equal(r.calls.length,2);
  }
});

test('retry exhaustion preserves the final classified state without issuing another request',async()=>{
  for(const [makeResponse,expected] of [
    [()=>Response.json({code:'CLOUD_STARTUP_PENDING',message:sentinel},{status:503}),'LOGIN_PREFLIGHT_PENDING'],
    [()=>new Response(sentinel,{status:504}),'LOGIN_PREFLIGHT_UNCONFIRMED'],
  ]){
    const r=attempt(Array.from({length:3},makeResponse));
    await assert.rejects(r.run(),{code:expected,message:expected});
    assert.equal(r.calls.length,3);
    assert.equal(r.waits.length,2);
  }
});

test('rate limiting, non-invitation replies, redirect and malformed or oversized payloads stop before login',async()=>{
  for(const response of [
    Response.json({message:sentinel},{status:429}),new Response(sentinel,{status:403}),
    new Response(null,{status:302,headers:{location:'https://other.example.invalid'}}),
    Response.json({code:'UNKNOWN',message:sentinel},{status:503}),
    Response.json({mode:'INVITATION_SESSION',authenticated:true}),Response.json({mode:'LOCAL_DEVELOPMENT_BYPASS',authenticated:false}),
    new Response(sentinel),Response.json({mode:'INVITATION_SESSION',authenticated:false,padding:'x'.repeat(8192)}),
    new TypeError(sentinel),
  ]){
    const expected=response.status===429?'LOGIN_PREFLIGHT_RATE_LIMITED':'LOGIN_PREFLIGHT_UNCONFIRMED';
    const r=attempt([response]);
    await assert.rejects(r.run(),{code:expected,message:expected});
    assert.equal(r.calls.length,1);
    assert.equal(r.waits.length,0);
  }
});

test('unsafe or ambiguous base URLs do not make a readiness request or escape into diagnostics',async()=>{
  let calls=0;
  for(const invalid of ['http://securities.example.invalid/api/v2','https://u:'+sentinel+'@example.invalid/api/v2',
    baseUrl+'?query='+sentinel,baseUrl+'#'+sentinel,sentinel])
    await assert.rejects(waitForInvitedLogin({baseUrl:invalid,fetchImpl:async()=>{calls++;return ready();}}),
      {code:'LOGIN_PREFLIGHT_UNCONFIRMED',message:'LOGIN_PREFLIGHT_UNCONFIRMED'});
  assert.equal(calls,0);
});
