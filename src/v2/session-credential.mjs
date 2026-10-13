import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,constants} from 'node:fs';
const fail=code=>Object.assign(new Error(code),{code});
export function normalizeSessionBase(base){
  const url=new URL(base);
  if(url.username||url.password||url.search||url.hash||!['http:','https:'].includes(url.protocol)||
     (url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw fail('SESSION_TRANSPORT_UNSAFE');
  return url.toString().replace(/\/$/,'');
}
function validate(value,base,project,now){
  if(value?.protocol!=='shuduo-invite-session/v1'||value.apiBaseUrl!==normalizeSessionBase(base)||value.projectId!==project||
    !/^shuduo_session=[A-Za-z0-9_-]{20,200}$/.test(value.cookie??'')||!(/^[A-Za-z0-9_-]{16,200}$/).test(value.csrfToken??'')||
    !Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now)throw fail('SESSION_SCOPE_OR_EXPIRY_INVALID');
  return value;
}
export function readSessionCredential(path,base,project,now=Date.now()){
  let fd;try{
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const info=fstatSync(fd);
    if(!info.isFile()||(info.mode&0o077)!==0||info.size>8192||(process.getuid&&info.uid!==process.getuid()))throw fail('SESSION_FILE_PERMISSIONS_INVALID');
    let value;try{value=JSON.parse(readFileSync(fd,'utf8'));}catch{throw fail('SESSION_FILE_INVALID');}
    return validate(value,base,project,now);
  }finally{if(fd!==undefined)closeSync(fd);}
}
export function saveSessionCredential(path,value){
  validate(value,value.apiBaseUrl,value.projectId,Date.now());
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,JSON.stringify(value));}finally{closeSync(fd);}
}
export async function loginSession({baseUrl,projectId,email,password,path,fetchImpl=fetch}){
  const base=normalizeSessionBase(baseUrl);
  if(typeof password!=='string'||password.length<1||password.length>128||/[\u0000-\u001f\u007f]/.test(password))throw fail('LOGIN_INPUT_INVALID');
  // Refuse overwriting any existing file before creating a server session.
  let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);throw fail('SESSION_FILE_ALREADY_EXISTS');}
  catch(e){if(e.code!=='ENOENT')throw e;}finally{if(fd!==undefined)closeSync(fd);}
  const response=await fetchImpl(base+'/auth/login',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-shuduo-client':'cli','x-project-id':projectId},body:JSON.stringify({email,password})});
  let value;try{value=await response.json();}catch{throw fail('LOGIN_RESPONSE_INVALID');}
  if(!response.ok)throw fail('LOGIN_REJECTED');
  const cookie=response.headers.getSetCookie().find(c=>c.startsWith('shuduo_session='))?.split(';')[0];
  try{
    if(value.user?.projectId!==projectId)throw fail('SESSION_PROJECT_MISMATCH');
    const record={protocol:'shuduo-invite-session/v1',apiBaseUrl:base,projectId,cookie,csrfToken:value.csrfToken,expiresAt:value.expiresAt};
    saveSessionCredential(path,record);
  }catch(e){
    if(/^shuduo_session=[A-Za-z0-9_-]{20,200}$/.test(cookie??'')&&/^[A-Za-z0-9_-]{16,200}$/.test(value.csrfToken??'')){
      try{await fetchImpl(base+'/auth/logout',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json','x-shuduo-client':'cli',Cookie:cookie,'x-csrf-token':value.csrfToken},body:'{}'});}catch{/* Do not claim server logout if its result is unknown. */}
    }
    throw e;
  }
  return {authenticated:true,role:value.role,expiresAt:value.expiresAt,sessionSaved:true};
}
