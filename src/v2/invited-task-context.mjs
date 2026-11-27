import {validationFamilyForContext} from './context.mjs';
import {validStoredAgentDerivation} from './agent-context-derivation.mjs';
import {verifiedStoredCloudDevelopment} from './agent-development-workflow.mjs';
import {storedExecutionStages,checkedLiveExecutionProjection} from './live-lifecycle-execution.mjs';

const taskStatuses=new Set(['QUEUED','RUNNING','SUCCEEDED','FAILED','INTERRUPTED','CANCELLED','VALIDATION_FAILED']);
const stages=new Set([...taskStatuses,'READY_FOR_MODEL','READY_FOR_RUN','WAITING_FOR_RUN','CANCELLING',
  'MODEL_IN_FLIGHT','MODEL_NOT_SENT','MODEL_OUTCOME_UNKNOWN','REQUIREMENT_CLARIFICATION_REQUIRED',
  'REQUIREMENT_EVIDENCE_INVALID','CLARIFICATION_SOURCE_CHANGED','NO_SQL_CHANGE']);
const pending=status=>status==='QUEUED'||status==='RUNNING';
const invalid=()=>Object.assign(Error('原开发任务的登记信息尚未核实'),{status:409,code:'INVITED_TASK_CONTEXT_UNCONFIRMED'});
const missing=()=>Object.assign(Error('没有找到本人在当前项目的原生 SQL 开发任务'),{status:404,code:'INVITED_TASK_CONTEXT_NOT_FOUND'});

// This read deliberately does not call the development run endpoint: that path
// can reconcile outstanding Worker results. SQL and checks are only projected
// from the task's own saved revision and run.
export function invitedTaskContext({store,project,actorId,taskId,requestId}) {
  const read=(kind,id)=>store.get(kind,id,project);
  const task=read('agent',taskId);
  if (!actorId || !task || task.id!==taskId || task.submittedBy!==actorId || task.projectId!==project ||
      task.executionMode!=='DURABLE_SQL_AGENT_V1' || task.language!=='SPARK_SQL' || task.mode!=='LIVE_MODEL' ||
      ![undefined,'AGENT'].includes(task.sourceKind) || task.manualProvenance || task.sourceAttribution || task.syncInput ||
      (requestId!==undefined && store.deduplicatedId(project+':durable-agent:'+actorId+':'+requestId)!==taskId)) throw missing();
  const family=validationFamilyForContext(task.contextId);
  if (!family || !taskStatuses.has(task.status) || !Array.isArray(task.attempts) || task.attempts.length>3 ||
      typeof task.message!=='string' || !task.message.trim() || task.message.length>2000) throw invalid();
  const base={protocol:'shuduo-invited-sql-context/v1',scope:'INVITED_TASK_READ_ONLY',readOnly:true,
    fullLifecycleE2E:false,taskId,contextId:task.contextId,message:task.message,taskStatus:task.status,
    taskStage:stages.has(task.stage)?task.stage:'UNCONFIRMED',attemptCount:task.attempts.length,
    ...(requestId!==undefined?{requestId}:{})};
  const unknown={...base,evidenceState:'UNCONFIRMED',evidenceSource:'UNCONFIRMED'};
  if (!validStoredAgentDerivation(task,read)) return unknown;
  const execution=checkedLiveExecutionProjection(storedExecutionStages(task,read),taskId);
  if (execution.state!=='RECORDED') return unknown;
  const view={...base,evidenceSource:execution.evidence};
  const link=execution.spark;
  if (link.state==='NOT_LINKED')
    return {...view,evidenceState:pending(task.status)&&execution.model.state!=='OUTCOME_UNKNOWN'?'PENDING':'UNCONFIRMED'};
  if (['UNCONFIRMED','SUBMISSION_UNCONFIRMED','RESULT_UNCONFIRMED'].includes(link.state)) return unknown;
  const revision=read('revision',link.revisionId);
  if (!revision || revision.projectId!==project || revision.author!==actorId ||
      revision.id!==link.revisionId || revision.id!==task.revisionId ||
      revision.sql!==task.sql || !revision.sql.trim() || revision.sql.length>20000) return unknown;
  const code={id:revision.id,hash:revision.hash,sql:revision.sql};
  if (link.state==='REVISION_RECORDED') return {...view,revision:code,evidenceState:pending(task.status)?'PENDING':'UNCONFIRMED'};
  const run=read('run',link.runId);
  if (!run || run.id!==link.runId || run.projectId!==project || (task.runId!==undefined && task.runId!==run.id) ||
      run.mode!=='DURABLE_REMOTE_SUBMISSION' || run.isolation!=='FUNCTION_PROCESS' ||
      run.remoteSubmission?.prepared?.job?.jobId!==run.id || !taskStatuses.has(run.status)) return unknown;
  const attempt=task.attempts.at(-1), retained=link.state==='RESULT_RECORDED';
  if (task.status==='SUCCEEDED' && (!retained || run.status!=='SUCCEEDED'||attempt?.status!==run.status)) return unknown;
  if ((task.status==='FAILED' || task.status==='VALIDATION_FAILED') &&
      (!retained || !['FAILED','VALIDATION_FAILED'].includes(run.status) || attempt?.status!==run.status)) return unknown;
  // The runner may have finished before the task has consumed the receipt.
  // Keep the task's own status separate from the run's stored terminal status.
  const seen=new Set();
  const regressions=[];
  for(const item of Array.isArray(run.validation?.regressions)?run.validation.regressions:[]){
    if (!family.contextIds.includes(item?.contextId) || typeof item.passed!=='boolean' || seen.has(item.contextId)) return unknown;
    seen.add(item.contextId);regressions.push({contextId:item.contextId,passed:item.passed});
  }
  let state='UNCONFIRMED';
  if (retained && execution.evidence==='STORED_METADATA') {
    if (verifiedStoredCloudDevelopment(task,revision,run)) state='PASSED';
    else if (run.status==='VALIDATION_FAILED' && run.validation?.passed===false &&
        (run.validation.selectedPassed===false || regressions.some(item=>!item.passed))) state='FAILED';
  }
  return {...view,revision:code,evidenceState:retained?'RECORDED':'PENDING',
    run:{id:run.id,revisionId:revision.id,revisionHash:revision.hash,status:run.status,
      ...(run.engine==='Apache Spark'?{engine:run.engine}:{}),
      ...(typeof run.engineVersion==='string' && /^\d+\.\d+\.\d+$/.test(run.engineVersion)?{engineVersion:run.engineVersion}:{}),
      validation:{state,contractId:family.id,regressions}}};
}
