import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const definitions=JSON.parse(readFileSync(new URL('../../fixtures/calendars/cn-equities-2025-2026.json',import.meta.url),'utf8')).calendars;
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const hash=value=>createHash('sha256').update(canonical(value)).digest('hex');
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
export function calendarDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw fail(422,'CALENDAR_DATE_INVALID','请提供有效的YYYY-MM-DD日期');return value;}
const days=(start,end)=>{const result=[];for(let t=Date.parse(start+'T00:00:00Z');t<=Date.parse(end+'T00:00:00Z');t+=86400000)result.push(new Date(t).toISOString().slice(0,10));return result;};
const closed=(definition,day)=>definition.holidayClosures.find(range=>day>=range.start&&day<=range.end);
const calendars=definitions.map(definition=>{
 const tradingDays=days(definition.range.start,definition.range.end).filter(day=>!definition.weeklyClosedDays.includes(new Date(day+'T00:00:00Z').getUTCDay())&&!closed(definition,day));
 const payload={...definition,tradingDays};return {...payload,digest:hash(payload)};
});
const find=id=>{const value=calendars.find(item=>item.id===id);if(!value)throw fail(404,'CALENDAR_NOT_REGISTERED','交易日历版本尚未登记');return value;};
const clone=value=>JSON.parse(JSON.stringify(value));
export function listTradingCalendars(){return calendars.map(({tradingDays,holidayClosures,...metadata})=>({...clone(metadata),tradingDayCount:tradingDays.length}));}
export function readTradingCalendar(id){return clone(find(id));}
export function registeredDeliveryCalendar(selection){
 if(!selection||typeof selection!=='object'||Array.isArray(selection)||Object.keys(selection).length!==2||typeof selection.calendarId!=='string'||typeof selection.calendarDigest!=='string')throw fail(422,'CALENDAR_SELECTION_INVALID','请选择已核对的日历编号及版本摘要');
 const value=find(selection.calendarId);if(value.digest!==selection.calendarDigest)throw fail(409,'CALENDAR_VERSION_CHANGED','日历版本摘要已变化，请重新核对');
 const {id,market,name,version,scope,checkedOn,digest,sources,weeklyRuleSource,holidayClosures,weeklyClosedDays,...calendar}=clone(value);
 return {schema:'shuduo-calendar/v2',kind:'EXCHANGE_NOTICE_DERIVED',...calendar,reference:{id,market,name,version,scope,checkedOn,digest,sources,weeklyRuleSource,holidayClosures,weeklyClosedDays}};
}
export function validateRegisteredDeliveryCalendar(calendar){
 const expected=registeredDeliveryCalendar({calendarId:calendar?.reference?.id,calendarDigest:calendar?.reference?.digest});
 if(canonical(calendar)!==canonical(expected))throw fail(422,'CALENDAR_CONTENT_MISMATCH','日历日期或来源与登记版本不一致');return expected;
}
export function resolveTradingCalendar(id,date,expectedDigest){
 const value=find(id);calendarDate(date);if(expectedDigest!==undefined&&expectedDigest!==value.digest)throw fail(409,'CALENDAR_VERSION_CHANGED','日历版本摘要已变化，请重新核对');
 if(date<value.range.start||date>value.range.end)throw fail(422,'CALENDAR_DATE_OUT_OF_RANGE','超出已登记公告覆盖范围，不能推断交易日');
 const previous=[...value.tradingDays].reverse().find(day=>day<date),next=value.tradingDays.find(day=>day>date),isTradingDay=value.tradingDays.includes(date),holiday=closed(value,date);
 return {protocol:'shuduo-calendar-resolution/v1',readOnly:true,calendarId:value.id,calendarDigest:value.digest,date,timezone:value.timezone,isTradingDay,
   classification:isTradingDay?'TRADING_DAY':holiday?'HOLIDAY':'WEEKEND',holidayCode:holiday?.code,
   previous:previous?{status:'COVERED',date:previous}:{status:'OUT_OF_RANGE'},next:next?{status:'COVERED',date:next}:{status:'OUT_OF_RANGE'},
   t1:{eligible:isTradingDay&&Boolean(previous),status:!isTradingDay?'NON_TRADING_DAY':previous?'READY':'PREVIOUS_NOT_COVERED',businessDate:isTradingDay&&previous?previous:null},coverage:clone(value.range),notice:value.notice};
}
