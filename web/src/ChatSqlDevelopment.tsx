import {useEffect,useRef,useState} from 'react';
import {ArrowRight,ChevronDown,Code2} from 'lucide-react';
import {chatEditorLocation} from './agent-chat-editor-location';
import {readChatSqlDevelopment,recordChatSqlTakeover,type ChatSqlDevelopment} from './chat-sql-development';
import './chat-sql-development.css';

type Props={
  api:<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
  intentId:string;
  taskId:string;
  canEdit:boolean;
  isCurrent:()=>boolean;
  onOpen:(editorHref:string)=>void;
};

const statusLabels:Record<string,string>={
  SUCCEEDED:'成功',FAILED:'失败',VALIDATION_FAILED:'校验失败',CANCELLED:'已取消',
  INTERRUPTED:'已中断',GENERATED:'已生成代码',RUNNING:'运行中',
};
const statusLabel=(s:string)=>statusLabels[s]??s;

export function SqlDevelopmentResult({evidence}:{evidence:ChatSqlDevelopment}){
  const {binding,validation:v}=evidence;
  return <div className="chat-sql-result" aria-label="SQL 与调试结果">
    <div className="chat-sql-identifiers"><span>代码来源 · {evidence.codeSource==='SYNTHETIC_MODEL'?'测试模型':evidence.codeSource==='RECORDED_MODEL'?'已记录的模型生成':'来源待核对'}</span><span>数据口径 <code>{binding.contextId}</code></span><span>代码版本 <code title={binding.revisionId}>{binding.revisionId.slice(0,8)}</code></span><span>运行批次 <code title={binding.runId}>{binding.runId.slice(0,8)}</code></span></div>
    <pre tabIndex={0} aria-label="本次运行的 SQL"><code>{evidence.sql}</code></pre>
    <section aria-label="调试记录"><h4>调试记录</h4>
      <p>{[evidence.engine,evidence.engineVersion].filter(Boolean).join(' ')||'执行引擎未记录'} · {statusLabel(evidence.runStatus)}{evidence.testDouble===true?' · 使用测试执行器':evidence.testDouble===null?' · 执行来源未确认':''}</p>
      <ol>{evidence.attempts.map(a=><li key={a.attempt}>第 {a.attempt} 次 · {statusLabel(a.status)}{a.runId&&<code title={a.runId}>{a.runId.slice(0,8)}</code>}
        {Boolean(a.failedChecks?.length)&&<p>未通过的场景：{a.failedChecks!.join('、')}</p>}</li>)}</ol>
    </section>
    <section aria-label="独立业务断言"><h4>独立业务断言</h4>
      <p>{v.state==='PASSED'?'通过':v.state==='FAILED'?'未通过':'结果待核对'}{v.contractId&&<> · <code>{v.contractId}</code></>}</p>
      {v.regressions.length>0&&<ul>{v.regressions.map(r=><li key={r.contextId}><span title={r.contextId}>{r.name??r.contextId}</span><strong data-passed={r.passed}>{r.passed?'通过':'未通过'}</strong></li>)}</ul>}
    </section>
  </div>;
}

export default function ChatSqlDevelopment({api,intentId,taskId,canEdit,isCurrent,onOpen}:Props) {
  const [open,setOpen]=useState(false),[retry,setRetry]=useState(0);
  const [evidence,setEvidence]=useState<ChatSqlDevelopment>(),[error,setError]=useState('');
  const [opening,setOpening]=useState(false),[openError,setOpenError]=useState('');
  const openFlight=useRef(false),mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!open)return;
    let active=true;
    setEvidence(undefined);setError('');
    readChatSqlDevelopment(api,intentId).then(result=>{
      if(result.binding.taskId!==taskId)throw Error('对话中关联的开发任务已经变化，请重新读取原会话。');
      if(active)setEvidence(result);
    }).catch(cause=>{if(active)setError((cause as Error).message);});
    return()=>{active=false;};
  },[api,intentId,taskId,open,retry]);
  async function openEditor(){
    if(!evidence||openFlight.current||!isCurrent())return;
    openFlight.current=true;setOpening(true);setOpenError('');
    const current=()=>mounted.current&&isCurrent();
    try{
      const href=chatEditorLocation(location.href,evidence.binding).href;
      if(canEdit&&!await recordChatSqlTakeover(api,evidence.binding,current))return;
      if(current())onOpen(href);
    }catch(cause){if(current())setOpenError((cause as Error).message);}
    finally{openFlight.current=false;if(mounted.current)setOpening(false);}
  }
  return <section className="chat-sql-development">
    <button type="button" className="chat-sql-toggle" aria-expanded={open} disabled={opening} onClick={()=>setOpen(!open)}>
      <Code2 size={16}/>查看 SQL 与调试结果<ChevronDown size={14}/>
    </button>
    {open&&<>
      {error?<p role="alert">{error} <button type="button" className="button" onClick={()=>setRetry(n=>n+1)}>重新读取</button></p>
      :!evidence?<p role="status">正在读取此任务保存的代码和运行结果…</p>
      :<><SqlDevelopmentResult evidence={evidence}/>
        <button type="button" className="button" disabled={opening} onClick={()=>void openEditor()}>{opening?'正在核对接管记录…':canEdit?'接管此版本':'查看此版本'}<ArrowRight size={14}/></button>
        {openError&&<p role="alert">{openError}</p>}</>}
    </>}
  </section>;
}
