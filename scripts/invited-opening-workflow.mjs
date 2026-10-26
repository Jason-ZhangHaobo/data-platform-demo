// Protected main-only workflow entry. Owner IAM/Secret activation and cleanup
// remain outside this runner; the returned evidence is encrypted for that owner.
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,openSync,fsyncSync,closeSync,renameSync,appendFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {deploymentInput} from './control-code-transport.mjs';
import {openingScope,publicSitePatch} from './invited-opening-scopes.mjs';
import {createOpeningUsage} from './invited-opening-usage.mjs';
import {runInvitedOpening} from './invited-opening-stage.mjs';
import {readonlyConfigIntegrity} from './invited-readonly-config.mjs';
import {recipientKey,sealReport} from './audit-v2-oidc-readonly.mjs';

const check=(value,code)=>{if(!value)throw Object.assign(new Error(code),{safeCode:code});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const names=['binding','usage','stage','transport','code','entry','code-report','entry-report','stage-report','cleanup-report'];
const reads=new Set(['IDENTITY','BILL_PAGE','FC_READ','DOMAIN_READ','OSS_METADATA','RAM_READ']);

export function openingWorkflowInput(env,now=Date.now(),sealOnly=false){
 check(env.GITHUB_RUN_ATTEMPT==='1'&&/^\d{6,20}$/.test(env.GITHUB_RUN_ID??''),'OPENING_NO_AUTOMATIC_RERUN');
 let metadata;try{metadata=JSON.parse(env.V2_INVITED_OPENING_TARGET);}catch{check(false,'OPENING_TARGET_INVALID');}
 const scope=openingScope(env.V2_READONLY_OPENING_APPROVED,metadata.config?.history);
 const stamp=Date.parse(metadata.authorizedAt);
 check(stamp<=now,'OPENING_START_INVALID');
 const privacyAt=Date.parse(metadata.bucketPrivacy?.checkedAt);
 check(Number.isFinite(privacyAt)&&privacyAt<=now,'OPENING_PRIVACY_TIME_INVALID');
 const mapped={...env,V2_CONTROL_UPDATE_APPROVED:scope.codeAuthorization,V2_CONTROL_UPDATE_TARGET:JSON.stringify(metadata),V2_CONTROL_OPERATOR_SHA:env.V2_OPENING_OPERATOR_SHA};
 // Sealing after expiry performs no cloud operation. Validate the immutable
 // manifest at its real privacy-check instant, not before that check occurred.
 const result=deploymentInput(mapped,sealOnly?Math.max(stamp,privacyAt):now),{config}=result;
 check(/^[a-f0-9]{64}$/.test(metadata.webIndexSha256??'')&&metadata.retainedPlan?.target?.domainName==='shuduoai.cn','OPENING_FROZEN_INPUT_REQUIRED');
 check(metadata.retainedPlan.target.account===config.account&&metadata.retainedPlan.target.role===config.role&&metadata.retainedPlan.target.functionName===config.functionName&&metadata.retainedPlan.target.region===config.region,'OPENING_FROZEN_TARGET_MISMATCH');
 const seed=metadata.openingUsage;
 check(seed&&seed.operationId===config.operationId&&seed.operatorSource===config.operatorSource&&seed.issuedAt===config.issuedAt&&seed.expiresAt===config.expiresAt&&seed.phase==='ACTIVE','OPENING_OWNER_LEDGER_REQUIRED');
 const usage=createOpeningUsage({authorization:scope.authorization,history:config.history,operationId:config.operationId,operatorSource:config.operatorSource,issuedAt:config.issuedAt,expiresAt:config.expiresAt,load:()=>seed,save:()=>{},now:()=>stamp});
 check(usage.counts().configurationReads<=16&&usage.counts().configurationReads>=1&&usage.counts().newRequests===0,'OPENING_PREFLIGHT_TOO_EXPENSIVE');
 check(typeof metadata.publicSite?.icpNumber==='string'&&metadata.publicSite.icpNumber.length<=100&&typeof metadata.publicSite?.registeredName==='string'&&metadata.publicSite.registeredName.length<=100,'OPENING_PUBLIC_SITE_REQUIRED');
 check(metadata.recipientKeySha256===hash(Buffer.from(env.V2_AUDIT_RECIPIENT_KEY??'','base64')),'OPENING_RECIPIENT_CHANGED');
 if(scope.filingRepair){
  publicSitePatch(metadata.publicSite);
  const prior=metadata.priorOpening;
  const predecessorReady=config.readonlyConcurrencyRepair?prior?.codeVerified===true&&prior.entryRetained===true:prior?.codeRestored===true&&(!scope.runtimeVerification||prior.entryRestored===true);
  check(prior?.configurationReads===scope.historicalConfigurationReads&&prior.cumulativeRequests===scope.historicalRequests&&predecessorReady&&prior.permissionRevoked===true&&prior.secretRemoved===true&&/^\d{6,20}$/.test(prior.runId??'')&&/^[a-f0-9]{40}$/.test(prior.sourceRevision??'')&&/^[a-f0-9]{64}$/.test(prior.sealedSha256??''),'OPENING_PRIOR_CLEANUP_REQUIRED');
  if(config.readonlyConcurrencyRepair)check(readonlyConfigIntegrity(metadata.retainedReadonlyChange)&&metadata.retainedReadonlyChange.expectedCode.sha256===config.previous.sha256&&JSON.stringify(metadata.retainedReadonlyChange.publicSite)===JSON.stringify(metadata.publicSite),'OPENING_RETAINED_CONFIG_REQUIRED');
 }
 return{...result,key:recipientKey(env.V2_AUDIT_RECIPIENT_KEY)};
}

export function openingWorkflowStore(directory){
 mkdirSync(directory,{recursive:true,mode:0o700});
 const stat=lstatSync(directory);check(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'OPENING_STORE_NOT_PRIVATE');
 const path=name=>{check(names.includes(name),'OPENING_STORE_NAME_INVALID');return join(directory,`${name}.json`);};
 const regular=file=>{const s=lstatSync(file);check(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'OPENING_CHECKPOINT_NOT_PRIVATE');};
 return{
  load(name){const file=path(name);if(!existsSync(file))return;regular(file);return JSON.parse(readFileSync(file,'utf8'));},
  save(name,value){
   const file=path(name);if(existsSync(file))regular(file);
   const pending=file+'.next';
   // An interrupted pre-rename save is not evidence that its cloud call ran.
   // Refuse the stale temporary file rather than overwrite an unknown outcome.
   const fd=openSync(pending,'wx',0o600);
   try{writeFileSync(fd,JSON.stringify(value)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
   renameSync(pending,file);const parent=openSync(directory,'r');try{fsyncSync(parent);}finally{closeSync(parent);}
  },
 };
}

export function workflowOpeningUsage(usage){
 return{...usage,reserve(name){
  if(reads.has(name)){
   const limit=usage.snapshot().phase==='CLEANUP'?68:53;
   check(usage.counts().configurationReads<limit,'OPENING_OUTER_CLEANUP_RESERVE');
  }
  usage.reserve(name);
 }};
}

export async function openingWorkflowMain(env=process.env,mode=process.argv[2],{directory='.runtime/invited-opening',now=Date.now,run=runInvitedOpening,packagePath='v2-function.zip',sealedPath='v2-invited-opening.sealed.json'}={}){
 check(['--prepare','--run','--cleanup','--seal'].includes(mode),'OPENING_WORKFLOW_MODE_INVALID');
 const {config,metadata,key}=openingWorkflowInput(env,now(),mode==='--seal'),store=openingWorkflowStore(directory);
 const binding={runId:env.GITHUB_RUN_ID,operatorSource:config.operatorSource,operationId:config.operationId,inputHash:hash(env.V2_INVITED_OPENING_TARGET)};
 const prior=store.load('binding');
 if(prior)check(JSON.stringify(prior)===JSON.stringify(binding),'OPENING_WORKFLOW_BINDING_CHANGED');
 else{check(mode==='--prepare','OPENING_PREPARE_REQUIRED');store.save('binding',binding);}
 const usage=createOpeningUsage({authorization:env.V2_READONLY_OPENING_APPROVED,history:config.history,operationId:config.operationId,operatorSource:config.operatorSource,issuedAt:config.issuedAt,expiresAt:config.expiresAt,load:()=>store.load('usage')??metadata.openingUsage,save:value=>store.save('usage',value),now});
 if(mode==='--prepare'){
  check(!prior,'OPENING_PREPARE_ALREADY_RUN');check(env.GITHUB_ENV,'GITHUB_ENV_REQUIRED');
  // One exchange through the already-pinned Action/credentials 2.4.4. Its
  // selected OIDC provider issues one STS request, without a retry loop.
  usage.reserve('IDENTITY');
  for(const value of [config.account,config.role,config.functionName,config.bucket,config.previous.key,config.candidate.key,metadata.roleArn,metadata.providerArn])process.stdout.write(`::add-mask::${value}\n`);
  appendFileSync(env.GITHUB_ENV,`V2_CONTROL_ROLE_ARN=${metadata.roleArn}\nV2_OPENING_PROVIDER_ARN=${metadata.providerArn}\nV2_OPENING_BUILD_RUN=${metadata.buildRunId}\nV2_OPENING_ARTIFACT_ID=${metadata.artifactId}\n`);
  return;
 }
 if(mode==='--seal'){
  const checkpoints=Object.fromEntries(names.map(name=>[name,store.load(name)]));
  writeFileSync(sealedPath,JSON.stringify(sealReport(checkpoints,key,{protocol:'shuduo-invited-opening/v1',sourceRevision:env.GITHUB_SHA,runId:env.GITHUB_RUN_ID}))+'\n',{mode:0o600});return;
 }
 const code=store.load('code'),entry=store.load('entry');
 if(mode==='--cleanup'&&(!code?.updateRequested||code.phase==='ROLLED_BACK'||entry?.phase==='VERIFIED'))return;
 check(mode==='--cleanup'||!store.load('stage'),'OPENING_EXISTING_STAGE_NO_REPLAY');
 check(env.ALIBABA_CLOUD_ACCESS_KEY_ID&&env.ALIBABA_CLOUD_ACCESS_KEY_SECRET&&env.ALIBABA_CLOUD_SECURITY_TOKEN,'OPENING_STS_REQUIRED');
 let bytes;
 if(mode==='--run'){bytes=readFileSync(packagePath);check(bytes.length===config.candidate.bytes&&hash(bytes)===config.candidate.sha256,'OPENING_PACKAGE_CHANGED');}
 const report=await run({config,metadata,retainedPlan:metadata.retainedPlan,webIndexSha256:metadata.webIndexSha256},{env,storage:store,usage:workflowOpeningUsage(usage),now,cleanupOnly:mode==='--cleanup',codeOptions:{candidateBytes:bytes,rollbackFromVerifiedObject:true,saveBackup:value=>{
  const file=join(directory,'rollback.zip');
  if(existsSync(file)){check(hash(readFileSync(file))===config.previous.sha256,'OPENING_BACKUP_CHANGED');return;}
  writeFileSync(file,value,{mode:0o600,flag:'wx'});
 }}});
 if(mode==='--cleanup')store.save('cleanup-report',report);
 check(mode==='--cleanup'||report.executionPassed===true,'OPENING_NOT_VERIFIED');
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await openingWorkflowMain();console.log('Opening step finished; private evidence remains encrypted.');}
 catch(error){console.error(error.safeCode??'OPENING_WORKFLOW_UNCONFIRMED');process.exitCode=1;}
}
