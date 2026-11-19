import {useEffect,useRef,useState} from 'react';
import {readTradingCalendars,readTradingCalendarVersion,readTradingDay} from '../../src/v2/trading-calendar-client.mjs';
import type {CalendarSelection,TradingCalendar,TradingDayResolution} from '../../src/v2/trading-calendar-client.mjs';
type Api=<T>(path:string)=>Promise<T>;
export function AgentCalendarPreparation({api,businessDate,selection,disabled,onSelect}:{api:Api;businessDate:string;selection?:CalendarSelection;disabled:boolean;onSelect:(value:CalendarSelection|undefined)=>void}){
 const [items,setItems]=useState<TradingCalendar[]>(),[id,setId]=useState(''),[version,setVersion]=useState<TradingCalendar>(),[resolution,setResolution]=useState<TradingDayResolution>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);const seq=useRef(0);
 useEffect(()=>()=>{seq.current++;},[]);
 const read=async()=>{const ticket=++seq.current;setLoading(true);setError('');setVersion(undefined);setResolution(undefined);try{const list=await readTradingCalendars({request:p=>api(p)});if(seq.current===ticket){setItems(list);setId(selection?.calendarId??list[0]?.id??'');setRetry(n=>n+1);}}catch(e){if(seq.current===ticket)setError((e as Error).message);}finally{if(seq.current===ticket)setLoading(false);}};
 useEffect(()=>{if(!id)return;const ticket=++seq.current;setLoading(true);setVersion(undefined);setResolution(undefined);setError('');void readTradingCalendarVersion({request:p=>api(p)},id).then(async calendar=>{
  const i=calendar.tradingDays?.indexOf(businessDate)??-1,next=i>=0?calendar.tradingDays?.[i+1]:undefined;if(!next)throw Error('此日历不足以覆盖冻结业务日及下一交易日');
  const r=await readTradingDay({request:p=>api(p)},{calendarId:id,date:next,calendarDigest:calendar.digest});if(r.t1.businessDate!==businessDate)throw Error('日历与冻结输入的T+1关系不一致');if(ticket===seq.current){setVersion(calendar);setResolution(r);}
 }).catch(e=>{if(ticket===seq.current)setError((e as Error).message);}).finally(()=>{if(ticket===seq.current)setLoading(false);});return()=>{seq.current++;};},[id,businessDate,api,retry]);
 return <details className="agent-calendar-choice"><summary>为新交付选择交易日历</summary><p>冻结业务日 {businessDate}。选择版本后按它的下一交易日准备交付；相同来源和日历会回读已有交付。原输入、已有文件和批准保持。</p><button className="button" disabled={disabled||loading} onClick={()=>void read()}>{loading?'正在核对日历…':items?'重读可用日历':'读取可用交易日历'}</button>
  {items&&<label>市场与版本<select aria-label="Agent交付日历" disabled={disabled||loading} value={id} onChange={e=>setId(e.target.value)}>{items.map(c=><option key={c.id} value={c.id}>{c.name} · {c.version}</option>)}</select></label>}
  {error&&<p role="alert">{error}，未采用旧预检结果。</p>}{version&&resolution&&<div role="status"><strong>{version.name}</strong><p>业务日 {businessDate} → 演练/调度日 {resolution.date} · Asia/Shanghai 09:00</p><p>覆盖 {version.range.start}—{version.range.end} · 摘要 {version.digest.slice(0,16)}</p><small>{version.notice}</small><ul>{version.sources.map(s=><li key={s.year}><a href={s.url} target="_blank" rel="noreferrer">{s.publisher} {s.year}公告 ↗</a></li>)}</ul><button className="button" disabled={disabled||loading} onClick={()=>onSelect({calendarId:version.id,calendarDigest:version.digest})}>选用此日历准备新交付</button></div>}
  {selection&&<p>新交付草稿已选 {selection.calendarId} · {selection.calendarDigest.slice(0,12)}。<button className="button" disabled={disabled} onClick={()=>onSelect(undefined)}>取消日历草稿</button></p>}
 </details>;
}
