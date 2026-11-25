import {accessSync,openSync,closeSync,fstatSync,lstatSync,readFileSync,writeFileSync,linkSync,unlinkSync,constants} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const fail=code=>Object.assign(new Error(code),{code});
const sessionRoles=new Set(['ADMIN','ENGINEER','PRODUCT_MANAGER','VIEWER']);
const loginResponseCodes = new Map([
  ['INVALID_LOGIN', 401],
  ['INVALID_EMAIL', 400],
  ['AUTH_RATE_LIMITED', 429],
  ['CLOUD_STARTUP_PENDING', 503],
  ['CLOUD_STARTUP_UNAVAILABLE', 503],
  ['REQUEST_LANE_BUSY', 503],
  ['REQUEST_OUTCOME_UNCONFIRMED', 503],
  ['AUTH_ATTEMPT_STATE_INVALID', 503],
]);
export function normalizeSessionBase(base){
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||
     (url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fail('SESSION_TRANSPORT_UNSAFE');
  return url.toString().replace(/\/$/,'');
}
function sessionExpiry(raw,now) {
  const expiresAt = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now) throw fail('SESSION_SCOPE_OR_EXPIRY_INVALID');
  return new Date(expiresAt).toISOString();
}
function validate(value,base,project,now){
  if(value?.protocol!=='shuduo-invite-session/v1'||value.apiBaseUrl!==normalizeSessionBase(base)||value.projectId!==project||
    typeof value.cookie!=='string'||!/^shuduo_session=[A-Za-z0-9_-]{20,200}$/.test(value.cookie)||
    typeof value.csrfToken!=='string'||!/^[A-Za-z0-9_-]{16,200}$/.test(value.csrfToken))throw fail('SESSION_SCOPE_OR_EXPIRY_INVALID');
  const {protocol,apiBaseUrl,projectId,cookie,csrfToken}=value;
  return {protocol,apiBaseUrl,projectId,cookie,csrfToken,expiresAt:sessionExpiry(value.expiresAt,now)};
}
export function readSessionCredential(path,base,project,now=Date.now()){
  let fd;try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=fstatSync(fd);
    if(!info.isFile()||(info.mode&0o077)!==0||info.size>8192||(process.getuid&&info.uid!==process.getuid()))throw fail('SESSION_FILE_PERMISSIONS_INVALID');
    let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{throw fail('SESSION_FILE_INVALID');}
    return validate(value,base,project,now);
  }finally{if(fd!==undefined)closeSync(fd);}
}
export function saveSessionCredential(path,value){
  const record=validate(value,value.apiBaseUrl,value.projectId,Date.now());
  const body=JSON.stringify(record);
  const staged=join(dirname(path),'.shuduo-session-'+randomUUID()+'.tmp');
  const fd=openSync(staged,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try {
    try { writeFileSync(fd,body); } finally { closeSync(fd); }
    // Publish complete bytes without replacing a file another login just created.
    linkSync(staged,path);
  } finally { unlinkSync(staged); }
}
export function assertNewSessionFile(path) {
  if (lstatSync(path,{throwIfNoEntry:false})) throw fail('SESSION_FILE_ALREADY_EXISTS');
  accessSync(dirname(path),constants.W_OK|constants.X_OK);
}
export async function loginSession({baseUrl,projectId,email,password,path,fetchImpl=fetch}){
  const base=normalizeSessionBase(baseUrl);
  if(typeof password!=='string'||password.length<1||password.length>128||/[\u0000-\u001f\u007f]/.test(password))throw fail('LOGIN_INPUT_INVALID');
  // Refuse overwriting any existing file before creating a server session.
  assertNewSessionFile(path);
  let response;
  try {
    response=await fetchImpl(base+'/auth/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-shuduo-client':'cli','x-project-id':projectId},body:JSON.stringify({email,password})});
  } catch {
    throw fail('LOGIN_TRANSPORT_UNCONFIRMED');
  }
  let value;
  try { value=await response.json(); }
  catch { throw Object.assign(fail('LOGIN_RESPONSE_INVALID'), {httpStatus:response.status}); }
  if (!response.ok) {
    const rejection = Object.assign(fail('LOGIN_REJECTED'), {httpStatus:response.status});
    if (typeof value?.code === 'string' && loginResponseCodes.has(value.code) && loginResponseCodes.get(value.code) === response.status) rejection.reason=value.code;
    throw rejection;
  }
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith('shuduo_session='))?.split(';')[0];
  try{
    if(value?.user?.projectId!==projectId)throw fail('SESSION_PROJECT_MISMATCH');
    if(!sessionRoles.has(value.role))throw Object.assign(fail('LOGIN_RESPONSE_INVALID'),{httpStatus:response.status});
    const expiresAt=sessionExpiry(value.expiresAt,Date.now());
    const record={protocol:'shuduo-invite-session/v1',apiBaseUrl:base,projectId,cookie,csrfToken:value.csrfToken,expiresAt};
    saveSessionCredential(path,record);
    return {authenticated:true,role:value.role,expiresAt,sessionSaved:true};
  }catch(e){
    if(/^shuduo_session=[A-Za-z0-9_-]{20,200}$/.test(cookie??'')&&/^[A-Za-z0-9_-]{16,200}$/.test(value?.csrfToken??'')){
      try{await fetchImpl(base+'/auth/logout',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-shuduo-client':'cli',Cookie:cookie,'x-csrf-token':value.csrfToken},body:'{}'});}catch{/* Do not claim server logout if its result is unknown. */}
    }
    throw e;
  }
}
