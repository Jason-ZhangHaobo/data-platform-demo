import {uuid,digest} from './chat-change-resource.mjs';

const requestKey=id=>typeof id==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(id);
const contextKey=id=>typeof id==='string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id);
const stage=value=>typeof value==='string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(value);
const text=(value,limit)=>typeof value==='string' && value.trim().length>0 && value.length<=limit;
const only=(object,fields)=>object!==null && typeof object==='object' && !Array.isArray(object) &&
  Object.keys(object).every(key=>fields.includes(key));
const invalid=()=>Error('原任务的身份、代码版本或已存运行回执未能核对，请重新读取该任务。');

export async function readInvitedSqlContext(client,{taskId,requestId}) {
  if (!uuid(taskId) || (requestId!==undefined && !requestKey(requestId))) throw invalid();
  const query=requestId===undefined?'':'?'+new URLSearchParams({request_id:requestId});
  const value=await client.request('/agent/tasks/'+taskId+'/chat-context'+query);
  if (!only(value,['protocol','scope','taskId','contextId','message','taskStatus','taskStage','attemptCount','evidenceState','evidenceSource',
      'readOnly','fullLifecycleE2E','requestId','revision','run']) ||
      value.protocol!=='shuduo-invited-sql-context/v1' || value.scope!=='INVITED_TASK_READ_ONLY' || value.readOnly!==true ||
      value.fullLifecycleE2E!==false || value.taskId!==taskId || !contextKey(value.contextId) ||
      !text(value.message,2000) || !stage(value.taskStatus) || !stage(value.taskStage) ||
      !Number.isSafeInteger(value.attemptCount) || value.attemptCount<0 ||
      !['PENDING','RECORDED','UNCONFIRMED'].includes(value.evidenceState) ||
      !['STORED_METADATA','TEST_HARNESS','UNCONFIRMED'].includes(value.evidenceSource) ||
      (value.requestId!==undefined && !requestKey(value.requestId)) || (requestId!==undefined && value.requestId!==requestId)) throw invalid();

  const {revision,run}=value;
  if (value.evidenceState==='RECORDED' && (!revision || !run || value.evidenceSource==='UNCONFIRMED')) throw invalid();
  if (revision!==undefined) {
    if (!only(revision,['id','hash','sql']) || !uuid(revision.id) || !digest(revision.hash) || !text(revision.sql,20000)) throw invalid();
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(revision.sql));
    const hash=Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
    if (hash!==revision.hash) throw invalid();
  }
  if (run!==undefined) {
    if (!revision || !only(run,['id','revisionId','revisionHash','status','engine','engineVersion','validation']) || !uuid(run.id) ||
        run.revisionId!==revision.id || run.revisionHash!==revision.hash || !stage(run.status) ||
        (run.engine!==undefined && !text(run.engine,100)) || (run.engineVersion!==undefined && !text(run.engineVersion,100))) throw invalid();
    const v=run.validation;
    if (!only(v,['state','contractId','regressions']) || !['UNCONFIRMED','PASSED','FAILED'].includes(v.state) ||
        !contextKey(v.contractId) || !Array.isArray(v.regressions) ||
        v.regressions.some(c=>!only(c,['contextId','passed'])||!contextKey(c.contextId)||typeof c.passed!=='boolean') ||
        new Set(v.regressions.map(c=>c.contextId)).size!==v.regressions.length) throw invalid();
    if (v.state==='PASSED' && (value.evidenceSource!=='STORED_METADATA' || value.evidenceState!=='RECORDED' ||
        value.taskStatus!=='SUCCEEDED' || run.status!=='SUCCEEDED' || run.engine!=='Apache Spark' ||
        !text(run.engineVersion,100) || !v.regressions.some(c=>c.contextId===value.contextId) ||
        v.regressions.some(c=>!c.passed))) throw invalid();
    if (v.state==='FAILED' && (value.evidenceSource!=='STORED_METADATA' || value.evidenceState!=='RECORDED' ||
        run.status!=='VALIDATION_FAILED')) throw invalid();
  }
  return value;
}
