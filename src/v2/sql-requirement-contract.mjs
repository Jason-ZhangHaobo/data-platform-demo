import {validSqlClarification,clarificationUuid} from './sql-clarification-contract.mjs';
export const sqlRequirementProtocol='shuduo-sql-requirements/v1';
export const sqlRequirementFields=['client_id','holding_market_value','available_cash','total_assets','security_count'];
const record=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n;
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const exact=(v,keys)=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const canonical=value=>JSON.stringify(value,(_k,item)=>record(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
const basisValid=b=>exact(b,['protocol','requestDigest','contextId','contextName','definition','validationContractId','definitionVersion','parameters','grain','tables','metrics','constraints','digest',...(b?.clarificationDigest!==undefined?['clarificationDigest']:[])])&&
 (b.clarificationDigest===undefined||digest(b.clarificationDigest))&&digest(b.digest)&&digest(b.requestDigest)&&b.protocol===sqlRequirementProtocol&&text(b.contextId,80)&&text(b.contextName,200)&&
 text(b.validationContractId,120)&&Number.isSafeInteger(b.definitionVersion)&&b.definitionVersion>0&&b.grain==='CLIENT_TRADE_DATE'&&
 text(b.definition,4000)&&exact(b.parameters,['advisor_id','trade_date'])&&text(b.parameters.advisor_id,100)&&text(b.parameters.trade_date,30)&&
 Array.isArray(b.constraints)&&b.constraints.length>0&&b.constraints.length<=12&&b.constraints.every(v=>text(v,80))&&
 Array.isArray(b.metrics)&&b.metrics.length===5&&new Set(b.metrics.map(m=>m?.field)).size===5&&b.metrics.every(m=>exact(m,['field','label','sourceFields'])&&sqlRequirementFields.includes(m.field)&&text(m.label,200)&&
  Array.isArray(m.sourceFields)&&m.sourceFields.length>0&&m.sourceFields.every(v=>text(v,150)))&&
 Array.isArray(b.tables)&&b.tables.length>0&&b.tables.length<=10&&b.tables.every(t=>exact(t,['name','columns'])&&text(t.name,80)&&Array.isArray(t.columns)&&
  t.columns.length>0&&t.columns.length<=100&&t.columns.every(c=>Array.isArray(c)&&c.length===2&&text(c[0],80)&&text(c[1],100)));

// Structural/schema acknowledgement only. A valid proposal is not proof that
// the generated SQL implements the request; independent execution still decides.
export function validSqlRequirementInterpretation(value,basis){
 if(!basisValid(basis)||!record(value)||value.basisDigest!==basis.digest||!text(value.summary,600))return false;
 if(value.kind==='CLARIFICATION_REQUIRED')return exact(value,['kind','basisDigest','summary','question'])&&text(value.question,300);
 if(!exact(value,['kind','basisDigest','summary','grain','metrics','constraints'])||value.kind!=='DEVELOPMENT'||value.grain!=='CLIENT_TRADE_DATE'||
  !Array.isArray(value.metrics)||value.metrics.length!==5||new Set(value.metrics.map(v=>v?.field)).size!==5||
  !Array.isArray(value.constraints)||value.constraints.length!==basis.constraints.length||new Set(value.constraints).size!==value.constraints.length||
  !basis.constraints.every(id=>value.constraints.includes(id)))return false;
 const columns=new Set(basis.tables.flatMap(t=>t.columns.map(c=>`${t.name}.${c[0]}`)));
 return sqlRequirementFields.every(field=>{
  const metric=value.metrics.find(m=>m?.field===field),required=basis.metrics.find(m=>m.field===field)?.sourceFields;
  return exact(metric,['field','meaning','sourceFields'])&&text(metric.meaning,240)&&Array.isArray(metric.sourceFields)&&
   metric.sourceFields.length>0&&metric.sourceFields.length<=12&&new Set(metric.sourceFields).size===metric.sourceFields.length&&
   metric.sourceFields.every(ref=>columns.has(ref))&&required?.every(ref=>metric.sourceFields.includes(ref));
 });
}

export function sqlRequirementReportMatches(report,task){
 if(!record(report)||report.protocol!==sqlRequirementProtocol||report.taskId!==task.id||report.contextId!==task.contextId||
  report.request!==task.message||!basisValid(report.basis)||report.basis.contextId!==task.contextId||
  !['MODEL_PROPOSED','CLARIFICATION_REQUIRED','INVALID'].includes(report.status)||report.semanticVerification!=='REQUIRES_INDEPENDENT_EXECUTION'||
  !Number.isSafeInteger(report.attempt)||report.attempt<1||!text(report.model,200)||!Array.isArray(task.attempts)||
  !task.attempts.some(a=>a.attempt===report.attempt&&a.model===report.model))return false;
 const keys=['protocol','taskId','request','contextId','basis','attempt','model','semanticVerification','status'];
 if(report.humanClarified===true){
  if(task.humanClarified!==true||report.directAutonomousEligible!==false||!clarificationUuid(report.clarificationOriginTaskId)||report.clarificationOriginTaskId!==task.clarificationOriginTaskId)return false;
  keys.push('humanClarified','directAutonomousEligible','clarificationOriginTaskId');
 }else if(task.humanClarified===true)return false;
 if(report.clarification!==undefined){
  const c=report.clarification;
  if(!validSqlClarification(c)||report.humanClarified!==true||c.originalTaskId!==report.clarificationOriginTaskId||c.contextId!==report.contextId||c.turns.at(-1).answer!==report.request||
   c.turns.some(t=>t.taskId===report.taskId)||report.basis.clarificationDigest!==c.digest||canonical(c)!==canonical(task.clarification))return false;
  keys.push('clarification');
 }else if(report.basis.clarificationDigest!==undefined||task.clarification!==undefined)return false;
 if(!exact(report,[...keys,...(report.status==='INVALID'?['reason']:report.status==='CLARIFICATION_REQUIRED'?['interpretation']:['interpretation','revisionId','sqlHash'])]))return false;
 if(report.status==='INVALID')return report.interpretation===undefined&&typeof report.reason==='string'&&report.reason.length<=300;
 if(!validSqlRequirementInterpretation(report.interpretation,report.basis))return false;
 if(report.status==='CLARIFICATION_REQUIRED')return report.interpretation.kind==='CLARIFICATION_REQUIRED'&&report.revisionId===undefined;
 return report.interpretation.kind==='DEVELOPMENT'&&report.revisionId===task.revisionId&&digest(report.sqlHash)&&
  Array.isArray(task.attempts)&&task.attempts.some(a=>a.attempt===report.attempt&&a.revisionId===report.revisionId&&a.model===report.model);
}
