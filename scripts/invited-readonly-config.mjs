// Pure, narrowly scoped configuration diff. No credential loading, network,
// IAM, DNS/certificate operations, automatic deployment or approval inference.
import { createHash } from 'node:crypto';
import { codeUpdateBoundaryHash, codeUpdateProbes, INVITED_READONLY_CODE_SCOPE } from './control-code-update.mjs';
import { domainConfigurationMatches } from './v2-domain-binding-plan.mjs';
const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value??null);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const stateHash=state=>hash({protected:codeUpdateBoundaryHash(state),checksum:String(state.function?.codeChecksum),bytes:Number(state.function?.codeSize),extra:Object.fromEntries(['customDNS','disableOndemand','instanceLifecycleConfig','invocationRestriction'].map(k=>[k,state.function?.[k]??null]))});
const same=(a,b)=>canonical(a)===canonical(b);

export function prepareInvitedReadonlyConfig({state,domain,retainedPlan,operationId,expectedCode,privateCodeEvidence}){
 check(/^[a-f0-9]{32}$/.test(operationId??''),'READONLY_OPERATION_INVALID');
 check(retainedPlan?.target?.domainName==='shuduoai.cn'&&domainConfigurationMatches(domain,retainedPlan),'RETAINED_SIGNED_DOMAIN_NOT_VERIFIED');
 const fn=state?.function,env=fn?.environmentVariables;
 const report=privateCodeEvidence?.report,cp=privateCodeEvidence?.checkpoint,receipt=cp?.candidateReceipt;
 // Call only with evidence from the authenticated/decrypted original envelope.
 // Old code does not implement the read-only flag: setting that flag alone is
 // never a safe way to open the prior application version.
 check(/^[a-f0-9]{40}$/.test(expectedCode?.applicationSource??'')&&/^[a-f0-9]{64}$/.test(expectedCode?.sha256??'')&&Number.isSafeInteger(expectedCode?.bytes),'READONLY_EXPECTED_CODE_INVALID');
 check(report?.passed===true&&report.operationId===operationId&&report.scope==='PRIVATE_CONTROL_CODE_ONLY'&&report.requestScope===INVITED_READONLY_CODE_SCOPE&&report.applicationSource===expectedCode.applicationSource&&report.newInvocations===6&&report.cumulativeInvocations===61&&report.publicEnabled===false&&report.modelCalls===0&&report.sparkRuns===0,'READONLY_PRIVATE_CODE_EVIDENCE_REQUIRED');
 check(cp?.phase==='VERIFIED'&&cp.operationId===operationId&&cp.candidateSha===expectedCode.sha256&&receipt?.sha256===expectedCode.sha256&&receipt.bytes===expectedCode.bytes&&/^\d{1,30}$/.test(receipt.crc64??'')&&String(fn?.codeChecksum)===receipt.crc64&&fn.codeSize===receipt.bytes&&same(cp.probes,codeUpdateProbes.map(p=>({id:p.id,passed:true}))),'READONLY_DEPLOYED_CODE_NOT_VERIFIED');
 check(fn?.functionName===retainedPlan.target.functionName&&fn.runtime==='custom.debian12'&&fn.instanceConcurrency===1&&fn.cpu===0.25&&fn.memorySize===512,'READONLY_FUNCTION_BOUNDARY_MISMATCH');
 check(env?.V2_LOCAL_DEVELOPMENT==='false'&&env.V2_PROVISIONING_ONLY==='true'&&env.V2_PRIVATE_SMOKE_ENABLED==='true'&&env.V2_FC_PUBLIC_HTTP_ENABLED!=='true','READONLY_PRIVATE_BASELINE_REQUIRED');
 check(Array.isArray(state.triggers)&&state.triggers.length===2&&state.triggers.every(t=>t.triggerType==='oss')&&state.concurrency?.reservedConcurrency===1&&state.scaling?.minInstances===0,'READONLY_RESOURCE_BOUNDARY_MISMATCH');
 check(/^\d{1,30}$/.test(String(fn.codeChecksum))&&Number.isSafeInteger(fn.codeSize)&&fn.codeSize>0,'READONLY_CODE_IDENTITY_REQUIRED');
 const origin='https://shuduoai.cn';
 const functionBody={environmentVariables:{...env,V2_FC_PUBLIC_HTTP_ENABLED:'true',V2_FC_PUBLIC_READ_ONLY:'true',V2_PUBLIC_URL:`${origin}/v2/`,V2_PUBLIC_ORIGIN:origin}};
 const triggerBody={triggerName:'shuduo-invited-readonly',triggerType:'http',qualifier:'LATEST',description:`shuduo-readonly-${operationId}`,triggerConfig:JSON.stringify({authType:'anonymous',disableURLInternet:true,methods:['GET','POST']})};
 const expectedState={...structuredClone(state),function:{...structuredClone(fn),...functionBody}};
 const change={
  operationId,expectedCode:structuredClone(expectedCode),retainedPlan:structuredClone(retainedPlan),baselineHash:stateHash(state),openedHash:stateHash(expectedState),originalTriggers:structuredClone(state.triggers),
  // Request bodies contain the pre-existing environment. Only use them in
  // memory/protected encrypted checkpoints, never public summaries or Git.
  functionBody,domainBody:{authConfig:{authType:'anonymous',authInfo:'{}'}},triggerBody,
  rollbackFunctionBody:{environmentVariables:structuredClone(env)},rollbackDomainBody:{authConfig:{authType:'function',authInfo:'{}'}},
  summary:{scope:'INVITED_READONLY_CONFIG_PREPARATION',changedEnvironmentKeys:['V2_FC_PUBLIC_HTTP_ENABLED','V2_FC_PUBLIC_READ_ONLY','V2_PUBLIC_URL','V2_PUBLIC_ORIGIN'],dnsChanges:0,certificateChanges:0,capacityChanges:0,originalTriggerChanges:0,newHttpTriggers:1,modelCalls:0,sparkRuns:0,applied:false},
 };
 return{...change,changeHash:hash(change)};
}

function ownedHttpTrigger(value,expected){
 if(!value||!['triggerName','triggerType','qualifier','description'].every(k=>value[k]===expected[k]))return false;
 if(value.invocationRole||value.sourceArn)return false;
 let config;try{config=typeof value.triggerConfig==='string'?JSON.parse(value.triggerConfig):value.triggerConfig;}catch{return false;}
 if(!config||Object.keys(config).some(k=>!['authType','disableURLInternet','methods','authConfig'].includes(k)))return false;
 return config.authType==='anonymous'&&config.disableURLInternet===true&&Array.isArray(config.methods)&&same([...config.methods].sort(),['GET','POST'])&&[undefined,null,'','{}'].includes(config.authConfig);
}

export function verifyInvitedReadonlyConfig(change,{state,domain}){
 if(!change||typeof change!=='object')return false;
 const {changeHash,...definition}=change;
 if(hash(definition)!==changeHash)return false;
 if(!Array.isArray(state?.triggers))return false;
 const own=state.triggers.filter(t=>t.triggerName===change.triggerBody.triggerName);
 if(own.length!==1||!ownedHttpTrigger(own[0],change.triggerBody))return false;
 const original=state.triggers.filter(t=>t.triggerName!==change.triggerBody.triggerName);
 if(!same([...original].sort((a,b)=>a.triggerName.localeCompare(b.triggerName)),[...change.originalTriggers].sort((a,b)=>a.triggerName.localeCompare(b.triggerName))))return false;
 if(stateHash({...state,triggers:original})!==change.openedHash)return false;
 if(domain?.authConfig?.authType!=='anonymous'||![undefined,null,'','{}'].includes(domain.authConfig.authInfo)||Object.keys(domain.authConfig).some(k=>!['authType','authInfo'].includes(k)))return false;
 // Reuse the already-tested certificate/TLS/route/ownership checks. Only the
 // authentication mode is intentionally different from the retained binding.
 return domainConfigurationMatches({...domain,authConfig:{authType:'function',authInfo:'{}'}},change.retainedPlan);
}

export function readonlyEntryRollbackRequests(change,current){
 // For a fully applied, owned entry only. Partial or unknown outcomes must be
 // reconciled first; this function must not guess what was created/modified.
 check(verifyInvitedReadonlyConfig(change,current),'READONLY_ENTRY_DRIFT_DO_NOT_OVERWRITE');
 return{closeFunction:structuredClone(change.rollbackFunctionBody),restoreDomain:structuredClone(change.rollbackDomainBody),deleteTrigger:change.triggerBody.triggerName};
}
