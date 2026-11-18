const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value),sha=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function frozenSchedulePath({packageId,packageDigest,scheduledFor}){
 if(!uuid(packageId)||!sha(packageDigest)||scheduledFor!==undefined&&(typeof scheduledFor!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(scheduledFor)))throw Error('请提供原交付包编号、完整摘要及北京时间');
 return `/delivery/packages/${packageId}/schedule-preview?packageDigest=${packageDigest}`+(scheduledFor===undefined?'':'&scheduledFor='+encodeURIComponent(scheduledFor));
}
export async function readFrozenSchedule(client,input){
 const value=await client.request(frozenSchedulePath(input)),r=value?.selected;
 const date=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 const time=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T09:00:00\+08:00$/.test(v)&&date(v.slice(0,10)),text=v=>typeof v==='string'&&v.length>0;
 const c=value?.calendar,s=value?.schedule,d=value?.deployment;
 if(value?.protocol!=='shuduo-frozen-schedule-preview/v1'||value.readOnly!==true||value.binding?.packageId!==input.packageId||value.binding?.packageDigest!==input.packageDigest||!uuid(value.binding?.revisionId)||!uuid(value.binding?.runId)||
 !Array.isArray(value.order)||value.order.length!==3||!value.order.every(n=>text(n?.id)&&text(n.kind)&&(n.file===null||text(n.file)))||
 !date(c?.range?.start)||!date(c?.range?.end)||c.range.start>c.range.end||c.timezone!=='Asia/Shanghai'||!Number.isInteger(c.tradingDayCount)||c.tradingDayCount<1||!text(c.notice)||
 !(c.schema==='shuduo-calendar/v1'&&c.kind==='SYNTHETIC_DEMO'||c.schema==='shuduo-calendar/v2'&&c.kind==='EXCHANGE_NOTICE_DERIVED'&&text(c.reference?.id)&&sha(c.reference?.digest)&&text(c.reference?.version))||
 s?.timezone!=='Asia/Shanghai'||s.at!=='09:00:00'||s.businessDateRule!=='previous_trading_day'||s.concurrency!==1||s.retries!==0||![d?.adapter,d?.environment,d?.engine,d?.version,value.notice].every(text)||!date(value.frozenBusinessDate)||(value.suggestedFor!==null&&!time(value.suggestedFor))||
 !['MATCHES_FROZEN_INPUT','BUSINESS_DATE_MISMATCH','NON_TRADING_DAY','OUT_OF_RANGE','PREVIOUS_TRADING_DAY_MISSING','COVERAGE_INSUFFICIENT'].includes(r?.status)||typeof r.matchesFrozenInput!=='boolean'||!text(r.reason)||
 (r.status==='COVERAGE_INSUFFICIENT'?r.scheduledFor!==null:!time(r.scheduledFor))||input.scheduledFor!==undefined&&r.scheduledFor!==input.scheduledFor||
 (r.status==='MATCHES_FROZEN_INPUT'?r.matchesFrozenInput!==true||r.businessDate!==value.frozenBusinessDate:r.matchesFrozenInput!==false)||
 (r.status==='BUSINESS_DATE_MISMATCH'?!date(r.businessDate)||r.businessDate===value.frozenBusinessDate:!r.matchesFrozenInput&&r.businessDate!==null))throw Error('原包调度预检读取未确认；请重读同一版本');
 return value;
}
