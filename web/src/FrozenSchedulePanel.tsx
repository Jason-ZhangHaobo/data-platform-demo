import {useEffect,useState} from 'react';
import {readFrozenSchedule} from '../../src/v2/frozen-schedule-client.mjs';
import type {FrozenSchedulePreview} from '../../src/v2/frozen-schedule-client.mjs';
type Api=<T>(path:string)=>Promise<T>;
const statuses:Record<string,string>={MATCHES_FROZEN_INPUT:'日期对应原冻结输入',BUSINESS_DATE_MISMATCH:'与原冻结业务日不一致',NON_TRADING_DAY:'原包日历当天休市',OUT_OF_RANGE:'超出原包日历覆盖',PREVIOUS_TRADING_DAY_MISSING:'缺少前一交易日',COVERAGE_INSUFFICIENT:'原包覆盖不足'};
export function FrozenSchedulePanel({api,packageId,packageDigest,current}:{api:Api;packageId:string;packageDigest:string;current:boolean}){
 const [date,setDate]=useState(''),[retry,setRetry]=useState(0),[record,setRecord]=useState<{key:string;value:FrozenSchedulePreview}>(),[error,setError]=useState(''),[loading,setLoading]=useState(true);
 const key=JSON.stringify([packageId,packageDigest,date,retry]),preview=record?.key===key?record.value:undefined;
 useEffect(()=>{let alive=true;setLoading(true);setError('');setRecord(undefined);const input={packageId,packageDigest,...(date?{scheduledFor:date+'T09:00:00+08:00'}:{})};
  void readFrozenSchedule({request:path=>api(path)},input).then(value=>{if(alive)setRecord({key,value});}).catch(cause=>{if(alive)setError((cause as Error).message);}).finally(()=>{if(alive)setLoading(false);});return()=>{alive=false;};
 },[api,packageId,packageDigest,date,retry,key]);
 return <section className="frozen-schedule-panel" aria-label="原包调度预检"><header><div><span className="eyebrow">FROZEN DELIVERY · READ ONLY</span><h3>这份交付会加工哪一天？</h3><p>{current?'按当前读取的原包核对':'历史包，仅供对照'}。日期仅用于预检，原文件和批准保持原版本；不代表已经执行或发布。</p></div><span className="status-pill">原包 · {packageDigest.slice(0,10)}</span></header>
  <div className="frozen-schedule-controls"><label>预检调度日期<input aria-label="原包预检调度日期" type="date" value={date||preview?.suggestedFor?.slice(0,10)||''} onChange={event=>setDate(event.target.value)}/></label><button className="button" onClick={()=>setDate('')}>回到原业务日</button><button className="button" disabled={loading} onClick={()=>setRetry(value=>value+1)}>重新读取原包</button></div>
  {loading&&<p role="status">正在核对原文件与版本…</p>}{error&&<p role="alert" className="calendar-error">{error}。原文件保留，未采用旧预检结果。</p>}
  {preview&&<><div className={'frozen-schedule-result '+(preview.selected.matchesFrozenInput?'matches':'blocked')} role="status"><strong>{statuses[preview.selected.status]??'预检结果未确认'}</strong><p>{preview.selected.reason}</p><dl><dt>原冻结业务日</dt><dd>{preview.frozenBusinessDate}</dd><dt>所选调度时点</dt><dd>{preview.selected.scheduledFor?.replace('T',' ').replace('+08:00',' 北京时间')??'覆盖不足，无法推断'}</dd><dt>对应加工业务日</dt><dd>{preview.selected.businessDate??'不可推断'}</dd></dl></div>
   <div className="frozen-schedule-basis"><div><strong>{preview.calendar.kind==='SYNTHETIC_DEMO'?'原包使用有限样例日历':'原包使用公告推导日历'}</strong><p>{preview.calendar.range.start}—{preview.calendar.range.end} · {preview.calendar.tradingDayCount}个登记交易日</p><p>{preview.calendar.notice}</p>{preview.calendar.reference&&<small>{preview.calendar.reference.id} · {preview.calendar.reference.version}</small>}</div><div><strong>原包部署与依赖</strong><p>{preview.deployment.engine} {preview.deployment.version} · {preview.deployment.adapter}</p><p>原包登记交易日 {preview.schedule.at}，加工前一交易日；并发 {preview.schedule.concurrency}，重试 {preview.schedule.retries}。</p><ol>{preview.order.map(node=><li key={node.id}>{node.file??'记录核验证据'}</li>)}</ol></div></div><small>{preview.notice}</small></>}
 </section>;
}
