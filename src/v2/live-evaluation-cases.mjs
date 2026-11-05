import {isDeepStrictEqual} from 'node:util';
import {m1EvaluationCases} from './evaluation.mjs';

// A separate immutable catalog: changing live coverage never rewrites M1 or
// the v1/v2 case identities, seeds, hashes and historical denominator.
export const liveContextCaseSetId='securities-live-contexts-and-derivations-20-v1';
const assetContexts=Object.freeze(['holdings-t1','cash-change','duplicate-position','equal-value-positions','cash-only-client']);
const fixedContexts=Object.freeze([...assetContexts,'stock-cash-t1','stock-cash-cash-change','stock-cash-duplicate-position','stock-cash-equal-value-positions','stock-cash-cash-only-client']);
export function liveContextEvaluationCases(){
 const legacy=m1EvaluationCases(),base=fixedContexts.map((contextId,index)=>{
  const sourceContext=assetContexts[index%assetContexts.length],pattern=legacy.filter(item=>item.contextId===sourceContext)[index%4];
  const stock=contextId.startsWith('stock-cash-');
  return {id:`v3-fresh--${contextId}`,kind:'FRESH',contextId,category:`FRESH_${pattern.category}`,
   request:pattern.request+(stock?' 本任务仅加工股票持仓＋可用现金：只统计股票，结果不等于客户全资产。':' 按已登记的全品类持仓＋可用现金口径执行。'),seedSql:pattern.seedSql};
 });
 const derived=base.map((source,index)=>{
  const contextId=fixedContexts[(index+assetContexts.length)%fixedContexts.length],stock=contextId.startsWith('stock-cash-'),
   name=stock?'股票持仓＋可用现金（非客户全资产）':'客户全品类持仓＋可用现金';
  return {id:`v3-change--${source.contextId}--${contextId}`,kind:'DERIVED',sourceCaseId:source.id,contextId,category:'REGISTERED_CONTEXT_CHANGE',
   request:`基于原成功版本改为“${name}”口径。${stock?'仅统计股票持仓，结果不能称为客户全资产。':'统计所选数据的全品类持仓与可用现金。'}现金独立聚合，持仓按position_id去重，证券数量按代码去重，保留仅有现金客户；重新执行所选口径的五场景核验。`};
 });
 return [...base,...derived];
}
export function validateLiveContextEvaluationCases(cases){
 if(!isDeepStrictEqual(cases,liveContextEvaluationCases()))throw Object.assign(Error('LIVE_CASE_SET_INVALID'),{code:'LIVE_CASE_SET_INVALID'});
 return true;
}
