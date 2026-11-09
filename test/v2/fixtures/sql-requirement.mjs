import {sqlRequirementBasis} from '../../../src/v2/sql-requirements.mjs';
import {sqlRequirementProtocol} from '../../../src/v2/sql-requirement-contract.mjs';
// Explicitly synthetic response for schema/flow tests, never provider evidence.
export function syntheticSqlRequirement(input,{clarification=false}={}){
 const b=sqlRequirementBasis(input.message,input.context);
 const meanings={client_id:'当前顾问范围内的客户编号',holding_market_value:'去重持仓市值按客户及交易日求和',
  available_cash:'现金独立按客户及交易日聚合',total_assets:'该口径持仓市值与可用现金相加',security_count:'该口径证券代码去重计数'};
 return {requirementProtocol:sqlRequirementProtocol,requirement:clarification?
  {kind:'CLARIFICATION_REQUIRED',basisDigest:b.digest,summary:'所需行业指标不在当前登记范围。',question:'需要先登记行业分类字段，还是先计算当前已登记的五项指标？'}:
  {kind:'DEVELOPMENT',basisDigest:b.digest,summary:'按已登记证券资产口径加工客户日资产，保留现金客户并避免重复累计。',grain:'CLIENT_TRADE_DATE',
   metrics:b.metrics.map(m=>({field:m.field,meaning:meanings[m.field],sourceFields:[...m.sourceFields]})),constraints:[...b.constraints]}};
}
