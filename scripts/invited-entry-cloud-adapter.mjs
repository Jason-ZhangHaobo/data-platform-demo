// Transport for the dedicated read-only entry sequence. No import-time cloud
// activity, arbitrary URL/path, credential forwarding, redirects or retries.
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import {auditErrorDetails} from './audit-v2-oidc-readonly.mjs';
import {scalingConfiguration} from './control-code-transport.mjs';
import {readonlyConfigIntegrity,readonlyTriggerState} from './invited-readonly-config.mjs';
import {READONLY_ENTRY_SCOPE,readonlyEntryPlan,readonlyProbesFor} from './invited-readonly-entry.mjs';

const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
const same=(a,b)=>canonical(a)===canonical(b);
const sha=value=>createHash('sha256').update(value).digest('hex');
export function readonlyDefaultEndpoint(raw,region='cn-hangzhou'){
 let url;try{url=new URL(raw);}catch{check(false,'READONLY_DEFAULT_URL_INVALID');}
 check(region==='cn-hangzhou'&&url.protocol==='https:'&&new RegExp('^[a-z0-9-]{1,63}\\.'+region+'\\.fcapp\\.run$').test(url.hostname)&&!url.username&&!url.password&&!url.port&&url.pathname==='/'&&!url.search&&!url.hash,'READONLY_DEFAULT_URL_INVALID');
 return url.origin;
}

export async function readReadonlyHttpsProbe(endpoint,probe,certificateSha256,{request=httpsRequest,timeoutMs=20000,authorization=READONLY_ENTRY_SCOPE}={}){
 const known=readonlyProbesFor(authorization).find(p=>p.id===probe?.id);
 check(known&&same(probe,known),'READONLY_PROBE_OUTSIDE_SCOPE');
 const origin=probe.target==='domain'?'https://shuduoai.cn':readonlyDefaultEndpoint(endpoint);
 check(endpoint===origin&&/^[a-f0-9]{64}$/.test(certificateSha256??''),'READONLY_PROBE_TARGET_INVALID');
 const payload=probe.body===undefined?undefined:Buffer.from(JSON.stringify(probe.body));
 const headers={Accept:probe.id==='entry-html'?'text/html':'application/json','Accept-Encoding':'identity','Cache-Control':'no-cache','X-Shuduo-Client':'workbench',Origin:'https://shuduoai.cn',...(probe.headers??{}),...(payload?{'Content-Type':'application/json','Content-Length':String(payload.length)}:{})};
 return new Promise((resolve,reject)=>{
  let settled=false,timer;
  const fail=code=>{if(!settled){settled=true;clearTimeout(timer);reject(Object.assign(new Error(code),{safeCode:code}));}};
  const req=request(new URL(probe.path,origin),{method:probe.method,headers,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2'},res=>{
   const socket=res.socket,cert=socket?.getPeerCertificate?.(),tlsTrusted=socket?.authorized===true&&['TLSv1.2','TLSv1.3'].includes(socket?.getProtocol?.());
   const matched=cert?.raw?sha(cert.raw)===certificateSha256:false;
   const chunks=[];let bytes=0;
   res.on('data',chunk=>{bytes+=chunk.length;if(bytes>65536){res.destroy();req.destroy();fail('READONLY_RESPONSE_TOO_LARGE');}else chunks.push(Buffer.from(chunk));});
   res.on('aborted',()=>fail('READONLY_RESPONSE_ABORTED'));
   res.on('error',()=>fail('READONLY_RESPONSE_FAILED'));
   res.on('end',()=>{
    if(settled)return;
    const raw=Buffer.concat(chunks);let parsed;
    try{parsed=JSON.parse(raw.toString('utf8'));}catch{}
    const code=[parsed?.code,parsed?.Code,parsed?.ErrorCode].find(v=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(v));
    // Only the fields needed for fixed acceptance reach the engine. Cookies,
    // response messages, bodies and cloud request identifiers are not logged.
    const body={
     ...(typeof parsed?.authenticated==='boolean'?{authenticated:parsed.authenticated}:{}),
     ...(typeof parsed?.readOnly==='boolean'?{readOnly:parsed.readOnly}:{}),
     ...(code?{code}:{}),
     ...(parsed?.message==='请求来源不允许'?{message:parsed.message}:{}),
     ...(probe.id==='filing-display'?{site:{icpNumber:typeof parsed?.site?.icpNumber==='string'?parsed.site.icpNumber.slice(0,100):null,registeredName:typeof parsed?.site?.registeredName==='string'?parsed.site.registeredName.slice(0,100):null}}:{}),
    };
    settled=true;clearTimeout(timer);
    resolve({status:res.statusCode,tlsTrusted,endpointMatched:tlsTrusted,certificateMatched:matched,hasSetCookie:Boolean(res.headers['set-cookie']),privateProtocol:raw.includes(Buffer.from('shuduo-v2-private-smoke'))||String(parsed?.protocol??'').startsWith('shuduo-private-'),attachment:/attachment/i.test(String(res.headers['content-disposition']??'')),contentType:String(res.headers['content-type']??'').slice(0,100),bodySha256:sha(raw),serviceCode:code,body,bytes});
   });
  });
  timer=setTimeout(()=>{req.destroy();fail('READONLY_PROBE_TIMEOUT');},timeoutMs);
  req.on('error',()=>fail('READONLY_PROBE_TRANSPORT_FAILED'));
  req.end(payload);
 });
}

export function createReadonlyEntryCloudAdapter({plan,change,env=process.env,exec=execFileSync,request=httpsRequest,now=Date.now,beforeRequest=()=>{}}){
 check(readonlyConfigIntegrity(change)&&plan.operationId===change.operationId,'READONLY_TRANSPORT_CHANGE_INVALID');
 const normalized=readonlyEntryPlan({...plan,issuedAt:new Date(plan.issuedAt).toISOString(),expiresAt:new Date(plan.expiresAt).toISOString()},plan.issuedAt);
 check(same(plan,normalized),'READONLY_TRANSPORT_PLAN_INVALID');
 check(env.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main'&&env.GITHUB_SHA===plan.operatorSource&&env.V2_READONLY_OPENING_APPROVED===plan.authorization,'READONLY_PROTECTED_TRANSPORT_REQUIRED');
 check(env.ALIBABA_CLOUD_ACCESS_KEY_ID&&env.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&env.ALIBABA_CLOUD_SECURITY_TOKEN,'READONLY_STS_REQUIRED');
 const target=change.retainedPlan.target,base='/2023-03-30/functions/'+target.functionName;
 check(target.region==='cn-hangzhou'&&/^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(target.functionName)&&/^\d{12,20}$/.test(target.account??''),'READONLY_TRANSPORT_TARGET_INVALID');
 check(env.V2_CONTROL_ROLE_ARN===`acs:ram::${target.account}:role/${target.role}`,'READONLY_TRANSPORT_ROLE_MISMATCH');
 let defaultEndpoint;
 const active=()=>check(now()<plan.expiresAt,'READONLY_TRANSPORT_EXPIRED');
 const cliEnv={...env,ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE',ALIBABA_CLOUD_PROFILE_MODE:'StsToken'};
 const call=(method,suffix='',body,query=[])=>{
  active();
  beforeRequest(method==='GET'?'FC_READ':'ENTRY_WRITE');
  const directory=body===undefined?undefined:mkdtempSync(join(tmpdir(),'shuduo-entry-body-'));
  try{
   const args=['fc',method,base+suffix,...query,'--region',target.region,'--connect-timeout','5','--read-timeout','30','--retry-count','0'];
   if(body!==undefined){const path=join(directory,'body.json');writeFileSync(path,JSON.stringify(body),{mode:0o600,flag:'wx'});args.push('--body-file',path);}
   const raw=exec('aliyun',args,{encoding:'utf8',timeout:Math.min(40000,Math.max(1,plan.expiresAt-now())),maxBuffer:2097152,stdio:['ignore','pipe','pipe'],env:cliEnv});
   let result=JSON.parse(raw||'{}');if(typeof result==='string')result=JSON.parse(result);
   return result;
  }catch(error){throw Object.assign(new Error('READONLY_FC_REQUEST_UNCONFIRMED'),{safeCode:'READONLY_FC_REQUEST_UNCONFIRMED',safeDiagnostic:{...auditErrorDetails(error),operation:method+' '+(suffix||'function')}});}
  finally{if(directory)rmSync(directory,{recursive:true,force:true});}
 };
 const domain=body=>{
  active();
  beforeRequest(body?'ENTRY_WRITE':'DOMAIN_READ');
  try{
   const raw=exec('python3',['scripts/transport-v2-domain-signed.py'],{input:JSON.stringify({authorization:plan.authorization,domainName:'shuduoai.cn',operation:body?'update':'get',...(body?{body}:{})}),encoding:'utf8',timeout:Math.min(30000,Math.max(1,plan.expiresAt-now())),maxBuffer:1048576,stdio:['pipe','pipe','pipe'],env:cliEnv});
   const result=JSON.parse(raw);
   if(result.status!==200)throw Object.assign(new Error('READONLY_DOMAIN_REQUEST_UNCONFIRMED'),{safeDiagnostic:{operation:body?'DOMAIN_UPDATE':'DOMAIN_GET',httpStatus:Number.isInteger(result.status)?result.status:0,serviceCode:typeof result.code==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(result.code)?result.code:'UNCONFIRMED',category:result.status===403?'PERMISSION':result.status===401?'AUTHENTICATION':result.status===400?'INPUT':'TRANSPORT'}});
   return body?{status:200}:result.value;
  }catch(error){throw Object.assign(new Error('READONLY_DOMAIN_REQUEST_UNCONFIRMED'),{safeCode:'READONLY_DOMAIN_REQUEST_UNCONFIRMED',safeDiagnostic:error.safeDiagnostic??{operation:body?'DOMAIN_UPDATE':'DOMAIN_GET',...auditErrorDetails(error)}});}
 };
 const exact=(body,expected)=>check(same(body,expected),'READONLY_TRANSPORT_BODY_OUTSIDE_SCOPE');
 return{
  readFunction:()=>call('GET'),
  readDomain:()=>domain(),
  listTriggers:()=>{
   const value=call('GET','/triggers',undefined,['--limit','100']);
   check(Array.isArray(value.triggers)&&!value.nextToken,'READONLY_TRIGGER_LIST_INCOMPLETE');
   defaultEndpoint=undefined;
   if(readonlyTriggerState(change,value.triggers)==='OWNED')defaultEndpoint=readonlyDefaultEndpoint(value.triggers.find(t=>t.triggerName===change.triggerBody.triggerName).httpTrigger?.urlInternet,target.region);
   return value.triggers;
  },
  readConcurrency:()=>call('GET','/concurrency'),
  readScaling:()=>scalingConfiguration(call('GET','/scaling-config',undefined,['--qualifier','LATEST'])),
  createTrigger:body=>{exact(body,change.triggerBody);return call('POST','/triggers',body);},
  updateDomain:body=>{exact(body,change.domainBody);return domain(body);},
  openFunction:body=>{exact(body,change.functionBody);return call('PUT','',body);},
  closeFunction:body=>{exact(body,change.rollbackFunctionBody);return call('PUT','',body);},
  restoreDomain:body=>{exact(body,change.rollbackDomainBody);return domain(body);},
  deleteTrigger:name=>{check(name===change.triggerBody.triggerName,'READONLY_TRIGGER_OUTSIDE_SCOPE');return call('DELETE','/triggers/'+name);},
  probe:probe=>{
   active();
   const endpoint=probe.target==='domain'?'https://shuduoai.cn':defaultEndpoint;
   check(endpoint,'READONLY_DEFAULT_URL_NOT_VERIFIED');
   beforeRequest('HTTP_PROBE');
   return readReadonlyHttpsProbe(endpoint,probe,change.retainedPlan.desired.certificateSha256,{request,authorization:plan.authorization,timeoutMs:Math.min(20000,Math.max(1,plan.expiresAt-now()))});
  },
 };
}
