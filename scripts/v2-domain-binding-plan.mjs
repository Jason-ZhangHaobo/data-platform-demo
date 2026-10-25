// Side-effect-free plan and adapter-driven state machine. No cloud transport,
// credential loading or automatic invocation is installed by importing this file.
import {createHash,X509Certificate,createPrivateKey,createPublicKey} from 'node:crypto';
import {auditConfig} from './audit-v2-oidc-readonly.mjs';

const fail=code=>Object.assign(new Error(code),{safeCode:code});
const check=(value,code)=>{if(!value)throw fail(code);};
const canonical=value=>JSON.stringify(value&&typeof value==='object'
  ?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v)))
    :Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value??null);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
export const DOMAIN_BINDING_AUTHORIZATION='ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED';
export const P0B_SIGNED_ACCESS_AUTHORIZATION='P0B_SIGNED_HTTPS_17_PLUS_23';
export const P0B_SIGNED_RESUME_AUTHORIZATION='P0B_SIGNED_HTTPS_RESUME_32_PLUS_23';
export const P0B_DOMAIN_REMAINING_AUTHORIZATION='P0B_SIGNED_DOMAIN_47_PLUS_8';
export function signedAccessLimits(authorization){
  if(authorization===P0B_SIGNED_ACCESS_AUTHORIZATION)return{historical:17,defaultNew:15,defaultMax:32,totalMax:40,unsettledReservedCny:4,resume:false};
  if(authorization===P0B_SIGNED_RESUME_AUTHORIZATION)return{historical:32,defaultNew:15,defaultMax:47,totalMax:55,unsettledReservedCny:6,resume:true};
  if(authorization===P0B_DOMAIN_REMAINING_AUTHORIZATION)return{historical:47,defaultNew:0,defaultMax:47,totalMax:55,unsettledReservedCny:8,resume:true,reuseDefault:true};
}
// Call only after authenticating/decrypting the original evidence envelope.
// A failed first batch is not permission to retry; this validates provenance
// and counters for the separately approved, exactly-once continuation.
export function verifySignedHttpsResume(prior,expected,authorization=P0B_SIGNED_RESUME_AUTHORIZATION){
  check([P0B_SIGNED_RESUME_AUTHORIZATION,P0B_DOMAIN_REMAINING_AUTHORIZATION].includes(authorization),'HTTPS_PRIOR_SCOPE_INVALID');
  const remaining=authorization===P0B_DOMAIN_REMAINING_AUTHORIZATION,history=remaining?32:17,total=history+15;
  check(/^[a-f0-9]{32}$/.test(expected?.operationId??'')&&[expected?.desiredHash,expected?.httpTargetHash].every(v=>/^[a-f0-9]{64}$/.test(v??''))
    &&/^shuduo-http-boundary-\d{1,20}$/.test(expected?.triggerName??''),'HTTPS_PRIOR_EXPECTATION_INVALID');
  check(prior?.scope==='SIGNED_HTTPS_DOMAIN_BINDING'&&prior.passed===false
    &&prior.operationId===expected.operationId&&prior.targetHash===expected.desiredHash,'HTTPS_PRIOR_TARGET_MISMATCH');
  const b=prior.boundary,c=prior.httpCheckpoint,d=prior.domain,dc=prior.domainCheckpoint;
  check(c?.targetHash===expected.httpTargetHash&&c.triggerName===expected.triggerName
    &&c.requests===total&&/^[a-f0-9]{64}$/.test(c.functionHash??'')&&/^[a-f0-9]{64}$/.test(c.originalTriggersHash??''),'HTTPS_PRIOR_CHECKPOINT_MISMATCH');
  check(b?.passed===true&&b.priorRequests===history&&b.requests===total&&b.newRequests===15
    &&b.modelCalls===0&&b.sparkRuns===0&&b.publicApplicationEnabled===false
    &&b.cleanup?.deferredForSameDomainBatch===true&&Array.isArray(b.results)&&b.results.length===14
    &&new Set(b.results.map(v=>v.id)).size===14,'HTTPS_PRIOR_BOUNDARY_MISMATCH');
  check(canonical(prior.requestBudget)===canonical({historical:history,defaultNewLimit:15,domainNewLimit:8,cumulativeLimit:total+8})
    &&prior.domainRequests===0&&prior.cumulativeRequests===total,'HTTPS_PRIOR_USAGE_MISMATCH');
  if(remaining)check(d?.createResponse?.status===400&&d.createResponse.code==='InvalidArgument'&&d.createResponse.category==='INVALID_CIPHER_SUITES','HTTPS_PRIOR_REJECTION_MISMATCH');
  check(d?.passed===false&&d.createRequests===1&&d.failure===(remaining?'DOMAIN_CREATE_REJECTED':'DOMAIN_CREATE_NOT_CONFIRMED')
    &&d.modelCalls===0&&d.sparkRuns===0&&d.publicApplicationEnabled===false
    &&d.rollback?.domainAbsent===true&&d.rollback.deleted===false&&Array.isArray(d.probes)&&d.probes.length===0
    &&dc?.phase==='ROLLED_BACK'&&dc.baselineAbsent===true&&dc.operationId===prior.operationId
    &&dc.desiredHash===prior.targetHash&&dc.domainName==='shuduoai.cn','HTTPS_PRIOR_DOMAIN_NOT_ABSENT');
  check(prior.cleanup?.triggerAbsent===true&&prior.cleanup.originalTriggersUnchanged===true
    &&prior.cleanup.functionUnchanged===true&&prior.cleanup.domainRollback?.domainAbsent===true
    &&prior.cleanup.domainRollback.deleted===false&&!prior.cleanup.domainRollbackFailure,'HTTPS_PRIOR_CLEANUP_UNCONFIRMED');
  const counts=prior.domainApiCounts;
  check(Number.isInteger(counts?.get)&&counts.get>=3&&counts.get<=10&&counts.create===1&&counts.delete===0,'HTTPS_PRIOR_METADATA_MISMATCH');
  return{priorRequests:total,priorFunctionHash:c.functionHash,priorOriginalTriggersHash:c.originalTriggersHash};
}
// FC's configurable cipherSuites enum is separate from its TLS 1.3 support.
// Keep TLS 1.3 enabled through maxVersion, but do not put TLS_AES_* (TLS 1.3)
// names into this list: the official fc3-domain ITLSConfig enum excludes them.
// https://github.com/devsapp/fc3-domain/blob/48f49d18eb809959e63b29f7906f5d32761066bc/src/schema.json
// Never fall back to "all suites", which includes weak legacy algorithms.
export const DOMAIN_TLS_CIPHER_SUITES=Object.freeze([
  'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
]);

export function verifyCertificateMaterial({certificate,privateKey},now=Date.now()){
  try{
    check(typeof certificate==='string'&&Buffer.byteLength(certificate)<=20480,'CERTIFICATE_SIZE_INVALID');
    check(typeof privateKey==='string'&&Buffer.byteLength(privateKey)<=4096,'PRIVATE_KEY_SIZE_INVALID');
    const leaf=new X509Certificate(certificate),key=createPrivateKey(privateKey);
    check(leaf.checkHost('shuduoai.cn')==='shuduoai.cn'&&leaf.subjectAltName==='DNS:shuduoai.cn','CERTIFICATE_DOMAIN_MISMATCH');
    check(Date.parse(leaf.validFrom)<=now&&Date.parse(leaf.validTo)>now+86400000,'CERTIFICATE_NOT_CURRENT');
    check(leaf.publicKey.export({type:'spki',format:'der'}).equals(createPublicKey(key).export({type:'spki',format:'der'})),'CERTIFICATE_KEY_MISMATCH');
    return{leafSha256:createHash('sha256').update(leaf.raw).digest('hex'),validTo:new Date(leaf.validTo).toISOString(),domain:'shuduoai.cn'};
  }catch(error){throw fail(error.safeCode??'CERTIFICATE_MATERIAL_INVALID');}
}

export function domainBindingPlan(input,now=Date.now()){
  const stage=signedAccessLimits(input?.authorization),p0b=Boolean(stage);
  check(input?.authorization===DOMAIN_BINDING_AUTHORIZATION||p0b,'DOMAIN_BINDING_NOT_AUTHORIZED');
  check(input.domainName==='shuduoai.cn','DOMAIN_TARGET_INVALID');
  check(/^[a-f0-9]{32}$/.test(input.operationId??''),'DOMAIN_OPERATION_ID_INVALID');
  const expiresAt=Date.parse(input.expiresAt);
  check(Number.isFinite(expiresAt)&&expiresAt-now>=600000&&expiresAt-now<=3600000,'DOMAIN_AUTHORIZATION_WINDOW_INVALID');
  check(/^[a-f0-9]{40}$/.test(input.sourceRevision??''),'DOMAIN_SOURCE_INVALID');
  const target=auditConfig({V2_DEPLOY_ROLE_ARN:input.roleArn,V2_DEPLOY_OIDC_PROVIDER_ARN:input.providerArn,V2_FUNCTION_NAME:input.functionName,ALIBABA_CLOUD_REGION_ID:input.region});
  check(/^[a-f0-9]{64}$/.test(input.certificate?.leafSha256??'')&&input.certificate.domain===input.domainName&&Date.parse(input.certificate.validTo)>expiresAt,'DOMAIN_CERTIFICATE_EVIDENCE_INVALID');
  const routes=[{path:'/',methods:['GET']},{path:'/v2/*',methods:['GET']},{path:'/api/v2/*',methods:['GET','POST']}]
    .map(route=>({...route,functionName:target.functionName,qualifier:'LATEST'}));
  const desired={domainName:input.domainName,protocol:'HTTPS',authConfig:{authType:'function',authInfo:'{}'},
    tlsConfig:{minVersion:'TLSv1.2',maxVersion:'TLSv1.3',cipherSuites:[...DOMAIN_TLS_CIPHER_SUITES]},routeConfig:{routes},
    certName:`shuduo-bind-${input.operationId}`,certificateSha256:input.certificate.leafSha256};
  return{version:1,requestScope:input.authorization,operationId:input.operationId,sourceRevision:input.sourceRevision,expiresAt:input.expiresAt,
    target:{...target,domainName:input.domainName},desired,desiredHash:digest(desired),
    dns:{rr:'@',type:'CNAME',value:`${target.account}.${target.region}.fc.aliyuncs.com`,ttl:600},
    limits:{newDomainCreates:1,newBusinessDnsRecords:1,domainProbes:p0b?8:20,reservedCny:p0b?2:1,monthlyCny:200,...(p0b?{historicalRequests:stage.historical,defaultNewRequests:stage.defaultNew,allRequests:stage.totalMax,domainMetadataReads:10}: {})},
    publicApplicationEnabled:false,automaticRenewalConfigured:false};
}

export function domainTemporaryStatements(plan){
  const condition={DateLessThan:{'acs:CurrentTime':plan.expiresAt}};
  return[
    {Effect:'Allow',Action:['fc:GetCustomDomain','fc:CreateCustomDomain','fc:InvokeFunction','fc:DeleteTrigger'],Resource:'*',Condition:condition},
    {Effect:'Allow',Action:['fc:DeleteCustomDomain'],Resource:`acs:fc:${plan.target.region}:${plan.target.account}:custom-domains/${plan.target.domainName}`,Condition:condition},
  ];
}

function projection(value){
  // Never retain a returned privateKey, raw certificate, auth tokens or response.
  let certificateSha256;
  try{certificateSha256=createHash('sha256').update(new X509Certificate(value?.certConfig?.certificate).raw).digest('hex');}catch{}
  return{domainName:value?.domainName,protocol:value?.protocol,
    authConfig:value?.authConfig,tlsConfig:value?.tlsConfig,routeConfig:value?.routeConfig,
    certName:value?.certConfig?.certName,certificateSha256};
}

export function domainConfigurationMatches(value,plan){
  if(String(value?.accountId)!==plan.target.account)return false;
  // Server-added defaults are allowed only when they do not relax the policy.
  const actual=projection(value),expected=plan.desired;
  return actual.domainName===expected.domainName&&actual.protocol==='HTTPS'
    &&actual.authConfig?.authType==='function'&&(!actual.authConfig.authInfo||actual.authConfig.authInfo==='{}')
    &&actual.tlsConfig?.minVersion==='TLSv1.2'&&actual.tlsConfig.maxVersion==='TLSv1.3'
    &&Array.isArray(actual.tlsConfig.cipherSuites)&&Array.isArray(expected.tlsConfig.cipherSuites)
    &&canonical([...actual.tlsConfig.cipherSuites].sort())===canonical([...expected.tlsConfig.cipherSuites].sort())
    &&canonical(actual.routeConfig)===canonical(expected.routeConfig)
    &&actual.certName===expected.certName&&actual.certificateSha256===expected.certificateSha256
    &&(!value.wafConfig||value.wafConfig.enableWAF===false)
    &&(!value.corsConfig||canonical(value.corsConfig)==='{}');
}

const absent=value=>value?.status===404&&value?.code==='DomainNameNotFound';
const present=value=>value?.status===200&&value?.value&&typeof value.value==='object';
function validateCheckpoint(plan,checkpoint){
  check(checkpoint?.operationId===plan.operationId&&checkpoint.desiredHash===plan.desiredHash
    &&checkpoint.domainName===plan.target.domainName&&checkpoint.baselineAbsent===true,'DOMAIN_CHECKPOINT_MISMATCH');
}

export async function rollbackDomainBinding(plan,adapter,checkpoint,{save}={}){
  validateCheckpoint(plan,checkpoint);
  check(typeof save==='function','DOMAIN_DURABLE_CHECKPOINT_REQUIRED');
  const current=await adapter.get();
  if(absent(current)){checkpoint.phase='ROLLED_BACK';await save(checkpoint);return{domainAbsent:true,deleted:false};}
  check(present(current)&&domainConfigurationMatches(current.value,plan),'DOMAIN_DRIFT_DO_NOT_DELETE');
  // Unknown delete outcome is read back once, never blindly repeated on resume.
  if(!checkpoint.deleteRequested){
    checkpoint.deleteRequested=true;await save(checkpoint);
    try{await adapter.delete();}catch{checkpoint.deleteResponseUnknown=true;await save(checkpoint);}
  }
  check(absent(await adapter.get()),'DOMAIN_ROLLBACK_NOT_CONFIRMED');
  checkpoint.phase='ROLLED_BACK';await save(checkpoint);
  return{domainAbsent:true,deleted:true};
}

export async function runDomainBinding(plan,material,adapter,{load,save,now=Date.now}={}){
  check(typeof load==='function'&&typeof save==='function','DOMAIN_DURABLE_CHECKPOINT_REQUIRED');
  let checkpoint=await load();
  const report={scope:'SIGNED_HTTPS_DOMAIN_BINDING',passed:false,createRequests:0,publicApplicationEnabled:false,modelCalls:0,sparkRuns:0};
  try{
    check(plan?.version===1&&plan.desiredHash===digest(plan.desired),'DOMAIN_PLAN_INVALID');
    const probeLimit=signedAccessLimits(plan.requestScope)?8:20;
    check(plan.limits?.domainProbes===probeLimit,'DOMAIN_PROBE_SCOPE_CHANGED');
    check(verifyCertificateMaterial(material,now()).leafSha256===plan.desired.certificateSha256,'DOMAIN_CERTIFICATE_CHANGED');
    if(checkpoint){
      validateCheckpoint(plan,checkpoint);report.recoveryOnly=true;
      if(checkpoint.phase==='VERIFIED_RETAINED'){
        const retained=await adapter.get();
        check(present(retained)&&domainConfigurationMatches(retained.value,plan),'RETAINED_DOMAIN_NOT_CONFIRMED');
        // Do not claim acceptance or re-run probes from a prior retained receipt.
        report.retainedPreviously=true;return report;
      }
      report.rollback=await rollbackDomainBinding(plan,adapter,checkpoint,{save});return report;
    }
    check(Date.parse(plan.expiresAt)-now()>=300000,'DOMAIN_WINDOW_TOO_SHORT');
    const readiness=await adapter.preflight();
    check(readiness?.defaultBoundaryVerified===true&&readiness.publicApplicationEnabled===false
      &&readiness.sameSignedTriggerPresent===true&&readiness.functionUnchanged===true
      &&readiness.budgetVerified===true&&readiness.dnsExact===true,'DOMAIN_PREFLIGHT_NOT_VERIFIED');
    check(absent(await adapter.get()),'DOMAIN_ALREADY_PRESENT_OR_UNCONFIRMED');
    checkpoint={operationId:plan.operationId,desiredHash:plan.desiredHash,domainName:plan.target.domainName,baselineAbsent:true,phase:'CREATE_REQUESTED',startedAt:now()};
    await save(checkpoint);
    check(Date.parse(plan.expiresAt)-now()>=300000,'DOMAIN_WINDOW_TOO_SHORT');
    report.createRequests=1;
    const body={domainName:plan.desired.domainName,protocol:plan.desired.protocol,authConfig:plan.desired.authConfig,
      tlsConfig:plan.desired.tlsConfig,routeConfig:plan.desired.routeConfig,
      certConfig:{certName:plan.desired.certName,certificate:material.certificate,privateKey:material.privateKey}};
    try{
      const response=await adapter.create(body);
      // The transport already excludes PEM and error messages. Project again
      // here so even a faulty adapter cannot persist credentials in evidence.
      report.createResponse={status:Number.isInteger(response?.status)&&response.status>=100&&response.status<=599?response.status:0,
        code:typeof response?.code==='string'&&/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(response.code)?response.code:'UNCONFIRMED',
        category:response?.category==='INVALID_CIPHER_SUITES'?'INVALID_CIPHER_SUITES':'UNCLASSIFIED'};
    }catch{checkpoint.createResponseUnknown=true;await save(checkpoint);}
    const current=await adapter.get();
    if(absent(current)&&report.createResponse?.status>=400)throw fail('DOMAIN_CREATE_REJECTED');
    check(present(current)&&domainConfigurationMatches(current.value,plan),'DOMAIN_CREATE_NOT_CONFIRMED');
    checkpoint.phase='CREATED_VERIFIED';await save(checkpoint);
    const acceptance=await adapter.verifyDomain(plan.limits.domainProbes);
    check(acceptance?.tlsVerified===true&&acceptance.boundaryVerified===true&&acceptance.privateOperationExposed===false
      &&Number.isSafeInteger(acceptance.requests)&&acceptance.requests>0&&acceptance.requests<=probeLimit,'DOMAIN_ACCEPTANCE_NOT_VERIFIED');
    // Detect external changes before retaining an object created by this run.
    const latest=await adapter.get();
    check(present(latest)&&domainConfigurationMatches(latest.value,plan),'DOMAIN_CHANGED_DURING_ACCEPTANCE');
    checkpoint.phase='VERIFIED_RETAINED';await save(checkpoint);
    report.passed=true;report.domainRequests=acceptance.requests;report.domainRetained=true;
  }catch(error){
    report.failure=error.safeCode??'DOMAIN_OPERATION_UNCONFIRMED';
    if(checkpoint&&checkpoint.phase!=='VERIFIED_RETAINED'){try{report.rollback=await rollbackDomainBinding(plan,adapter,checkpoint,{save});}catch(cleanup){report.cleanupFailure=cleanup.safeCode??'DOMAIN_ROLLBACK_UNCONFIRMED';}}
  }
  return report;
}
