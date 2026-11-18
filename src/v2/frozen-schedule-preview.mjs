import {resolveDeliverySchedule} from './delivery.mjs';
const bad=message=>Object.assign(Error(message),{status:422,code:'SCHEDULE_PREVIEW_INVALID'});
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
// Call only after the saved package, digest and source access have been checked.
export function frozenSchedulePreview(bundle,plan,scheduledFor){
 if(scheduledFor!==undefined&&typeof scheduledFor!=='string')throw bad('计划时点必须是北京时间字符串');
 const {calendar,schedule,fixtures,deployment}=plan,businessDate=fixtures.context.businessDate;
 if(!validDate(businessDate))throw bad('冻结输入的业务日期无效');
 const index=calendar.tradingDays.indexOf(businessDate),next=index<0?undefined:calendar.tradingDays[index+1];
 const suggestedFor=next?`${next}T${schedule.at}+08:00`:null;
 const selected=scheduledFor===undefined?suggestedFor:scheduledFor;
 let result;
 if(selected===null)result={status:'COVERAGE_INSUFFICIENT',scheduledFor:null,businessDate:null,matchesFrozenInput:false,reason:'冻结业务日或下一交易日不在原包日历内，不能推断计划日期'};
 else{
  if(typeof selected!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(selected)||!validDate(selected.slice(0,10))||selected.slice(11,19)!==schedule.at)throw bad('请使用原包调度时刻及北京时间，例如2026-09-11T09:00:00+08:00');
  const day=selected.slice(0,10),dayIndex=calendar.tradingDays.indexOf(day);
  if(day<calendar.range.start||day>calendar.range.end)result={status:'OUT_OF_RANGE',scheduledFor:selected,businessDate:null,matchesFrozenInput:false,reason:'日期超出原包日历覆盖，不能改用当前登记日历推断'};
  else if(dayIndex===0)result={status:'PREVIOUS_TRADING_DAY_MISSING',scheduledFor:selected,businessDate:null,matchesFrozenInput:false,reason:'原包缺少前一交易日，T+1业务日期不可核验'};
  else{
   const occurrence=resolveDeliverySchedule(plan,selected),matches=occurrence.businessDate===businessDate;
   result={status:!occurrence.eligible?'NON_TRADING_DAY':matches?'MATCHES_FROZEN_INPUT':'BUSINESS_DATE_MISMATCH',scheduledFor:selected,businessDate:occurrence.businessDate??null,matchesFrozenInput:Boolean(occurrence.eligible&&matches),reason:!occurrence.eligible?'当天不是原包中的交易日':matches?'计划日期对应原冻结输入；仍须独立演练、人审及发布授权':'该计划会对应另一业务日；当前冻结数据不适用于此日期'};
  }
 }
 return {protocol:'shuduo-frozen-schedule-preview/v1',readOnly:true,binding:{packageId:bundle.id,packageDigest:bundle.digest,revisionId:plan.source.revisionId,runId:plan.source.runId},
  calendar:{schema:calendar.schema,kind:calendar.kind,timezone:calendar.timezone,range:{...calendar.range},tradingDayCount:calendar.tradingDays.length,notice:calendar.notice,...(calendar.reference?{reference:{id:calendar.reference.id,market:calendar.reference.market,version:calendar.reference.version,digest:calendar.reference.digest}}:{})},
  schedule:{timezone:schedule.timezone,at:schedule.at,businessDateRule:schedule.businessDate.rule,concurrency:schedule.concurrency,retries:schedule.retries},
  frozenBusinessDate:businessDate,suggestedFor,selected:result,
  deployment:{adapter:deployment.adapter,environment:deployment.environment,engine:deployment.runtime.engine,version:deployment.runtime.version},
  order:plan.order.map(node=>({id:node.id,kind:node.kind,file:node.file??null})),
  notice:'只读取已保存包并核对文件摘要；不验证外部运行环境、不执行计算、不批准或发布任务。'};
}
