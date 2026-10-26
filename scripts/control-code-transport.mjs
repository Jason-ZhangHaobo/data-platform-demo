// Exact control-function transport; called only by the protected P0-A workflow.
import {createHash,createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,renameSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {codeUpdateConfig,codeUpdateLimits,codeUpdateProbes,runControlCodeUpdate,INVITED_READONLY_CODE_SCOPE} from './control-code-update.mjs';
import {auditErrorDetails,recipientKey,sealReport} from './audit-v2-oidc-readonly.mjs';
import {verifyV2MonthlyBillPages} from './verify-v2-monthly-bill-pages.mjs';
const check=(v,c)=>{if(!v)throw Object.assign(new Error(c),{safeCode:c});};
const digest=b=>createHash('sha256').update(b).digest('hex');
const directory='.runtime/control-code-update';
const keys=['enableMixMode','enableOnDemandScaling','horizontalScalingPolicies','minInstances','requestDispatchPolicy','residentPoolId','scheduledPolicies'];
export const scalingConfiguration=v=>Object.fromEntries(keys.map(k=>[k,v?.[k]??null]));
export function codeDownloadUrl(raw){
 const u=new URL(raw);check(['http:','https:'].includes(u.protocol)&&/^[a-z0-9-]+\.oss-cn-hangzhou\.aliyuncs\.com$/.test(u.hostname)&&!u.username&&!u.password&&!u.port&&!u.hash,'CODE_DOWNLOAD_TARGET_INVALID');
 u.protocol='https:';return u.href;
}
export async function boundedBytes(response,limit){
 check(response.ok&&response.body,'OBJECT_READ_NOT_CONFIRMED');
 const advertised=response.headers.get('content-length');check(advertised===null||Number(advertised)<=limit,'OBJECT_TOO_LARGE');
 const chunks=[];let bytes=0;
 for await(const chunk of response.body){bytes+=chunk.length;check(bytes<=limit,'OBJECT_TOO_LARGE');chunks.push(Buffer.from(chunk));}
 return Buffer.concat(chunks);
}
export function privateOssRequest({bucket,region,credentials,key='',query='',body,method='GET'}){
 check(region==='cn-hangzhou'&&/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket),'OSS_TARGET_INVALID');
 check(['GET','PUT'].includes(method)&&['','acl','policyStatus','publicAccessBlock'].includes(query),'OSS_OPERATION_INVALID');
 check(method!=='PUT'||(!query&&Buffer.isBuffer(body)&&key),'OSS_WRITE_INVALID');
 check(credentials.accessKeyId&&credentials.accessKeySecret&&credentials.securityToken,'OSS_STS_REQUIRED');
 const date=new Date().toUTCString(),contentType=body?'application/zip':'';
 // Inherit the verified private bucket ACL; do not request ACL mutation rights.
 const extras={'x-oss-security-token':credentials.securityToken,...(method==='PUT'?{'x-oss-forbid-overwrite':'true'}:{})};
 const canonical=Object.keys(extras).sort().map(k=>`${k}:${extras[k]}\n`).join('');
 const resource=`/${bucket}/${key}${query?'?'+query:''}`,signature=createHmac('sha1',credentials.accessKeySecret).update(`${method}\n\n${contentType}\n${date}\n${canonical}${resource}`).digest('base64');
 return{url:`https://${bucket}.oss-${region}.aliyuncs.com/${key.split('/').map(encodeURIComponent).join('/')}${query?'?'+query:''}`,options:{method,redirect:'error',signal:AbortSignal.timeout(120000),headers:{Date:date,Authorization:`OSS ${credentials.accessKeyId}:${signature}`,...extras,...(contentType?{'Content-Type':contentType}:{})},...(body?{body}:{})}};
}
export function deploymentInput(env,now=Date.now()){
 check(env.GITHUB_ACTIONS==='true'&&env.GITHUB_REF==='refs/heads/main','PROTECTED_UPDATE_REQUIRED');
 codeUpdateLimits(env.V2_CONTROL_UPDATE_APPROVED);
 let m;try{m=JSON.parse(env.V2_CONTROL_UPDATE_TARGET);}catch{check(false,'CONTROL_TARGET_INVALID');}
 check(m.config?.authorization===env.V2_CONTROL_UPDATE_APPROVED,'CONTROL_APPROVAL_SCOPE_MISMATCH');
 check(m.config?.operatorSource===env.GITHUB_SHA&&env.V2_CONTROL_OPERATOR_SHA===env.GITHUB_SHA,'OPERATOR_SOURCE_MISMATCH');
 const issued=Date.parse(m.authorizedAt),config=codeUpdateConfig(m.config,issued);
 check(issued<=now&&config.expiresAt>now&&config.expiresAt-issued<=3600000,'CONTROL_WINDOW_INVALID');
 check(m.roleArn===`acs:ram::${config.account}:role/${config.role}`&&new RegExp(`^acs:ram::${config.account}:oidc-provider/[A-Za-z0-9_-]{1,64}$`).test(m.providerArn),'CONTROL_ROLE_INVALID');
 check(/^\d{6,20}$/.test(m.buildRunId??'')&&/^\d{6,20}$/.test(m.artifactId??''),'BUILD_ID_INVALID');
 check(m.objectAclReadApproved===true,'OBJECT_ACL_READ_APPROVAL_REQUIRED');
 const privacy=m.bucketPrivacy;
 check(privacy?.bucketHash===digest(config.bucket)&&privacy.aclPrivate===true&&privacy.policyNotPublic===true&&privacy.publicAccessBlocked===true&&Date.parse(privacy.checkedAt)<=now&&now-Date.parse(privacy.checkedAt)<3600000,'CURRENT_BUCKET_PRIVACY_REQUIRED');
 check(Number.isFinite(m.unsettledReservedCny)&&m.unsettledReservedCny>=2,'UNSETTLED_RESERVE_REQUIRED');
 return{config,metadata:m};
}
export function controlCloudAdapter(config,metadata,{env=process.env,fetchImpl=fetch,exec=execFileSync,saveTransport,loadTransport,candidateBytes,saveBackup,now=Date.now,beforeRequest=()=>{},rollbackFromVerifiedObject=false}={}){
 const base=`/2023-03-30/functions/${config.functionName}`;
 const openingScope=config.authorization===INVITED_READONLY_CODE_SCOPE;
 check(!rollbackFromVerifiedObject||openingScope,'ROLLBACK_OBJECT_SCOPE_INVALID');
 if(openingScope)check(typeof saveTransport==='function','DURABLE_TRANSPORT_CHECKPOINT_REQUIRED');
 let counters=loadTransport?.()??{codeReads:0,puts:[],...(openingScope?{configurationReads:0}:{})};
 check(Number.isInteger(counters.codeReads)&&counters.codeReads>=0&&counters.codeReads<=2&&Array.isArray(counters.puts)&&counters.puts.length<=2&&new Set(counters.puts).size===counters.puts.length&&counters.puts.every(v=>[config.previous.sha256,config.candidate.sha256].includes(v)),'TRANSPORT_CHECKPOINT_INVALID');
 if(openingScope)check(Number.isInteger(counters.configurationReads)&&counters.configurationReads>=0&&counters.configurationReads<=config.maxConfigurationReads,'CONFIGURATION_READ_CHECKPOINT_INVALID');
 const save=()=>saveTransport(structuredClone(counters));
 const call=(args,body)=>{
  if(openingScope)check(now()<config.expiresAt,'CONTROL_WINDOW_EXPIRED');
  beforeRequest(args[0]==='sts'?'IDENTITY':args[0]==='bssopenapi'?'BILL_PAGE':args[1]==='GET'?'FC_READ':args[1]==='POST'?'PRIVATE_PROBE':'CODE_WRITE');
  if(openingScope&&args[0]==='fc'&&args[1]==='GET'){
   check(counters.configurationReads<config.maxConfigurationReads,'CONFIGURATION_READ_LIMIT');
   counters.configurationReads++;
   // CLI dispatch is synchronous: counters must be durably written before it.
   const saved=save();check(!saved||typeof saved.then!=='function','SYNCHRONOUS_TRANSPORT_CHECKPOINT_REQUIRED');
  }
  try{
   const text=exec('aliyun',[...args,'--region',config.region,'--connect-timeout','5','--read-timeout','40','--retry-count','0',...(body===undefined?[]:['--body',JSON.stringify(body)])],{encoding:'utf8',timeout:50000,maxBuffer:2*1024*1024,stdio:['ignore','pipe','pipe'],env:{...env,ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE',ALIBABA_CLOUD_PROFILE_MODE:'StsToken'}});
   let v=JSON.parse(text||'{}');if(typeof v==='string')v=JSON.parse(v);return v;
  }catch(e){
   const suffix=(args[2]??'').slice(base.length),operation=({GET:{'':'FC_GET_FUNCTION','/triggers':'FC_LIST_TRIGGERS','/concurrency':'FC_GET_CONCURRENCY','/scaling-config':'FC_GET_SCALING','/code':'FC_GET_CODE'},PUT:{'':'FC_UPDATE_CODE'},POST:{'/invocations':'FC_INVOKE'}})[args[1]]?.[suffix];
   throw Object.assign(new Error('CONTROL_CLOUD_REQUEST_UNCONFIRMED'),{safeCode:'CONTROL_CLOUD_REQUEST_UNCONFIRMED',safeDiagnostic:{operation:args[0]==='fc'?(operation??'FC_UNKNOWN'):args[0]==='sts'?'IDENTITY':'BILL',...auditErrorDetails(e),cliPathRejected:/can not find api by path/i.test(String(e.stderr??'')+String(e.stdout??''))}});
  }
 };
 const credentials={accessKeyId:env.ALIBABA_CLOUD_ACCESS_KEY_ID,accessKeySecret:env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,securityToken:env.ALIBABA_CLOUD_SECURITY_TOKEN};
 const oss=(pkg,method='GET',body,query='')=>{
  if(openingScope)check(now()<config.expiresAt,'CONTROL_WINDOW_EXPIRED');
  check([config.previous.key,config.candidate.key].includes(pkg.key),'OSS_OBJECT_OUTSIDE_SCOPE');
  beforeRequest(query?'OSS_METADATA':method==='PUT'?'OBJECT_PUT':'OBJECT_GET');
  const request=privateOssRequest({bucket:config.bucket,region:config.region,credentials,key:pkg.key,method,body,query});return fetchImpl(request.url,request.options);
 };
 const verify=(bytes,p)=>check(bytes.length===p.bytes&&digest(bytes)===p.sha256,'PACKAGE_BYTES_MISMATCH');
 let rollbackBytes;
 return{
  identity:()=>call(['sts','GetCallerIdentity']),
  readState:async()=>{
   let f;
   const attempts=openingScope?3:8;
   for(let n=0;n<attempts;n++){f=call(['fc','GET',base]);if(!['InProgress','Pending'].includes(f.lastUpdateStatus))break;check(n<attempts-1,'FUNCTION_UPDATE_STILL_PENDING');await new Promise(r=>setTimeout(r,1500));}
   check(f.functionName===config.functionName&&f.lastUpdateStatus!=='Failed','FUNCTION_READ_NOT_READY');
   const triggers=call(['fc','GET',base+'/triggers','--limit','100']);check(Array.isArray(triggers.triggers)&&!triggers.nextToken,'TRIGGER_LIST_INCOMPLETE');
   return{function:f,triggers:triggers.triggers,concurrency:call(['fc','GET',base+'/concurrency']),scaling:scalingConfiguration(call(['fc','GET',base+'/scaling-config','--qualifier','LATEST']))};
  },
  budget:()=>{
   const cycle=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date()),pages=[];
   for(let page=1;page<=10;page++){const v=call(['bssopenapi','QueryBill','--BillingCycle',cycle,'--PageNum',String(page),'--PageSize','300']);pages.push(v);check(v.Success===true&&Number.isSafeInteger(Number(v.Data?.TotalCount)),'BILL_UNCONFIRMED');if(page*300>=Number(v.Data.TotalCount))break;}
   const bill=verifyV2MonthlyBillPages(pages,200);return{complete:bill.ok,currentCycle:bill.billingCycle===cycle,observedCny:Number(bill.spendCny),unsettledReservedCny:metadata.unsettledReservedCny};
  },
  recoverRollback:async pkg=>{
   check(counters.codeReads<2,'CODE_DOWNLOAD_LIMIT');counters.codeReads++;await save();
   if(rollbackFromVerifiedObject){
    // runControlCodeUpdate has just matched the live FC checksum/size to this
    // previous package. Reuse that exact immutable private object instead of
    // requesting the broader GetFunctionCode permission or a signed export URL.
    const response=await oss(pkg);
    check(String(response.headers.get('x-oss-hash-crc64ecma'))===pkg.crc64,'ROLLBACK_OBJECT_CHECKSUM_MISMATCH');
    rollbackBytes=await boundedBytes(response,pkg.bytes);verify(rollbackBytes,pkg);await saveBackup(rollbackBytes);
    counters.rollbackSource='VERIFIED_PRIVATE_OBJECT';await save();
    return{sha256:pkg.sha256,bytes:pkg.bytes,codeChecksum:pkg.crc64,safelyRetained:true};
   }
   const result=call(['fc','GET',base+'/code','--qualifier','LATEST']);check(String(result.checksum)===pkg.crc64,'CURRENT_CODE_CHECKSUM_MISMATCH');
   beforeRequest('OBJECT_GET');
   const response=await fetchImpl(codeDownloadUrl(result.url),{redirect:'error',signal:AbortSignal.timeout(120000)});
   rollbackBytes=await boundedBytes(response,pkg.bytes);verify(rollbackBytes,pkg);await saveBackup(rollbackBytes);
   return{sha256:pkg.sha256,bytes:pkg.bytes,codeChecksum:pkg.crc64,safelyRetained:true};
  },
  ensurePackage:async(kind,pkg)=>{
   check(kind==='previous'||kind==='candidate','PACKAGE_KIND_INVALID');const bytes=kind==='previous'?rollbackBytes:candidateBytes;check(Buffer.isBuffer(bytes),'PACKAGE_BYTES_REQUIRED');verify(bytes,pkg);
   let response=await oss(pkg);
   if(response.status===404){
    const raw=await response.text();check(raw.length<65536&&/<Code>NoSuch(?:Key|Object)<\/Code>/.test(raw),'OBJECT_ABSENCE_NOT_CONFIRMED');
    check(!counters.puts.includes(pkg.sha256),'PREVIOUS_PUT_REQUIRES_RECONCILIATION');counters.puts.push(pkg.sha256);await save();
    // An unknown PUT is reconciled by GET, never retried as a second write.
    try{const put=await oss(pkg,'PUT',bytes);await put.body?.cancel();}catch{}
    response=await oss(pkg);
   }
   const crc64=response.headers.get('x-oss-hash-crc64ecma'),downloaded=await boundedBytes(response,pkg.bytes);verify(downloaded,pkg);
   const aclResponse=await oss(pkg,'GET',undefined,'acl');check(aclResponse.ok,'OBJECT_ACL_UNCONFIRMED');const acl=await aclResponse.text();
   check(acl.length<65536&&/<Grant>(private|default)<\/Grant>/.test(acl),'OBJECT_NOT_PRIVATE');
   check(Date.now()-Date.parse(metadata.bucketPrivacy.checkedAt)<3600000,'BUCKET_PRIVACY_EXPIRED');
   return{sha256:pkg.sha256,bytes:pkg.bytes,objectKey:pkg.key,crc64,readbackVerified:true,privateVerified:true,immutable:true};
  },
  updateCode:body=>{
   check(Object.keys(body).join(',')==='code'&&Object.keys(body.code).sort().join(',')==='checksum,ossBucketName,ossObjectName'&&body.code.ossBucketName===config.bucket&&[config.previous.key,config.candidate.key].includes(body.code.ossObjectName)&&/^\d{1,30}$/.test(body.code.checksum),'CODE_UPDATE_BODY_INVALID');
   if(openingScope&&body.code.ossObjectName===config.candidate.key)
    check(counters.configurationReads<=9,'CODE_UPDATE_RECOVERY_READ_RESERVE_REQUIRED');
   return call(['fc','PUT',base],body);
  },
  invoke:body=>{check(codeUpdateProbes.some(p=>JSON.stringify(p.body)===JSON.stringify(body)),'INVOKE_BODY_OUTSIDE_SCOPE');return call(['fc','POST',base+'/invocations','--header','Content-Type=application/octet-stream'],body);},
 };
}
export async function controlUpdateMain(env=process.env,mode=process.argv[2]){
 const {config,metadata}=deploymentInput(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
 if(mode==='--prepare'){
  check(env.GITHUB_ENV,'GITHUB_ENV_REQUIRED');
  for(const value of [config.account,config.role,config.functionName,config.bucket,config.previous.key,config.candidate.key,metadata.roleArn,metadata.providerArn])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_CONTROL_ROLE_ARN=${metadata.roleArn}\nV2_CONTROL_PROVIDER_ARN=${metadata.providerArn}\nV2_CONTROL_BUILD_RUN=${metadata.buildRunId}\nV2_CONTROL_ARTIFACT_ID=${metadata.artifactId}\n`);return;
 }
 mkdirSync(directory,{recursive:true,mode:0o700});
 const load=name=>existsSync(`${directory}/${name}.json`)?JSON.parse(readFileSync(`${directory}/${name}.json`,'utf8')):undefined;
 const save=(name,value)=>{writeFileSync(`${directory}/${name}.new`,JSON.stringify(value)+'\n',{mode:0o600});renameSync(`${directory}/${name}.new`,`${directory}/${name}.json`);};
 if(mode==='--seal'){
  const value={...load('report'),recovery:load('recovery'),checkpoint:load('checkpoint'),transport:load('transport'),applicationSource:config.applicationSource,operationId:config.operationId};
  writeFileSync('v2-control-update.sealed.json',JSON.stringify(sealReport(value,key,{protocol:'shuduo-control-update/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
 }
 check(mode===undefined||mode==='--recover','UPDATE_MODE_INVALID');
 if(mode==='--recover'&&(!load('checkpoint')?.updateRequested||['VERIFIED','ROLLED_BACK'].includes(load('checkpoint')?.phase)))return;
 check(mode==='--recover'||!load('checkpoint'),'EXISTING_CHECKPOINT_DO_NOT_REEXECUTE');
 check(env.ALIBABA_CLOUD_ACCESS_KEY_ID&&env.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&env.ALIBABA_CLOUD_SECURITY_TOKEN,'OIDC_STS_REQUIRED');
 const bytes=readFileSync('v2-function.zip');check(bytes.length===config.candidate.bytes&&digest(bytes)===config.candidate.sha256,'DOWNLOADED_PACKAGE_MISMATCH');
 const adapter=controlCloudAdapter(config,metadata,{env,candidateBytes:bytes,loadTransport:()=>load('transport'),saveTransport:v=>save('transport',v),saveBackup:b=>writeFileSync(`${directory}/rollback.zip`,b,{mode:0o600,flag:'wx'})});
 const report=await runControlCodeUpdate(config,adapter,{load:()=>load('checkpoint'),save:v=>save('checkpoint',v)});
 save(mode==='--recover'?'recovery':'report',report);check(report.passed||(mode==='--recover'&&report.rollbackVerified),'CONTROL_UPDATE_NOT_VERIFIED');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await controlUpdateMain();console.log('Private control update step finished; evidence is encrypted.');}catch(e){console.error(e.safeCode??'CONTROL_UPDATE_UNCONFIRMED');process.exitCode=1;}
}
