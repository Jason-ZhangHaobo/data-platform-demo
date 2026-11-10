import {randomUUID} from 'node:crypto';
export const sourceReportExecutionMode='SOURCE_BOUND_REPORT_AGENT_V1';
export const sourceReportInitial=(bootId)=>({executionMode:sourceReportExecutionMode,executionBootId:bootId,providerPhase:'NOT_STARTED',usageUnknown:false});
const neverInvoked=p=>p.executionMode===sourceReportExecutionMode&&p.providerPhase==='NOT_STARTED'&&p.providerInvocationId===undefined&&p.usageEstimated!==true&&p.usageUnknown!==true;
export const sourceReportMayStart=(p,bootId)=>neverInvoked(p)&&p.executionBootId===bootId&&p.status==='QUEUED';
export function sourceReportProjection(plan,{bootId,active,now=Date.now()}){
 if(!plan.sourceBinding)return plan;
 const stale=['QUEUED','RUNNING','INTERRUPTED'].includes(plan.status)&&(plan.status==='INTERRUPTED'||!active||plan.executionBootId!==bootId||plan.providerPhase==='STARTED'&&Date.parse(plan.modelLeaseExpiresAt)<=now);
 const unknown=plan.providerPhase==='STARTED'&&(stale||!active||!['QUEUED','RUNNING'].includes(plan.status))||stale&&!neverInvoked(plan);
 const recovery=unknown?{state:'MODEL_RESULT_UNKNOWN',canResume:false,automaticRetry:false}:stale?{state:'RESUMABLE_NOT_STARTED',canResume:true,automaticRetry:false}:undefined;
 return {...plan,...(stale?{status:'INTERRUPTED'}:{}),...(recovery?{recovery}:{}),...(unknown?{usageUnknown:true}:{})};
}
export function sourceReportUsage(generated,reserved){
 const source=generated?.usage??{},usage={};for(const key of ['prompt_tokens','completion_tokens','total_tokens'])if(Number.isSafeInteger(source[key])&&source[key]>=0&&source[key]<=1000000)usage[key]=source[key];
 const total=Math.max(usage.total_tokens??0,(usage.prompt_tokens??0)+(usage.completion_tokens??0));
 return total>0?{model:typeof generated.model==='string'?generated.model:'unconfirmed',usage:{...usage,total_tokens:total},usageEstimated:false,usageUnknown:false}:{model:'unconfirmed',usage:{total_tokens:reserved},usageEstimated:true,usageUnknown:true};
}
export async function runSourceReportPlan({store,project,id,bootId,signal,contextFor,planner,budget,hash,planHash,validate,now=Date.now,timeoutMs=60000}){
 const read=()=>store.get('report_agent_plan',id,project);let p=read();
 if(signal.aborted||!neverInvoked(p)||p.executionBootId!==bootId||p.status!=='RUNNING')return;
 const context=contextFor(p.sourceBinding,p.submittedBy);if(hash(context)!==p.contextHash)throw Object.assign(Error('发布来源变化，未调用模型'),{status:409});
 budget.assertCanStartModel();if(signal.aborted||read().status!=='RUNNING')return;const invocationId=randomUUID(),reserved=budget.fallbackTokens;
 p=store.update('report_agent_plan',id,project,{providerPhase:'STARTED',providerInvocationId:invocationId,modelLeaseExpiresAt:new Date(now()+timeoutMs).toISOString(),model:'unconfirmed',usage:{total_tokens:reserved},usageEstimated:true,usageUnknown:true},{expectedVersion:p.version});
 const owned=q=>q?.executionBootId===bootId&&q.providerInvocationId===invocationId;
 const combined=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);let generated;
 try{
  const aborted=new Promise((_,reject)=>{const stop=()=>reject(Object.assign(Error('模型结果未确认；保留用量预留，不自动重试'),{code:'REPORT_MODEL_RESULT_UNKNOWN'}));if(combined.aborted)stop();else combined.addEventListener('abort',stop,{once:true});});
  generated=await Promise.race([aborted,Promise.resolve().then(()=>{if(combined.aborted)throw Object.assign(Error('模型调用前已取消，预留保留待核对'),{code:'REPORT_MODEL_RESULT_UNKNOWN'});return planner({message:p.message,publication:context,signal:combined,sourceReservation:{taskId:id,invocationId,bootId}});})]);
 }catch(error){if(error.modelResultRecorded&&owned(read())){const current=read();store.update('report_agent_plan',id,project,{providerPhase:'RECORDED',...sourceReportUsage(error,reserved),planningMode:error.mode??'UNCONFIRMED'},{expectedVersion:current.version});}throw error;}
 let current=read();if(!owned(current))return;
 current=store.update('report_agent_plan',id,project,{providerPhase:'RECORDED',...sourceReportUsage(generated,reserved),planningMode:generated.mode??'UNCONFIRMED'},{expectedVersion:current.version});
 if(current.status==='CANCELLED')return;
 if(current.status!=='RUNNING'||combined.aborted)throw Object.assign(Error('模型结果回执已保留，执行状态已变化，未采用方案'),{status:409});
 const latest=contextFor(p.sourceBinding,p.submittedBy);if(hash(latest)!==p.contextHash)throw Object.assign(Error('发布来源已变化，模型用量保留，未采用旧方案'),{status:409});
 const proposal=validate(generated.plan,latest);current=read();if(!owned(current)||current.status!=='RUNNING')return;
 store.update('report_agent_plan',id,project,{status:proposal.kind==='CLARIFICATION_REQUIRED'?'NEEDS_CLARIFICATION':'SUCCEEDED',proposal,proposalHash:planHash(p.sourceBinding,p.contextHash,proposal),explanation:generated.explanation,finishedAt:new Date(now()).toISOString()},{expectedVersion:current.version});
}
