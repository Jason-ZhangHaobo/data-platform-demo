import {isDeepStrictEqual as same} from 'node:util';
import {readDeliveryPreparationSource} from './delivery-preparation-request.mjs';
import {registeredDeliveryCalendar} from './trading-calendar.mjs';
import {sqlRequirementBinding} from './sql-requirements.mjs';
const fail=message=>Object.assign(Error(message),{status:409,code:'AGENT_CALENDAR_SOURCE_CHANGED'});
export function readAgentCalendarPreparation(body,taskId){
 if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['expectedSource','calendarSelection'].includes(k))||!Object.hasOwn(body,'calendarSelection')||!Object.hasOwn(body,'expectedSource'))throw Object.assign(Error('请选择日历并绑定已核验代码与批次'),{status:422});
 const source=readDeliveryPreparationSource({expectedSource:body.expectedSource},taskId),calendar=registeredDeliveryCalendar(body.calendarSelection);
 return {expectedSource:source,calendarSelection:{calendarId:calendar.reference.id,calendarDigest:calendar.reference.digest}};
}
export function localAgentCalendarSource(agent,revision,run){
 return {revisionId:revision.id,revisionHash:revision.hash,runId:run.id,...(agent.requirements?{requirementBinding:sqlRequirementBinding(agent.requirements)}:{})};
}
export function assertAgentCalendarSource(expected,agent,revision,run){if(!same(expected,localAgentCalendarSource(agent,revision,run)))throw fail('所选日历的代码、需求或批次已变化；未准备新交付');}
export function agentCalendarMatches(bundle,selection){
 try{const calendar=JSON.parse(bundle.files['calendar.json']);return selection===undefined?calendar.schema==='shuduo-calendar/v1'&&calendar.kind==='SYNTHETIC_DEMO':calendar.schema==='shuduo-calendar/v2'&&calendar.reference?.id===selection.calendarId&&calendar.reference.digest===selection.calendarDigest;}catch{return false;}
}
export function agentCalendarScheduledFor(plan,selection){
 if(selection===undefined)return '2026-09-11T09:00:00+08:00';
 const calendar=registeredDeliveryCalendar(selection);
 if(!same(plan.calendar,calendar))throw fail('原包日历与本次明确选择不一致');
 const index=calendar.tradingDays.indexOf(plan.fixtures.context.businessDate),next=index>=0?calendar.tradingDays[index+1]:undefined;
 if(!next)throw Object.assign(Error('所选日历不足以覆盖原业务日及下一交易日；未执行演练'),{status:422,code:'AGENT_CALENDAR_COVERAGE_INSUFFICIENT'});
 return next+'T'+plan.schedule.at+'+08:00';
}
