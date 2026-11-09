import {createHash} from 'node:crypto';
import {compareSqlRuns} from './run-comparison.mjs';
import {resolveExplicitSqlRepairSource} from './sql-repair-source.mjs';
import {validationFamilyForContext} from './context.mjs';

const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const fail=(message,status=409)=>Object.assign(new Error(message),{status,code:'AGENT_REPAIR_COMPARISON_INVALID'});
export function validateRepairComparisonBinding(value){
  const keys=['baselineRunId','currentRevisionHash','baselineRevisionHash','evidenceDigest'];
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))||
    !uuid(value.baselineRunId)||!keys.slice(1).every(k=>digest(value[k])))throw fail('修正对照须绑定基线、双方代码摘要与证据摘要',422);
  return Object.fromEntries(keys.map(k=>[k,value[k]]));
}
const assisted=value=>({sourceKind:'MANUAL',sourceAttribution:{kind:'ENGINEER_ASSISTED',referenceKind:'RUN_COMPARISON_REFERENCE',...value,agentIndependentE2E:false},agentIndependentE2E:false});
export const repairComparisonAttribution=task=>task.repairComparison||task.sourceAttribution?.kind==='ENGINEER_ASSISTED'?{
  ...assisted({originAgentTaskId:task.id,actorId:task.submittedBy,sourceRunId:task.sourceRunId,...(task.repairComparison?{baselineRunId:task.repairComparison.baselineRunId,evidenceDigest:task.repairComparison.evidenceDigest}:{})}),
  ...(!task.repairComparison?{sourceAttribution:{...task.sourceAttribution,originAgentTaskId:task.id,actorId:task.submittedBy}}:{})}:{};
export const explicitRepairAttribution=sourceRunId=>({sourceKind:'MANUAL',sourceAttribution:{kind:'ENGINEER_ASSISTED',referenceKind:'FAILED_RUN_REFERENCE',sourceRunId,agentIndependentE2E:false},agentIndependentE2E:false});
const view=value=>value?{...(value.target?{target:value.target}:{}),...(value.kind?{kind:value.kind}:{}),status:value.status,
  sources:value.sources.map(({table,column})=>({table,column})),...(value.joinType?{joinType:value.joinType}:{})}:undefined;
const changes=value=>({state:value.state,totalChanges:value.changes.length,truncated:value.changes.length>80,changes:value.changes.slice(0,80).map(c=>({kind:c.kind,...(c.before?{before:view(c.before)}:{}),...(c.after?{after:view(c.after)}:{})}))});

// Only saved records are read. No baseline SQL, expressions, rows, expected values
// or free-form diagnostics are ever returned as comparison model context.
export function resolveSqlRepairComparison({store,project,actorId,sourceRunId,baselineRunId,currentSql,contextId,binding}){
  if(binding!==undefined){binding=validateRepairComparisonBinding(binding);baselineRunId=binding.baselineRunId;}
  if(!uuid(baselineRunId)||baselineRunId===sourceRunId)throw fail('请选择另一条已核验成功的同口径基线');
  const read=(kind,id)=>store.get(kind,id,project),source=resolveExplicitSqlRepairSource({sourceRunId,actorId,contextId,currentSql,project,read}),
    baseline=read('run',baselineRunId),revision=baseline&&read('revision',baseline.revisionId);
  if(currentSql!==source.revision.sql||!baseline||!revision||baseline.projectId!==project||revision.projectId!==project||revision.author!==actorId||
    baseline.contextId!==contextId||revision.contextId!==contextId||baseline.testDouble===true||revision.testDouble===true||baseline.status!=='SUCCEEDED'||baseline.engine!=='Apache Spark'||
    baseline.mainSqlExecuted!==true||revision.hash!==baseline.revisionHash||typeof revision.sql!=='string'||hash(revision.sql)!==revision.hash)throw fail('原代码、基线归属或成功核验未确认');
  let origin;
  if(revision.source==='MANUAL'){
    if(baseline.agentTaskId!==undefined||revision.manualProvenance?.kind!=='ENGINEER_EDIT'||revision.manualProvenance.actorId!==actorId||revision.manualProvenance.agentIndependentE2E!==false)throw fail('手工基线缺少当前工程师的来源记录');
  }else if(revision.source==='LIVE_MODEL'){
    origin=read('agent',baseline.agentTaskId);
    if(!origin||origin.projectId!==project||origin.submittedBy!==actorId||origin.contextId!==contextId||origin.language!=='SPARK_SQL'||origin.testDouble===true||
      !origin.attempts?.some(a=>a.runId===baseline.id&&a.revisionId===revision.id))throw fail('基线 Agent 来源关联未确认');
  }else throw fail('基线来源未确认');
  const report=compareSqlRuns({store,project,current:source.run,baseline});
  if(report.current.binding!=='VERIFIED'||report.baseline.binding!=='VERIFIED'||report.baseline.validation.state!=='PASSED'||report.baseline.testSql.state!=='PASSED')throw fail('基线独立场景或测试文件未通过');
  // Bind all saved evidence, not just visible labels. Even changed private assertion
  // data or provenance invalidates the frozen handoff before another paid step.
  const checked={baselineRunId,currentRevisionHash:source.revision.hash,baselineRevisionHash:revision.hash,
    evidenceDigest:hash({project,actorId,source,baseline,revision,origin,sourceOrigin:source.run.agentTaskId?read('agent',source.run.agentTaskId):undefined})};
  if(binding&&JSON.stringify(binding)!==JSON.stringify(checked))throw fail('对照证据已变化，请重读原运行；未启动新的计算');
  const summary={protocol:'shuduo-sql-repair-comparison/v1',contextId,sourceRunId,...checked,
    sourceOrigins:{current:source.revision.source,baseline:revision.source},inputs:report.inputs.state,assertions:report.assertions.state,engineSame:report.engineSame,
    valueSources:changes(report.valueSources),conditionReferences:changes(report.conditionReferences),
    caseComparison:{state:report.caseComparison.state,changes:report.caseComparison.changes.map(({contextId,beforePassed,afterPassed})=>({contextId,beforePassed,afterPassed}))},
    causalConclusion:'NOT_ESTABLISHED',referenceOnly:true,agentIndependentE2E:false};
  return {protocol:'shuduo-sql-repair-basis/v1',sourceRunId,contextId,binding:checked,summary,
    attribution:assisted({sourceRunId,baselineRunId,evidenceDigest:checked.evidenceDigest})};
}

// Defensive projection at the model boundary. The backend recomputes the basis;
// user-supplied summaries are not accepted by task creation.
export function safeRepairComparisonSummary(value,context,currentSql){
  if(value===undefined)return undefined;
  if(value?.protocol!=='shuduo-sql-repair-comparison/v1'||value.contextId!==context.id||value.currentRevisionHash!==hash(currentSql)||
    !uuid(value.sourceRunId)||!uuid(value.baselineRunId)||!digest(value.baselineRevisionHash)||!digest(value.evidenceDigest)||value.causalConclusion!=='NOT_ESTABLISHED'||
    value.referenceOnly!==true||value.agentIndependentE2E!==false)throw fail('模型对照上下文与原代码未绑定');
  const allowed=new Set(context.tables.flatMap(t=>t.columns.map(c=>t.name+'.'+c[0]))),ident=v=>typeof v==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,99}$/.test(v),
    states=['COMPARED','PARTIAL','UNAVAILABLE'],kinds=['ADDED','REMOVED','CHANGED','EVIDENCE_CHANGED'];
  const side=v=>{
    if(!v||!Array.isArray(v.sources)||v.sources.length>100||!['RESOLVED','UNRESOLVED','CONSTANT','NO_COLUMN_REFERENCE'].includes(v.status)||
      v.target!==undefined&&!ident(v.target)||v.kind!==undefined&&!['JOIN_ON','JOIN','WHERE','GROUP_BY','HAVING','DISTINCT'].includes(v.kind)||
      v.joinType!==undefined&&!['INNER','LEFT','RIGHT','FULL','CROSS','SEMI','ANTI','LEFT_SEMI','LEFT_ANTI','UNKNOWN'].includes(v.joinType)||v.sources.some(s=>!allowed.has(s?.table+'.'+s?.column)))throw fail('模型对照引用未通过白名单核对');
    return view(v);
  };
  const delta=v=>{
    if(!v||!states.includes(v.state)||!Array.isArray(v.changes)||v.changes.length>80||!Number.isSafeInteger(v.totalChanges)||v.totalChanges<v.changes.length||v.totalChanges>10000||v.truncated!==(v.totalChanges>v.changes.length))throw fail('模型对照差异格式无效');
    return {state:v.state,totalChanges:v.totalChanges,truncated:v.truncated,changes:v.changes.map(c=>{if(!kinds.includes(c.kind))throw fail('模型对照差异格式无效');return{kind:c.kind,...(c.before?{before:side(c.before)}:{}),...(c.after?{after:side(c.after)}:{})};})};
  };
  if(!['SAME','DIFFERENT','UNCONFIRMED','DIFFERENT_CONTEXT'].includes(value.inputs)||!['SAME','DIFFERENT','UNCONFIRMED'].includes(value.assertions)||typeof value.engineSame!=='boolean'||
    !['MANUAL','LIVE_MODEL'].includes(value.sourceOrigins?.current)||!['MANUAL','LIVE_MODEL'].includes(value.sourceOrigins?.baseline)||
    !['CONTROLLED_OBSERVATION','NOT_CONTROLLED'].includes(value.caseComparison?.state)||!Array.isArray(value.caseComparison.changes)||value.caseComparison.changes.length>5||
    value.caseComparison.changes.some(c=>!validationFamilyForContext(context.id)?.contextIds.includes(c.contextId)||typeof c.beforePassed!=='boolean'||typeof c.afterPassed!=='boolean'||c.beforePassed===c.afterPassed)||
    value.caseComparison.state==='NOT_CONTROLLED'&&value.caseComparison.changes.length||
    value.caseComparison.state==='CONTROLLED_OBSERVATION'&&(value.inputs!=='SAME'||value.assertions!=='SAME'||!value.engineSame))throw fail('模型对照观察条件未确认');
  return {protocol:value.protocol,contextId:value.contextId,sourceRunId:value.sourceRunId,baselineRunId:value.baselineRunId,currentRevisionHash:value.currentRevisionHash,
    baselineRevisionHash:value.baselineRevisionHash,evidenceDigest:value.evidenceDigest,sourceOrigins:{current:value.sourceOrigins.current,baseline:value.sourceOrigins.baseline},
    inputs:value.inputs,assertions:value.assertions,engineSame:value.engineSame,valueSources:delta(value.valueSources),conditionReferences:delta(value.conditionReferences),
    caseComparison:{state:value.caseComparison.state,changes:value.caseComparison.changes.map(({contextId,beforePassed,afterPassed})=>({contextId,beforePassed,afterPassed}))},causalConclusion:'NOT_ESTABLISHED',referenceOnly:true,agentIndependentE2E:false};
}
