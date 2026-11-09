import {createHash} from 'node:crypto';
import {validationFamilyForContext} from './context.mjs';
import {resolveExplicitSqlRepairSource} from './sql-repair-source.mjs';
import {resolveSqlRepairComparison,repairComparisonAttribution,explicitRepairAttribution} from './sql-repair-comparison.mjs';
import {checkedAssistedDevelopmentReference} from './assisted-development-reference.mjs';
import {checkedAssistedContinuationBinding,assistedContinuationAttribution} from './assisted-continuation-binding.mjs';
import {successfulRegisteredSqlRun} from './sql-success-evidence.mjs';
import {resolveManualContinuation} from './manual-sql-continuation.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const invalid=()=>Object.assign(new Error('辅助修正交付必须属于当前工程师、原修正任务及同一已核验版本，参考依据不能替换'),{status:403,code:'ASSISTED_SQL_DELIVERY_SOURCE_INVALID'});
const equal=(a,b)=>{
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)||Array.isArray(b))return false;
  const keys=Object.keys(b);return Object.keys(a).length===keys.length&&keys.every(k=>a[k]===b[k]);
};

// Resolve a model-generated, engineer-assisted revision without relabelling it
// as hand-written SQL. No input from a package, review or client can supply origin.
export function assistedSqlDeliverySource({store,project,run,revision,actorId,seen=new Set()}){
  const provenance=revision?.sourceAttribution,agent=store.get('agent',provenance?.originAgentTaskId??'',project),
    attempt=agent?.attempts?.at(-1),family=validationFamilyForContext(agent?.contextId);
  if(!actorId||!agent||!run||!revision||[agent,run,revision].some(v=>v.projectId!==project||v.testDouble===true)||!family||
    agent.executionMode!=='DURABLE_SQL_AGENT_V1'||agent.language!=='SPARK_SQL'||agent.mode!=='LIVE_MODEL'||agent.status!=='SUCCEEDED'||
    agent.submittedBy!==actorId||revision.author!==actorId||revision.source!=='LIVE_MODEL'||revision.manualProvenance!==undefined||
    agent.sourceKind!=='MANUAL'||agent.agentIndependentE2E!==false||agent.derivedFrom!==undefined||
    agent.revisionId!==revision.id||agent.runId!==run.id||run.agentTaskId!==agent.id||run.revisionId!==revision.id||run.revisionHash!==revision.hash||
    typeof revision.sql!=='string'||hash(revision.sql)!==revision.hash||agent.sql!==revision.sql||typeof agent.initialSql!=='string'||
    revision.contextId!==agent.contextId||run.contextId!==agent.contextId||agent.validationContractId!==family.id||run.validationContractId!==family.id||
    attempt?.status!=='SUCCEEDED'||attempt.revisionId!==revision.id||attempt.runId!==run.id||attempt.computationSkipped===true||attempt.testDouble===true||
    typeof attempt.model!=='string'||!attempt.model||/test.?double|unconfirmed|fixture|stub|synthetic|mock/i.test(attempt.model))throw invalid();
  if(seen.has(agent.id)||seen.size>16)throw invalid();
  const next=new Set([...seen,agent.id]);
  if(agent.manualContinuation!==undefined){
    if(agent.sourceRunId!==undefined||agent.repairComparison!==undefined||agent.assistedContinuation!==undefined)throw invalid();
    const proof=resolveManualContinuation({store,project,actorId,binding:agent.manualContinuation,contextId:agent.contextId,currentSql:agent.initialSql}),generated=repairComparisonAttribution(agent);
    if(!equal(agent.sourceAttribution,proof.attribution.sourceAttribution)||[revision,run].some(v=>v.sourceKind!=='MANUAL'||v.agentIndependentE2E!==false||!equal(v.sourceAttribution,generated.sourceAttribution)))throw invalid();
    return {agent,revision,run,developmentReference:proof.developmentReference};
  }
  if(agent.assistedContinuation!==undefined){
    if(agent.sourceRunId!==undefined||agent.repairComparison!==undefined)throw invalid();
    const proof=resolveAssistedContinuation({store,project,actorId,binding:agent.assistedContinuation,contextId:agent.contextId,currentSql:agent.initialSql,seen:next}),generated=repairComparisonAttribution(agent);
    if(!equal(agent.sourceAttribution,proof.attribution.sourceAttribution)||[revision,run].some(v=>v.sourceKind!=='MANUAL'||v.agentIndependentE2E!==false||!equal(v.sourceAttribution,generated.sourceAttribution)))throw invalid();
    return {agent,revision,run,developmentReference:proof.developmentReference};
  }
  const source=resolveExplicitSqlRepairSource({sourceRunId:agent.sourceRunId,actorId,contextId:agent.contextId,currentSql:agent.initialSql,project,
    read:(kind,id)=>store.get(kind,id,project)});
  const basis=agent.repairComparison===undefined?undefined:resolveSqlRepairComparison({store,project,actorId,sourceRunId:agent.sourceRunId,
    currentSql:agent.initialSql,contextId:agent.contextId,binding:agent.repairComparison});
  const expected=basis?.attribution??explicitRepairAttribution(agent.sourceRunId),generated=repairComparisonAttribution(agent);
  if(!equal(agent.sourceAttribution,expected.sourceAttribution)||[revision,run].some(v=>v.sourceKind!=='MANUAL'||v.agentIndependentE2E!==false||
    !equal(v.sourceAttribution,generated.sourceAttribution)))throw invalid();
  const reference=checkedAssistedDevelopmentReference({kind:basis?'RUN_COMPARISON_REFERENCE':'FAILED_RUN_REFERENCE',sourceRunId:source.run.id,
    sourceRevisionId:source.revision.id,sourceRevisionHash:source.revision.hash,initialSqlHash:hash(agent.initialSql),...(basis?{
      baselineRunId:basis.binding.baselineRunId,baselineRevisionHash:basis.binding.baselineRevisionHash,evidenceDigest:basis.binding.evidenceDigest}:{})});
  return {agent,revision,run,developmentReference:reference};
}

// A new task references an exact successful parent. It inherits genealogy only:
// no approval, package, paid attempt, result row or execution pointer is copied.
export function resolveAssistedContinuation({store,project,actorId,taskId,binding,contextId,currentSql,seen=new Set()}){
  const selected=binding===undefined?undefined:checkedAssistedContinuationBinding(binding);
  taskId=selected?.taskId??taskId;
  const agent=store.get('agent',taskId??'',project),revision=store.get('revision',agent?.revisionId??'',project),run=store.get('run',agent?.runId??'',project);
  if(selected&&(selected.revisionId!==revision?.id||selected.runId!==run?.id||selected.revisionHash!==revision?.hash))throw invalid();
  const parent=assistedSqlDeliverySource({store,project,actorId,run,revision,seen});
  if(contextId!==undefined&&contextId!==agent.contextId||currentSql!==undefined&&currentSql!==revision.sql||!successfulRegisteredSqlRun(run,agent.contextId))throw invalid();
  const depth=parent.developmentReference.kind==='ASSISTED_CONTINUATION'?parent.developmentReference.depth+1:1;
  const checked=checkedAssistedContinuationBinding({kind:'ASSISTED_SUCCESS_CONTINUATION',taskId:agent.id,revisionId:revision.id,runId:run.id,revisionHash:revision.hash,
    evidenceDigest:hash(JSON.stringify({project,actorId,agent,revision,run,reference:parent.developmentReference})),depth});
  if(selected&&JSON.stringify(selected)!==JSON.stringify(checked))throw Object.assign(new Error('父版本或参考证据已变化，请重新读取；未启动新计算'),{status:409,code:'ASSISTED_CONTINUATION_CHANGED'});
  const reference=checkedAssistedDevelopmentReference({kind:'ASSISTED_CONTINUATION',sourceRunId:run.id,sourceRevisionId:revision.id,sourceRevisionHash:revision.hash,initialSqlHash:revision.hash,
    parentTaskId:agent.id,parentEvidenceDigest:checked.evidenceDigest,depth,rootReference:parent.developmentReference.kind==='ASSISTED_CONTINUATION'?parent.developmentReference.rootReference:parent.developmentReference});
  return {protocol:'shuduo-assisted-continuation/v1',contextId:agent.contextId,binding:checked,developmentReference:reference,attribution:assistedContinuationAttribution(checked)};
}
