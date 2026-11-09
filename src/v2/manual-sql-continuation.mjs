import {createHash} from 'node:crypto';
import {successfulRegisteredSqlRun} from './sql-success-evidence.mjs';
import {checkedManualContinuationBinding,manualContinuationAttribution} from './manual-continuation-binding.mjs';
import {checkedAssistedDevelopmentReference} from './assisted-development-reference.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const invalid=()=>Object.assign(new Error('手工续改必须引用本人、同项目的保存SQL及完整成功核验，不能替换版本或虚构来源'),{status:403,code:'MANUAL_CONTINUATION_SOURCE_INVALID'});
export function resolveManualContinuation({store,project,actorId,sourceRunId,binding,contextId,currentSql}){
  const selected=binding===undefined?undefined:checkedManualContinuationBinding(binding);
  sourceRunId=selected?.runId??sourceRunId;
  const run=store.get('run',sourceRunId??'',project),revision=store.get('revision',run?.revisionId??'',project),p=revision?.manualProvenance;
  if(!actorId||!run||!revision||run.projectId!==project||revision.projectId!==project||run.testDouble===true||revision.testDouble===true||run.agentTaskId!==undefined||
    revision.source!=='MANUAL'||revision.author!==actorId||p?.kind!=='ENGINEER_EDIT'||p.actorId!==actorId||p.agentIndependentE2E!==false||
    typeof revision.sql!=='string'||hash(revision.sql)!==revision.hash||run.revisionHash!==revision.hash||run.contextId!==revision.contextId||
    contextId!==undefined&&contextId!==revision.contextId||currentSql!==undefined&&currentSql!==revision.sql||!successfulRegisteredSqlRun(run,revision.contextId))throw invalid();
  const origin=p.originAgentTaskId===undefined?undefined:store.get('agent',p.originAgentTaskId,project);
  if(p.originAgentTaskId!==undefined&&(!origin||origin.projectId!==project||origin.submittedBy!==actorId||origin.contextId!==revision.contextId||origin.language!=='SPARK_SQL'))throw invalid();
  const checked=checkedManualContinuationBinding({kind:'MANUAL_SUCCESS_CONTINUATION',revisionId:revision.id,runId:run.id,revisionHash:revision.hash,
    evidenceDigest:hash(JSON.stringify({project,actorId,revision,run,origin})),...(origin?{originAgentTaskId:origin.id}:{})});
  if(selected&&JSON.stringify(selected)!==JSON.stringify(checked))throw Object.assign(new Error('手工版本或成功证据已变化，请重新读取；未启动新计算'),{status:409,code:'MANUAL_CONTINUATION_CHANGED'});
  const reference=checkedAssistedDevelopmentReference({kind:'MANUAL_SUCCESS_REFERENCE',sourceRunId:run.id,sourceRevisionId:revision.id,sourceRevisionHash:revision.hash,initialSqlHash:revision.hash,
    evidenceDigest:checked.evidenceDigest,...(origin?{originAgentTaskId:origin.id}:{})});
  return {protocol:'shuduo-manual-sql-continuation/v1',contextId:revision.contextId,binding:checked,developmentReference:reference,attribution:manualContinuationAttribution(checked,origin?.id)};
}
