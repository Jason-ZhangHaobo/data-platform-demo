import{useEffect,useRef,useState}from'react';import{Braces,RefreshCw,ArrowUpRight}from'lucide-react';
import{readStandaloneConsumption}from'../../src/v2/standalone-service-consumption-client.mjs';import type{StandaloneConsumption}from'../../src/v2/standalone-service-consumption-client.mjs';
import type{StandaloneServiceSourceBinding,ServiceSourceBinding}from'./service-source-binding';
export function StandaloneServiceConsumptionPanel({api,binding,onOpenServices,blocked}:{api:<T>(path:string)=>Promise<T>;binding:StandaloneServiceSourceBinding;onOpenServices?:(source:ServiceSourceBinding)=>void;blocked:boolean}){
 const key=JSON.stringify(binding),active=useRef(key);active.current=key;const alive=useRef(true),seq=useRef(0),[state,setState]=useState<{key:string;status:'LOADING'|'READY'|'ERROR';value?:StandaloneConsumption;error?:string}>({key,status:'LOADING'}),current=state.key===key?state:undefined;
 const load=async()=>{const scope=key,ticket=++seq.current;setState(old=>({key:scope,status:'LOADING',value:old.key===scope?old.value:undefined}));try{const value=await readStandaloneConsumption({request:p=>api(p)},{manualDeliveryTaskId:binding.manualDeliveryTaskId,packageDigest:binding.packageDigest,releaseId:binding.releaseId,revisionId:binding.revisionId,runId:binding.runId,revisionHash:binding.revisionHash});if(alive.current&&active.current===scope&&ticket===seq.current)setState({key:scope,status:'READY',value});}catch(e){if(alive.current&&active.current===scope&&ticket===seq.current)setState(old=>({key:scope,status:'ERROR',value:old.key===scope?old.value:undefined,error:(e as Error).message}));}};
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;seq.current++;};},[]);useEffect(()=>{void load();},[key]);
 return <section className="agent-delivery-panel" aria-label="独立手工发布的接口消费"><header><div><Braces size={17}/><strong>把此版本交给业务系统</strong></div><button className="button" disabled={current?.status==='LOADING'} onClick={()=>void load()}><RefreshCw size={14}/>读取接口消费证据</button></header>
  <p>同一包与发布批次可用于 DAPI 查询和 XAPI 组合；继续保留独立手工来源。</p>
  {current?.status!=='READY'&&<p role={current?.status==='ERROR'?'alert':'status'}>{current?.error??'正在核对原批次、接口版本与历史调用；读取不创建接口或凭证。'}</p>}
  {current?.value&&<><p>{current.status==='READY'&&current.value.evidence.status==='VERIFIED'?'历史授权调用与不可变快照对照通过。':'尚未确认此版本的完整组合授权消费。'}</p><small>已核对成功批次 {current.value.sources.length} 个 · 相关接口 {current.value.evidence.matchingCount} 个。历史通过不表示调用凭证现在仍有效。</small>{current.value.evidence.services.map(s=><p key={s.serviceId}>{s.name} · {s.serviceType} · {s.status==='VERIFIED'?'历史调用对照通过':s.status==='PENDING'?'待授权调用':'证据待处理'}{s.call?` · ${s.call.rowCount}行 · 应用${s.call.applicationStatus==='REVOKED'?'已撤销':s.call.applicationStatus==='EXPIRED'?'已到期':'状态以当前授权为准'}`:''}</p>)}
   <button className="button primary" disabled={blocked||current.status!=='READY'||!current.value.sources.length||!onOpenServices} onClick={()=>{if(!blocked&&current.status==='READY'&&current.value?.sources.length)onOpenServices?.(binding);}}><ArrowUpRight size={15}/>进入此版本的数据服务</button>
   {!onOpenServices&&<p>当前环境尚未接入数据服务界面；原发布记录保留。</p>}
  </>}
  <small>此处核对已保存的授权调用，不新增查询、不发凭证，也不计作外部系统或 Agent 自主验收。</small>
 </section>;
}
