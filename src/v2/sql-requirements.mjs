import {fundRequirementScope} from "./fund-requirement-contract.mjs";
import {distributionMetadataForContext} from './output-contract-metadata.mjs';
import {createHash} from 'node:crypto';
import {getContext,validationFamilyForContext} from './context.mjs';
import {sqlRequirementProtocol,sqlRequirementFields,validSqlRequirementInterpretation,sqlRequirementReportMatches} from './sql-requirement-contract.mjs';
import {verifiedSqlClarification} from './sql-clarification-snapshot.mjs';
import {clarificationAttribution} from './sql-clarification-contract.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>canonical(a)===canonical(b);
const fail=()=>Object.assign(Error('需求理解、原任务、代码与不可变交付依据不一致；请重新核验确切版本'),{status:409,code:'REQUIREMENT_DELIVERY_SOURCE_CHANGED'});
const reportKeys=['protocol','taskId','request','contextId','basis','attempt','model','semanticVerification','status','interpretation','revisionId','sqlHash'];

export function sqlRequirementBasis(message,context,clarification){
 const family=validationFamilyForContext(context.id);
 if(!family)throw Error('SQL_REQUIREMENT_CONTEXT_UNREGISTERED');
 const fund=fundRequirementScope(context.id), distributed=fund??distributionMetadataForContext(context.id);
 const sources={client_id:['accounts.client_id'],holding_market_value:['positions.position_id','positions.market_value'],
  available_cash:['cash.available_cash'],total_assets:['positions.market_value','cash.available_cash'],security_count:['positions.security_code']};
 const value={protocol:sqlRequirementProtocol,requestDigest:hash(message),contextId:context.id,contextName:context.name,
  definition:context.definition,validationContractId:family.id,definitionVersion:family.definitionVersion,
  parameters:{...(fund?{manager_id:context.managerId}:{advisor_id:context.advisorId}),trade_date:context.businessDate},grain:distributed?.grain??'CLIENT_TRADE_DATE',
  tables:context.tables.map(({name,columns})=>({name,columns:columns.map(c=>[...c])})),
  metrics:distributed?.metrics??sqlRequirementFields.map(field=>({field,label:family.metricLabels[field],sourceFields:sources[field]})),
  constraints:distributed?.constraints??['SCOPED_CLIENTS','POSITION_ID_DEDUP','SEPARATE_CASH_AGGREGATION','INCLUDE_CASH_ONLY_CLIENTS','NULL_MONEY_AS_ZERO','DECIMAL_MONEY',
   ...(family.id==='securities-stock-cash-five-fixtures-v1'?['STOCK_POSITIONS_ONLY']:[])]};
 if(clarification!==undefined){if(!verifiedSqlClarification(clarification,{message,contextId:context.id}))throw fail();value.clarificationDigest=clarification.digest;}
 return {...value,digest:hash(value)};
}

export function sqlRequirementReport({task,message,context,generated,attempt}){
 if(generated?.requirementProtocol===undefined&&task.clarification===undefined&&task.humanClarified!==true&&!context.outputContractId)return undefined; // Never invent historical understanding.
 const basis=sqlRequirementBasis(message,context,task.clarification),valid=generated.requirementProtocol===sqlRequirementProtocol&&
  validSqlRequirementInterpretation(generated.requirement,basis);
 return {protocol:sqlRequirementProtocol,taskId:task.id,request:message,contextId:context.id,basis,attempt,
  ...clarificationAttribution(task),...(task.clarification?{clarification:structuredClone(task.clarification)}:{}),
  model:typeof generated.model==='string'?generated.model:'unconfirmed',semanticVerification:'REQUIRES_INDEPENDENT_EXECUTION',
  status:!valid?'INVALID':generated.requirement.kind==='CLARIFICATION_REQUIRED'?'CLARIFICATION_REQUIRED':'MODEL_PROPOSED',
  ...(valid?{interpretation:structuredClone(generated.requirement)}:{reason:'模型需求理解未绑定当前口径，或字段／粒度／约束不完整；未提交计算。'})};
}
export function bindSqlRequirementRevision(report,revision){
 return report?{...report,revisionId:revision.id,sqlHash:revision.hash}:undefined;
}
export function verifiedSqlRequirementReport(report,task,{revisionHash}={}){
 if(!sqlRequirementReportMatches(report,task))return false;
 const {digest,...basis}=report.basis;
 return digest===hash(basis)&&basis.requestDigest===hash(task.message)&&
  (report.clarification===undefined||verifiedSqlClarification(report.clarification,task))&&
  (report.status!=='MODEL_PROPOSED'||report.sqlHash===(revisionHash??(typeof task.sql==='string'?hash(task.sql):undefined)));
}
export function sqlRequirementBinding(report){
 return {protocol:sqlRequirementProtocol,taskId:report.taskId,basisDigest:report.basis.digest,reportDigest:hash(canonical(report))};
}
export function verifiedSqlRequirementForRevision(report,task,revision){
 return Boolean(revision&&verifiedSqlRequirementReport(report,task)&&report.status==='MODEL_PROPOSED'&&
  report.revisionId===revision.id&&report.sqlHash===revision.hash&&
  (revision.requirementBinding===undefined||same(revision.requirementBinding,sqlRequirementBinding(report))));
}
// Only a checked original model task can supply evidence. Handwritten code and
// historical packages do not inherit an explanation from an unrelated Agent.
export function frozenSqlRequirements({agent,run,revision}){
 if(agent?.requirements===undefined&&revision?.requirementBinding===undefined)return undefined;
 const report=agent?.requirements,last=agent?.attempts?.at(-1);
 if(!agent||!run||!revision||revision.source!=='LIVE_MODEL'||agent.language!=='SPARK_SQL'||agent.status!=='SUCCEEDED'||agent.mode!=='LIVE_MODEL'||
  agent.contextId!==revision.contextId||agent.projectId!==run.projectId||revision.projectId!==run.projectId||
  typeof agent.submittedBy!=='string'||!agent.submittedBy||agent.submittedBy!==revision.author||run.agentTaskId!==agent.id||last?.status!=='SUCCEEDED'||
  last.runId!==run.id||last.revisionId!==revision.id||report?.attempt!==agent.attempts.length||
  !verifiedSqlRequirementForRevision(report,agent,revision))throw fail();
 const basis=sqlRequirementBasis(agent.message,getContext(revision.contextId),agent.clarification);
 if(!same(report.basis,basis))throw fail();
 const frozen={protocol:report.protocol,taskId:agent.id,request:agent.message,contextId:revision.contextId,basis,
  ...clarificationAttribution(agent),...(agent.clarification?{clarification:structuredClone(agent.clarification)}:{}),
  attempt:report.attempt,model:report.model,semanticVerification:report.semanticVerification,status:report.status,
  interpretation:structuredClone(report.interpretation),revisionId:revision.id,sqlHash:revision.hash};
 if(!same(frozen,report))throw fail(); // Do not archive arbitrary extra provider/debug fields.
 return frozen;
}
export function validateFrozenSqlRequirements(report,binding,source,sql){
 if(report===undefined&&binding===undefined)return undefined;
 const expectedKeys=['protocol','taskId','basisDigest','reportDigest'];
 if(!binding||typeof binding!=='object'||Array.isArray(binding)||Object.keys(binding).length!==expectedKeys.length||
  expectedKeys.some(k=>!Object.hasOwn(binding,k))||!report||report.status!=='MODEL_PROPOSED'||
  Object.keys(report).length!==reportKeys.length+(report.humanClarified===true?3:0)+(report.clarification!==undefined?1:0)||reportKeys.some(k=>!Object.hasOwn(report,k))||
  !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.taskId??'')||typeof report.request!=='string'||!report.request.trim()||report.request.length>2000||report.attempt>3||
  report.contextId!==source.contextId||report.revisionId!==source.revisionId||report.sqlHash!==source.sqlHash||
  source.attribution?.kind==='ENGINEER_AUTHORED'||source.attribution&&source.attribution.originAgentTaskId!==report.taskId)throw fail();
 const task={id:binding.taskId,message:report.request,contextId:source.contextId,revisionId:source.revisionId,sql,
  ...clarificationAttribution(report),...(report.clarification?{clarification:report.clarification}:{}),
  attempts:[{attempt:report.attempt,model:report.model,revisionId:source.revisionId}]};
 if(!verifiedSqlRequirementReport(report,task)||!same(binding,sqlRequirementBinding(report))||
  !same(report.basis,sqlRequirementBasis(report.request,getContext(source.contextId),report.clarification)))throw fail();
 return report;
}
export function assertSqlRequirementPackageSource(bundle,{agent,run,revision}){
 if(!bundle?.manifest)throw fail();
 const frozen=frozenSqlRequirements({agent,run,revision}),binding=frozen?sqlRequirementBinding(frozen):undefined;
 if(!same(bundle.manifest?.source?.requirement,binding))throw fail();
 return frozen;
}
