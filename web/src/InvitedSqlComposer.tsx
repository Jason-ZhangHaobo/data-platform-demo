import {useEffect,useRef,useState} from 'react';
import {Send} from 'lucide-react';
import {acceptsInvitedSqlContext} from '../../src/v2/invited-sql-start.mjs';
import {createInvitedSqlSubmission} from './invited-sql-submission';
import {invitedChatStartLocation,invitedPendingRequest,invitedStartReason,invitedWindowTaskLocation,type InvitedStartWindow} from './invited-chat-start';
import './invited-task-chat.css';

type Props={api:<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;authenticated:boolean;
  access?:InvitedStartWindow;initialContextId:string;onLogin:()=>void;onTask:(href:string,createdHere?:boolean)=>void;
  onLock:(locked:boolean)=>void;onDirtyChange?:(dirty:boolean)=>void};

export default function InvitedSqlComposer({api,access,authenticated,initialContextId,onLogin,onTask,onLock,onDirtyChange}:Props){
  const [initialKey]=useState(()=>invitedPendingRequest(location.href));
  const [pending,setPending]=useState(initialKey??undefined),[message,setMessage]=useState(''),[selected,setSelected]=useState<string>();
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[canRetry,setCanRetry]=useState(false);
  const [originalMissing,setOriginalMissing]=useState(false);
  const [,refreshClock]=useState(0);
  const options=(access?.contexts??[]).filter(acceptsInvitedSqlContext);
  const context=selected ? options.find(c=>c.id===selected) : options.find(c=>c.id===initialContextId)??options[0];
  const latest=useRef({access,authenticated,options,onTask});
  latest.current={access,authenticated,options,onTask};
  const controller=useRef<ReturnType<typeof createInvitedSqlSubmission>|undefined>(undefined);
  const submittedHere=useRef(false);
  const inFlight=useRef(false);
  const reason=invitedStartReason(authenticated,access);
  const existingTask=invitedWindowTaskLocation(location.href,access?.windowTaskId);
  useEffect(()=>{
    const timestamps=[access?.startsAt,access?.expiresAt,access?.sessionExpiresAt].map(v=>Date.parse(v??''));
    const timers=timestamps.filter(t=>t>=Date.now()).map(t=>setTimeout(()=>refreshClock(n=>n+1),Math.max(1,t-Date.now()+1)));
    return ()=>timers.forEach(clearTimeout);
  },[access?.startsAt,access?.expiresAt,access?.sessionExpiresAt]);
  const locked=Boolean(busy||pending||message.trim());
  useEffect(()=>{onLock(locked);onDirtyChange?.(locked);},[locked,onLock,onDirtyChange]);
  useEffect(()=>()=>{onLock(false);onDirtyChange?.(false);},[onLock,onDirtyChange]);

  function setup(){
    return createInvitedSqlSubmission({api,initialKey:initialKey??undefined,
      canSubmit:()=>!invitedStartReason(latest.current.authenticated,latest.current.access),
      acceptsContext:id=>latest.current.options.some(c=>c.id===id),
      onPending:key=>{
        if(!key)return;
        const href=invitedChatStartLocation(location.href);
        href.searchParams.set('agent_request',key);
        history.replaceState(null,'',href);
        setPending(key);
      }});
  }
  async function perform(action:'submit'|'recover'|'retry'){
    if(inFlight.current||!latest.current.authenticated||initialKey===null)return;
    const client=controller.current;
    if(!client||client.snapshot().closed)return;
    inFlight.current=true;setBusy(true);setError('');setCanRetry(false);setOriginalMissing(false);
    try{
      if(action==='submit')submittedHere.current=true;
      const result=action==='recover'?await client.recover():action==='retry'?await client.retry():
        await client.submit({message,contextId:context?.id??''});
      if(controller.current!==client||client.snapshot().closed)return;
      const href=invitedChatStartLocation(location.href);
      href.searchParams.set('task',result.taskId);href.searchParams.set('invited_request',result.requestId);
      latest.current.onTask(href.href,submittedHere.current);
    }catch(cause){
      if(controller.current!==client||client.snapshot().closed)return;
      setError((cause as Error).message);
      const missing=action==='recover'&&(cause as {status?:number}).status===404;
      setOriginalMissing(missing);setCanRetry(missing&&client.snapshot().canRetry);
    }finally{
      if(controller.current===client&&!client.snapshot().closed){inFlight.current=false;setBusy(false);}
    }
  }
  useEffect(()=>{
    const instance=setup();controller.current=instance;inFlight.current=false;
    if(authenticated&&initialKey)void perform('recover');
    return ()=>{instance.close();controller.current=undefined;};
  },[api,authenticated,initialKey]);

  return <section className="invited-task-chat invited-sql-compose" aria-label="新建受邀 SQL 开发任务">
    <header><h2>{pending?'找回原开发任务':'新建 SQL 开发任务'}</h2></header>
    {initialKey===null?<p role="alert">原请求链接不完整或混入了其他来源，请打开原链接。</p>
      :!authenticated?<div className="invited-chat-access"><p>请使用原受邀账号登录。</p><button className="button primary" onClick={onLogin}>受邀用户登录</button></div>
      :pending?<><p>原请求 <code>{pending}</code></p>
        <p role="status">{busy?'正在核对原任务…':'原请求尚待确认。可以查询同一编号找回任务。'}</p>
        {error&&<p role="alert">{error}</p>}
        {originalMissing&&existingTask&&<p>当前账号已占用本窗口的开发名额。可以单独查看已登记的任务，本页保留原请求。
          {' '}<a href={existingTask.href} target="_blank" rel="noreferrer">查看本窗口已登记的任务</a></p>}
        <div className="invited-start-actions"><button className="button" disabled={busy} onClick={()=>void perform('recover')}>查询原任务</button>
          {canRetry&&<button className="button primary" disabled={busy||Boolean(reason)} onClick={()=>void perform('retry')}>重发同一请求</button>}</div></>
      :existingTask?<>
        <p role="status">本窗口已有一个 SQL 开发任务。</p>
        <button className="button primary" onClick={()=>onTask(existingTask.href)}>打开本窗口的 SQL 任务</button></>
      :reason?<><p role="status">{reason}</p>{message&&<><label htmlFor="invited-sql-draft">本页草稿</label>
        <textarea id="invited-sql-draft" value={message} readOnly/><button className="button" onClick={()=>setMessage('')}>清除草稿</button></>}</>
      :<form onSubmit={e=>{e.preventDefault();if(message.trim().length>=4&&context&&!busy)void perform('submit');}}>
        <label htmlFor="invited-sql-scope">业务口径</label>
        <select id="invited-sql-scope" value={context?.id??''} disabled={busy||!options.length} onChange={e=>setSelected(e.target.value)}>
          {!context&&<option value="">请选择可用口径</option>}
          {options.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select>
        {context?<p className="invited-scope-definition">{context.definition}</p>:<p role="status">{options.length?'所选口径已不可用，请重新选择。':'当前项目没有可委托的 SQL 口径。'}</p>}
        <label htmlFor="invited-sql-demand">开发需求</label>
        <textarea id="invited-sql-demand" rows={4} maxLength={2000} value={message} onChange={e=>{if(!selected&&context)setSelected(context.id);setMessage(e.target.value);}}
          disabled={busy} placeholder="例如：按客户汇总持仓和可用现金，检查现金是否重复累计。"/>
        <p>提交后，后台将按所选口径调用模型编写 SQL，并使用 Spark 运行和校验。本次委托仅用于数据开发。</p>
        {error&&<p role="alert">{error}</p>}
        <button type="submit" className="button primary" disabled={busy||message.trim().length<4||!context}><Send size={15}/>提交后台开发</button>
      </form>}
  </section>;
}
