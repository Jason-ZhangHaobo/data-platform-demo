import {createHash} from 'node:crypto';
import {validationFamilyForContext} from './context.mjs';
import {sqlRequirementProtocol,sqlRequirementFields,validSqlRequirementInterpretation,sqlRequirementReportMatches} from './sql-requirement-contract.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

export function sqlRequirementBasis(message,context){
 const family=validationFamilyForContext(context.id);
 if(!family)throw Error('SQL_REQUIREMENT_CONTEXT_UNREGISTERED');
 const sources={client_id:['accounts.client_id'],holding_market_value:['positions.position_id','positions.market_value'],
  available_cash:['cash.available_cash'],total_assets:['positions.market_value','cash.available_cash'],security_count:['positions.security_code']};
 const value={protocol:sqlRequirementProtocol,requestDigest:hash(message),contextId:context.id,contextName:context.name,
  definition:context.definition,validationContractId:family.id,definitionVersion:family.definitionVersion,
  parameters:{advisor_id:context.advisorId,trade_date:context.businessDate},grain:'CLIENT_TRADE_DATE',
  tables:context.tables.map(({name,columns})=>({name,columns:columns.map(c=>[...c])})),
  metrics:sqlRequirementFields.map(field=>({field,label:family.metricLabels[field],sourceFields:sources[field]})),
  constraints:['SCOPED_CLIENTS','POSITION_ID_DEDUP','SEPARATE_CASH_AGGREGATION','INCLUDE_CASH_ONLY_CLIENTS','NULL_MONEY_AS_ZERO','DECIMAL_MONEY',
   ...(family.id==='securities-stock-cash-five-fixtures-v1'?['STOCK_POSITIONS_ONLY']:[])]};
 return {...value,digest:hash(value)};
}

export function sqlRequirementReport({task,message,context,generated,attempt}){
 if(generated?.requirementProtocol===undefined)return undefined; // Never invent historical understanding.
 const basis=sqlRequirementBasis(message,context),valid=generated.requirementProtocol===sqlRequirementProtocol&&
  validSqlRequirementInterpretation(generated.requirement,basis);
 return {protocol:sqlRequirementProtocol,taskId:task.id,request:message,contextId:context.id,basis,attempt,
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
  (report.status!=='MODEL_PROPOSED'||report.sqlHash===(revisionHash??(typeof task.sql==='string'?hash(task.sql):undefined)));
}
