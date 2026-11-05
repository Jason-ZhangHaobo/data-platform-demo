#!/usr/bin/env node
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,unlinkSync,lstatSync,fstatSync,constants} from "node:fs";
import {randomUUID} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {advanceLiveLifecycleCase,refreshLiveLifecycleConsumption,liveLifecyclePlan,liveCaseCheckpoint,summarizeLiveLifecycle,validatedLiveConsumptionSource,liveLifecycleCases,liveLifecycleContract,legacyLiveLifecycleContract,currentLiveLifecycleContract,liveContractById} from "../src/v2/live-lifecycle-evaluation.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const stop=message=>{throw Object.assign(Error(message),{publicMessage:message});};
const safeCode=value=>typeof value==="string"&&/^[A-Z0-9_]{1,80}$/.test(value)?value:undefined;
function loopbackOrigin(value){
 let url;try{url=new URL(value);}catch{stop("本机评测入口必须为固定回环 HTTP 地址");}
 if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=="/"||url.search||url.hash)stop("本机评测入口须为固定回环 HTTP 地址，不接受云端地址或任意路径");
 return url.origin;
}
function directory(path,create=false){
 if(!existsSync(path)){if(!create)stop("找不到原检查点目录，不会新建替代运行");mkdirSync(path,{mode:0o700});}
 const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory())stop("评测目录不允许符号链接或非目录路径");
}
function readCheckpoint(path){
 let fd;
 try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>8*1024*1024)stop("原检查点不是受支持的有界文件");const text=readFileSync(fd,"utf8");return {state:JSON.parse(text),text};}
 catch(error){if(error.publicMessage)throw error;stop("原检查点读取未确认，不新建、不改写原报告");}
 finally{if(fd!==undefined)closeSync(fd);}
}
function checkpointScope(state,runId,env){
 if(!state||state.evaluationRunId!==runId||!Number.isFinite(Date.parse(state.startedAt))||!Number.isSafeInteger(state.caseLimit)||state.caseLimit<1||state.caseLimit>20||!Array.isArray(state.outcomes))stop("原评测编号、案例范围或检查点不合法");
 const contractId=state.contract?.id;if(!liveContractById(contractId))stop("原报告契约未知，不能迁移或当作新契约继续执行");
 const plan=liveLifecyclePlan(state.caseLimit,{contractId}),origin=loopbackOrigin(state.origin);
 if(env.V2_LIVE_EVALUATION_ORIGIN!==undefined&&loopbackOrigin(env.V2_LIVE_EVALUATION_ORIGIN)!==origin||
   env.V2_LIVE_EVALUATION_CASE_LIMIT!==undefined&&Number(env.V2_LIVE_EVALUATION_CASE_LIMIT)!==state.caseLimit||state.caseSetDigest!==plan.caseSetDigest||
   env.V2_LIVE_EVALUATION_CONTRACT!==undefined&&env.V2_LIVE_EVALUATION_CONTRACT!==contractId)stop("恢复范围与原评测的入口、案例数或案例集不一致");
 if(new Set(state.outcomes.map(item=>item?.caseId)).size!==state.outcomes.length||state.outcomes.some(item=>!item||!plan.selectedCases.some(def=>def.id===item.caseId)))stop("原检查点包含重复或范围外案例");
 if(contractId!==legacyLiveLifecycleContract.id&&state.outcomes.some(item=>item.contractId!==contractId))stop("新契约检查点的案例来源不一致，未执行恢复");
 if(contractId===currentLiveLifecycleContract.id&&state.outcomes.some(item=>item.evaluationRunId!==runId))stop('案例不属于原评测运行，不能混用其他运行的成功来源');
 return {plan,origin,contractId};
}
function summaryOf(state,contractId){return summarizeLiveLifecycle(liveLifecycleCases(contractId),state.outcomes,{contractId,testDouble:state.executionEvidenceMode==="TEST_HARNESS"});}
function exactLocalNavigationSource(state,outcomes){
 const definition=liveLifecycleCases(state.contractId??legacyLiveLifecycleContract.id).find(item=>item.id===state.caseId),
  source=definition?validatedLiveConsumptionSource(definition,state,{sourceCheckpoint:outcomes.find(item=>item.caseId===definition.sourceCaseId)}):undefined;
 if(!source||![source.taskId,source.revisionId,source.developmentRunId,source.packageId,source.verificationId,source.releaseId,...source.batches.map(batch=>batch.id)].every(value=>uuid.test(value)))return undefined;
 return source;
}
function links(state,origin,outcomes=[]){
 const taskId=uuid.test(state.taskId??"")?state.taskId:undefined,source=exactLocalNavigationSource(state,outcomes);
 const taskUrl=taskId?origin+"/v2/?module=agent-center&task="+taskId:undefined;
 let servicesUrl,consumptionTarget;
 if(taskId&&source?.taskId===taskId){
  servicesUrl=origin+"/v2/?"+new URLSearchParams({module:"services",source_task:taskId,source_package:source.packageDigest,source_release:source.releaseId,
   source_kind:"AGENT",source_scope:"LOCAL_TEST_ONLY",source_revision:source.revisionId,source_run:source.developmentRunId});
  consumptionTarget={taskId,packageDigest:source.packageDigest,releaseId:source.releaseId,batchIds:source.batches.map(batch=>batch.id)};
 }
 return {taskUrl,servicesUrl,...(servicesUrl?{navigationOnly:true,sourceSelection:"EXACT_LOCAL_RELEASE",
  servicesNotice:"导航定位同一原任务、人工审阅过的包及本机发布版本；页面须实际回读并核对同源后才可操作。链接本身不授权，不自动创建或调用接口。",consumptionTarget}:{})};
}
function report(state,origin,contractId){
 const summary=summaryOf(state,contractId);
 return {...summary,evaluationRunId:state.evaluationRunId,origin,caseLimit:state.caseLimit,caseSetDigest:state.caseSetDigest,
  recorded:true,verificationMode:"RECORDED_CHECKPOINT_ONLY",externalTruthReverified:false,
  waitingConsumptionCount:summary.awaitingConsumptionCaseCount??0,currentContractTargetMet:contractId===currentLiveLifecycleContract.id&&summary.targetMet,
  scopeNotice:contractId===legacyLiveLifecycleContract.id?"旧 v1 记录仅覆盖开发至发布监控，不含消费；不能计作新版含消费达标。未迁移或重跑。":
   contractId===liveLifecycleContract.id?"v2 保留旧20例与含消费范围，不能计作 v3 两族与派生覆盖；本输出只整理原记录。":"v3 包含两组已登记口径、成功来源变更与受治理消费；本输出只整理记录，不重新核验外部真实性。",
  cases:state.outcomes.map(item=>({caseId:item.caseId,status:safeCode(item.status)??"UNRECOGNIZED",phase:safeCode(item.phase)??"UNRECOGNIZED",errorCode:safeCode(item.errorCode),...links(item,origin,state.outcomes)}))};
}
function refreshReadAllowed(path,outcomes){
 if(typeof path!=="string"||/[\\#\s]/.test(path))return false;
 const url=new URL(path,"http://refresh.invalid"),keys=[...url.searchParams.keys()];
 if(url.origin!=="http://refresh.invalid"||url.pathname!=="/data-services/task-evidence"||keys.length!==3||new Set(keys).size!==3||keys.some(key=>!["agent_task_id","package_digest","release_id"].includes(key)))return false;
 return outcomes.some(item=>{const source=item.consumptionSource;return source&&url.searchParams.get("agent_task_id")===source.taskId&&url.searchParams.get("package_digest")===source.packageDigest&&url.searchParams.get("release_id")===source.releaseId;});
}
export function createLiveEvaluationAdapter(origin,{readOnly=false,outcomes=[],signal,fetchImpl=fetch,testDouble=false}={}){
 origin=loopbackOrigin(origin);
 return {...(testDouble?{testDouble:true}:{}),request:async(requestPath,body,key)=>{
  if(readOnly&&(body!==undefined||!refreshReadAllowed(requestPath,outcomes)))throw Object.assign(Error("READ_ONLY_CONSUMPTION_REFRESH_REQUIRED"),{code:"READ_ONLY_CONSUMPTION_REFRESH_REQUIRED"});
  if(typeof requestPath!=="string"||!requestPath.startsWith("/")||requestPath.startsWith("//")||/[\\#\r\n]/.test(requestPath)||!new URL(origin+"/api/v2"+requestPath).pathname.startsWith("/api/v2/"))stop("评测请求路径不在原本机 API 范围");
  let response,value;
  try{response=await fetchImpl(origin+"/api/v2"+requestPath,{method:body===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(60000)]),headers:{"content-type":"application/json","x-shuduo-client":"cli",...(key?{"idempotency-key":key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Object.assign(Error("API_REQUEST_UNCONFIRMED"),{code:"API_REQUEST_UNCONFIRMED"});}
  try{value=await response.json();}catch{throw Object.assign(Error("API_RESPONSE_UNCONFIRMED"),{code:"API_RESPONSE_UNCONFIRMED"});}
  if(!response.ok)throw Object.assign(Error("API_REQUEST_REJECTED"),{code:"API_REQUEST_UNCONFIRMED",status:response.status});return value;
 }};
}

// Injection is for local synthetic tests only. CLI arguments cannot choose an
// artifact path or adapter; production always uses this repository's directory.
export async function runLiveLifecycleCli(args=[],env=process.env,options={}){
 const out=options.output??(value=>process.stdout.write(value+"\n")),err=options.error??(value=>process.stderr.write(value+"\n"));
 const mode=args[0]??"--plan";
 try{
  if(!["--plan","--execute","--resume","--refresh","--report"].includes(mode)||
    (mode==="--plan"?args.length>1:mode==="--execute"?args.length!==1:args.length!==2))stop("使用 --plan、--execute、--resume <原编号>、--refresh <原编号> 或 --report <原编号>");
  if(mode==="--plan"){
   const plan=liveLifecyclePlan(Number(env.V2_LIVE_EVALUATION_CASE_LIMIT??1),{contractId:env.V2_LIVE_EVALUATION_CONTRACT??currentLiveLifecycleContract.id}),origin=loopbackOrigin(env.V2_LIVE_EVALUATION_ORIGIN??"http://127.0.0.1:3100");
   out(JSON.stringify({...plan,selectedCases:plan.selectedCases.map(({id,kind,sourceCaseId,contextId,category,request})=>({id,kind,sourceCaseId,contextId,category,request})),origin},null,2));return 0;
  }
  const runId=mode==="--execute"?(options.runId??randomUUID()):args[1];if(!uuid.test(runId??""))stop("必须提供原评测 UUID，不能使用文件路径");
  const base=options.artifactRoot?resolve(options.artifactRoot):join(root,".v2-artifacts","live-lifecycle");
  if(mode!=="--execute"){if(!options.artifactRoot)directory(dirname(base));directory(base);}
  const runDirectory=join(base,runId),path=join(runDirectory,"checkpoint.json");
  let state,plan,origin,contractId,originalCheckpointText;
  if(mode==="--execute"){
   plan=liveLifecyclePlan(Number(env.V2_LIVE_EVALUATION_CASE_LIMIT??1),{contractId:env.V2_LIVE_EVALUATION_CONTRACT??currentLiveLifecycleContract.id});origin=loopbackOrigin(env.V2_LIVE_EVALUATION_ORIGIN??"http://127.0.0.1:3100");contractId=plan.contract.id;
   if(contractId===legacyLiveLifecycleContract.id)stop('旧 v1 仅保留原报告，不创建新的旧契约运行');
   if(existsSync(runDirectory))stop("新评测编号已经存在，不覆盖原记录");
   state={evaluationRunId:runId,contract:plan.contract,startedAt:new Date().toISOString(),caseSetDigest:plan.caseSetDigest,caseLimit:plan.selectedCases.length,origin,outcomes:[]};
  }else{directory(runDirectory);const snapshot=readCheckpoint(path);state=snapshot.state;originalCheckpointText=snapshot.text;({plan,origin,contractId}=checkpointScope(state,runId,env));}
  if(mode==="--report"){out(JSON.stringify(report(state,origin,contractId),null,2));return 0;}
  if(contractId===legacyLiveLifecycleContract.id){out(JSON.stringify({...report(state,origin,contractId),resumeUnsupported:true,nextAction:"--report "+runId}));return 2;}
  const readOnly=mode==="--refresh",waiting=state.outcomes.filter(item=>item.status==="AWAITING_CONSUMPTION"||item.status==="PAUSED"&&item.phase==="CONSUMPTION");
  if(readOnly&&!waiting.length){out(JSON.stringify({...report(state,origin,contractId),refreshReadOnly:true,refreshedCaseCount:0,notice:"没有已进入消费待核阶段的案例；未执行后续案例，也未改写检查点。"}));return 0;}
  if(!readOnly){
   if(env.V2_LIVE_EVALUATION_AUTHORIZED!=="LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW")stop("请先核实本轮模型／计算次数与预算授权；只查看用 --report，只核对待消费用 --refresh");
   const allowance=Number(env.V2_LIVE_EVALUATION_AUTHORIZED_CASES??0);
   if(!Number.isSafeInteger(allowance)||allowance<state.caseLimit||allowance>20)stop("当前案例数不在已核验授权范围内");
  }
  if(mode==="--execute"){if(!options.artifactRoot)directory(dirname(base),true);directory(base,true);}
  directory(runDirectory,mode==="--execute");
  const save=()=>{
   const value={...state,...summaryOf(state,contractId),updatedAt:new Date().toISOString()},temporary=join(runDirectory,"checkpoint-"+randomUUID()+".tmp");
   let fd;try{fd=openSync(temporary,"wx",0o600);writeFileSync(fd,JSON.stringify(value,null,2)+"\n");closeSync(fd);fd=undefined;renameSync(temporary,path);}
   finally{if(fd!==undefined)closeSync(fd);if(existsSync(temporary))unlinkSync(temporary);}
  };
  const interruption=new AbortController(),onStop=()=>interruption.abort();
  const adapter=createLiveEvaluationAdapter(origin,{readOnly,outcomes:waiting,signal:interruption.signal,fetchImpl:options.fetchImpl??fetch,testDouble:options.testDouble===true});
  const lockPath=join(runDirectory,"runner.lock");let lock;
  try{lock=openSync(lockPath,"wx",0o600);}catch{stop("原评测执行锁尚在；先核实该运行的原进程，不启动第二个执行器");}
  process.once("SIGINT",onStop);process.once("SIGTERM",onStop);
  try{
   writeFileSync(lock,JSON.stringify({pid:process.pid,evaluationRunId:runId})+"\n");
   if(mode!=="--execute"){
    const currentCheckpoint=readCheckpoint(path);
    if(currentCheckpoint.text!==originalCheckpointText)stop("原检查点在取得锁前已变化；未请求服务或覆盖新记录，请读取原报告后再恢复");
    checkpointScope(currentCheckpoint.state,runId,env);
   }
   if(!readOnly){
    const status=await adapter.request("/status");
    if(status.mode!=="LOCAL_DEVELOPMENT"||!status.model?.configured||!status.spark?.available||status.agentDevelopment?.publishAvailable!==true)stop("真实模型、Spark 或本机审阅发布尚未就绪，未提交任务");
    if(status.agentDevelopment.sqlMaxAttempts!==3||!Number.isSafeInteger(status.agentDevelopment.sqlTokenBudget)||status.agentDevelopment.sqlTokenBudget<1||status.agentDevelopment.sqlTokenBudget>32000)stop("当前模型次数或 Token 上限不符合评测计划，未提交任务");
    save();
   }
   let refreshedCaseCount=0,waitingForAction=false;
   const selected=readOnly?plan.selectedCases.filter(def=>waiting.some(item=>item.caseId===def.id)):plan.selectedCases;
   for(const definition of selected){
    if(interruption.signal.aborted){waitingForAction=true;break;}
    let current=state.outcomes.find(item=>item.caseId===definition.id);
    if(!current){if(readOnly)stop("只读刷新不能创建案例");current=liveCaseCheckpoint(definition,state.startedAt,plan.caseSetDigest,{contractId,evaluationRunId:runId});state.outcomes.push(current);save();}
    const progress={sourceCheckpoint:state.outcomes.find(item=>item.caseId===definition.sourceCaseId),save:value=>{state.outcomes=state.outcomes.map(item=>item.caseId===definition.id?value:item);save();}};
    const result=readOnly?await refreshLiveLifecycleConsumption(definition,current,adapter,progress):await advanceLiveLifecycleCase(definition,current,adapter,progress);
    state.outcomes=state.outcomes.map(item=>item.caseId===definition.id?result:item);save();if(readOnly)refreshedCaseCount++;
    out(JSON.stringify({evaluationRunId:runId,contractId,caseId:definition.id,status:safeCode(result.status)??"UNRECOGNIZED",phase:safeCode(result.phase)??"UNRECOGNIZED",errorCode:safeCode(result.errorCode),...links(result,origin,state.outcomes),checkpoint:path,refreshReadOnly:readOnly}));
    if(result.status==='BLOCKED_SOURCE'){waitingForAction=true;continue;}
    if(!["SUCCEEDED","FAILED"].includes(result.status)){waitingForAction=true;if(!readOnly)break;}
   }
   const summary=summaryOf(state,contractId);
   out(JSON.stringify({...summary,evaluationRunId:runId,waitingConsumptionCount:summary.awaitingConsumptionCaseCount??0,refreshReadOnly:readOnly,...(readOnly?{refreshedCaseCount}:{}),externalTruthReverified:false}));
   return waitingForAction?2:readOnly?0:state.caseLimit===20?(summary.targetMet?0:1):(summary.succeededCaseCount===state.caseLimit?0:1);
  }finally{process.off("SIGINT",onStop);process.off("SIGTERM",onStop);closeSync(lock);unlinkSync(lockPath);}
 }catch(error){err(error.publicMessage??(/^[A-Z0-9_]{1,80}$/.test(error.code??"")?error.code:"评测操作未确认；原记录保留，不自动重试"));return 1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await runLiveLifecycleCli(process.argv.slice(2));
