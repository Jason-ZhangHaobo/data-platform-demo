import {execFileSync} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditConfig,recipientKey,sealReport,classifyAuditError,auditErrorDetails} from './audit-v2-oidc-readonly.mjs';
const fail=code=>Object.assign(new Error(code),{safeCode:code});

export function domainAuditConfig(env,now=Date.now()) {
 if(env.GITHUB_REF!=='refs/heads/main'||! /^[a-f0-9]{40}$/.test(env.GITHUB_SHA??'')||env.GITHUB_SHA!==env.V2_DOMAIN_SOURCE_SHA||env.V2_DOMAIN_READ_AUTHORIZATION!=='ONE_DOMAIN_READ_MAX_TWO')throw fail('DOMAIN_AUDIT_AUTHORIZATION_INVALID');
 const remaining=Date.parse(env.V2_DOMAIN_READ_EXPIRES_AT)-now;
 if(!Number.isFinite(remaining)||remaining<=0||remaining>3600000)throw fail('DOMAIN_AUDIT_WINDOW_INVALID');
 let input;try{input=JSON.parse(env.V2_DOMAIN_READ_TARGET);}catch{throw fail('DOMAIN_AUDIT_TARGET_INVALID');}
 if(input.domainName!=='shuduoai.cn')throw fail('DOMAIN_AUDIT_TARGET_INVALID');
 const config=auditConfig({V2_DEPLOY_ROLE_ARN:input.roleArn,V2_DEPLOY_OIDC_PROVIDER_ARN:input.providerArn,V2_FUNCTION_NAME:input.functionName,ALIBABA_CLOUD_REGION_ID:input.region});
 return {...config,domainName:input.domainName,roleArn:input.roleArn,providerArn:input.providerArn,expiresAt:Date.parse(env.V2_DOMAIN_READ_EXPIRES_AT)};
}

export function runDomainReadAudit(config,call,now=Date.now) {
 const report={scope:'DOMAIN_READ_ONLY',identity:'NOT_CHECKED',domain:{state:'NOT_CHECKED'},domainRequests:0,cloudWrites:0,modelCalls:0,sparkRuns:0};
 try{
  const identity=call(['sts','GetCallerIdentity']);
  if(String(identity.AccountId)!==config.account||!String(identity.Arn??'').startsWith(`acs:ram::${config.account}:assumed-role/${config.role}/`))throw fail('IDENTITY_MISMATCH');
  report.identity='VERIFIED';
  if(now()>=config.expiresAt)throw fail('DOMAIN_AUDIT_WINDOW_EXPIRED');
  report.domainRequests=1;
  const value=call(['fc','GET',`/2023-03-30/custom-domains/${config.domainName}`]);
  if(value.ok!==true||value.status!==200||!Number.isSafeInteger(value.routeCount)||value.routeCount<0||value.routeCount>100||typeof value.hasCertificate!=='boolean'||typeof value.allRoutesTargetConfiguredFunction!=='boolean')throw fail('DOMAIN_RESPONSE_MISMATCH');
  report.domain={state:'CONFIGURED',protocol:['HTTP','HTTPS','HTTP,HTTPS'].includes(value.protocol)?value.protocol:'UNCONFIRMED',hasCertificate:value.hasCertificate,routeCount:value.routeCount,allRoutesTargetConfiguredFunction:value.allRoutesTargetConfiguredFunction};
 }catch(error){
  const details=auditErrorDetails(error);
  const diagnostic={serviceCode:details.serviceCode,transport:details.transport,...(Number.isInteger(error.status)&&error.status>=0&&error.status<=599?{httpStatus:error.status}:{})};
  if(report.domainRequests===1&&['CustomDomainNotFound','DomainNameNotFound','DomainNotFound','ResourceNotFound.CustomDomain'].includes(details.serviceCode))report.domain={state:'NOT_CONFIGURED',...diagnostic};
  else report.domain={state:error.safeCode??classifyAuditError(error),...diagnostic};
 }
 report.passed=report.identity==='VERIFIED'&&['CONFIGURED','NOT_CONFIGURED'].includes(report.domain.state);
 return report;
}

export function domainAuditMain(env=process.env,args=process.argv.slice(2)) {
 const config=domainAuditConfig(env),key=recipientKey(env.V2_AUDIT_RECIPIENT_KEY);
 if(args[0]==='--prepare'){
  if(!env.GITHUB_ENV)throw fail('GITHUB_ENV_REQUIRED');
  for(const value of [config.account,config.role,config.roleArn,config.providerArn,config.functionName])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_DOMAIN_ROLE_ARN=${config.roleArn}\nV2_DOMAIN_PROVIDER_ARN=${config.providerArn}\n`);
  return;
 }
 if(args.length||!env.ALIBABA_CLOUD_ACCESS_KEY_ID||!env.ALIBABA_CLOUD_ACCESS_KEY_SECRET||!env.ALIBABA_CLOUD_SECURITY_TOKEN)throw fail('OIDC_STS_REQUIRED');
 const call=params=>{
  if(params[0]==='fc'){
   const value=JSON.parse(execFileSync('python3',[fileURLToPath(new URL('./read-v2-domain-signed.py',import.meta.url))],{input:JSON.stringify({domainName:config.domainName,account:config.account,functionName:config.functionName,region:config.region}),encoding:'utf8',timeout:30000,maxBuffer:65536,stdio:['pipe','pipe','pipe'],env}));
   if(value.ok!==true)throw {status:value.status,stderr:JSON.stringify({Code:value.code})};
   return value;
  }
  return JSON.parse(execFileSync('aliyun',[...params,'--region',config.region,'--connect-timeout','5','--read-timeout','20','--retry-count','0'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe'],env:{...env,ALIBABA_CLOUD_IGNORE_PROFILE:'TRUE',ALIBABA_CLOUD_PROFILE_MODE:'StsToken'}}));
 };
 const report={...runDomainReadAudit(config,call),checkedAt:new Date().toISOString()};
 const envelope=sealReport(report,key,{scope:'DOMAIN_READ_ONLY',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID});
 writeFileSync('v2-domain-audit.sealed.json',JSON.stringify(envelope)+'\n',{mode:0o600});
 process.stdout.write('Encrypted domain audit saved; no certificate material retained.\n');
 if(!report.passed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{domainAuditMain();}catch(error){process.stderr.write((error.safeCode??'DOMAIN_AUDIT_UNCONFIRMED')+'\n');process.exitCode=1;}
}
