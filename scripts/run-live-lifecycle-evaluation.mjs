#!/usr/bin/env node
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,openSync,closeSync,unlinkSync} from "node:fs";
import {randomUUID} from "node:crypto";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {advanceLiveLifecycleCase,liveLifecyclePlan,liveCaseCheckpoint,summarizeLiveLifecycle} from "../src/v2/live-lifecycle-evaluation.mjs";
import {m1EvaluationCases} from "../src/v2/evaluation.mjs";

const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),args=process.argv.slice(2),mode=args[0]??"--plan";
if((mode==="--plan"&&args.length>1)||(mode==="--execute"&&args.length!==1)||(mode==="--resume"&&args.length!==2))throw Error("不支持的参数；使用--plan、--execute或--resume <原评测编号>");
const limit=Number(process.env.V2_LIVE_EVALUATION_CASE_LIMIT??1),plan=liveLifecyclePlan(limit);
const url=new URL(process.env.V2_LIVE_EVALUATION_ORIGIN??"http://127.0.0.1:3100");
if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!url.port||url.username||url.password||url.pathname!=="/"||url.search||url.hash)throw Error("本机评测入口须为固定回环HTTP地址；云端评测另行适配");
if(mode==="--plan"){
 process.stdout.write(JSON.stringify({...plan,selectedCases:plan.selectedCases.map(({id,contextId,category,request})=>({id,contextId,category,request})),origin:url.origin},null,2)+"\n");
}else{
 if(!["--execute","--resume"].includes(mode))throw Error("支持--plan、--execute或--resume <原评测编号>");
 if(process.env.V2_LIVE_EVALUATION_AUTHORIZED!=="LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW")throw Error("请先核实本轮模型/计算次数与预算授权；默认只生成计划");
 const allowance=Number(process.env.V2_LIVE_EVALUATION_AUTHORIZED_CASES??0);
 if(!Number.isSafeInteger(allowance)||allowance<limit||allowance>20)throw Error("当前案例数不在已核验授权范围内");
 const runId=mode==="--resume"?args[1]:randomUUID();
 if(!/^[a-f0-9-]{36}$/.test(runId??""))throw Error("恢复时须提供原评测编号");
 const directory=join(root,".v2-artifacts","live-lifecycle",runId),path=join(directory,"checkpoint.json");
 if(mode==="--resume"&&!existsSync(path))throw Error("找不到原检查点，不会新建替代运行");
 let state=mode==="--resume"?JSON.parse(readFileSync(path,"utf8")):{evaluationRunId:runId,startedAt:new Date().toISOString(),caseSetDigest:plan.caseSetDigest,caseLimit:limit,origin:url.origin,outcomes:[]};
 if(state.evaluationRunId!==runId||state.caseLimit!==limit||state.origin!==url.origin||state.caseSetDigest!==plan.caseSetDigest||(mode==="--resume"&&state.contract?.id!==plan.contract.id))throw Error("恢复范围与原评测不一致");
 mkdirSync(directory,{recursive:true,mode:0o700});
 const save=()=>{
  const report={...state,...summarizeLiveLifecycle(m1EvaluationCases(),state.outcomes),updatedAt:new Date().toISOString()};
  writeFileSync(path+".tmp",JSON.stringify(report,null,2)+"\n",{mode:0o600});renameSync(path+".tmp",path);
 };
 const interruption=new AbortController(),onStop=()=>interruption.abort();
 const adapter={request:async(path,body,key)=>{
  let response,value;
  try{response=await fetch(url.origin+"/api/v2"+path,{method:body===undefined?"GET":"POST",redirect:"error",signal:AbortSignal.any([interruption.signal,AbortSignal.timeout(60000)]),headers:{"content-type":"application/json","x-shuduo-client":"cli",...(key?{"idempotency-key":key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw Object.assign(Error("API_REQUEST_UNCONFIRMED"),{code:"API_REQUEST_UNCONFIRMED"});}
  try{value=await response.json();}catch{throw Object.assign(Error("API_RESPONSE_UNCONFIRMED"),{code:"API_RESPONSE_UNCONFIRMED"});}
  if(!response.ok)throw Object.assign(Error("API_REQUEST_REJECTED"),{code:"API_REQUEST_UNCONFIRMED",status:response.status});
  return value;
 }};
 const lockPath=join(directory,"runner.lock");let lock;
 try{lock=openSync(lockPath,"wx",0o600);}catch{throw Error("原评测执行锁尚在；先核实该运行的原进程，不启动第二个执行器");}
 writeFileSync(lock,JSON.stringify({pid:process.pid,evaluationRunId:runId})+"\n");
 process.once("SIGINT",onStop);process.once("SIGTERM",onStop);
 try{
 const status=await adapter.request("/status");
 if(status.mode!=="LOCAL_DEVELOPMENT"||!status.model?.configured||!status.spark?.available||status.agentDevelopment?.publishAvailable!==true)throw Error("真实模型、Spark或本机审阅发布尚未就绪，未提交任务");
 if(status.agentDevelopment.sqlMaxAttempts!==3||!Number.isSafeInteger(status.agentDevelopment.sqlTokenBudget)||status.agentDevelopment.sqlTokenBudget<1||status.agentDevelopment.sqlTokenBudget>32000)throw Error("当前模型次数或Token上限不符合评测计划，未提交任务");
 save();
 for(const definition of plan.selectedCases){
  let current=state.outcomes.find(item=>item.caseId===definition.id);
  if(!current){current=liveCaseCheckpoint(definition,state.startedAt,plan.caseSetDigest);state.outcomes.push(current);save();}
  const result=await advanceLiveLifecycleCase(definition,current,adapter,{save:value=>{state.outcomes=state.outcomes.map(item=>item.caseId===definition.id?value:item);save();}});
  state.outcomes=state.outcomes.map(item=>item.caseId===definition.id?result:item);save();
  const taskUrl=result.taskId?`${url.origin}/v2/?module=agent-center&task=${result.taskId}`:undefined;
  process.stdout.write(JSON.stringify({evaluationRunId:runId,caseId:definition.id,status:result.status,phase:result.phase,errorCode:result.errorCode,taskUrl,checkpoint:path})+"\n");
  if(!["SUCCEEDED","FAILED"].includes(result.status)){process.exitCode=2;break;}
 }
 if(process.exitCode!==2){
  const summary=summarizeLiveLifecycle(m1EvaluationCases(),state.outcomes);
  process.exitCode=limit===20?(summary.targetMet?0:1):(summary.succeededCaseCount===limit?0:1);
 }
 }finally{process.off("SIGINT",onStop);process.off("SIGTERM",onStop);closeSync(lock);unlinkSync(lockPath);}
}
