import {useEffect,useState} from 'react';
import {ArrowRight,FileCode2,RefreshCw} from 'lucide-react';
import {readInvitedSqlContext,type InvitedSqlContextReceipt} from '../../src/v2/invited-sql-context-client.mjs';
import {invitedEditorLocation,invitedEditorSource,invitedTaskSelection,type InvitedTaskSelection} from './invited-task-location';
import './invited-task-chat.css';

type Props={api:<T>(path:string)=>Promise<T>;authenticated:boolean;onLogin:()=>void;onEditor:(href:string)=>void};
const labels:Record<string,string>={SUCCEEDED:'成功',FAILED:'失败',CANCELLED:'已取消',INTERRUPTED:'已中断',VALIDATION_FAILED:'断言未通过',
  RUNNING:'运行中',QUEUED:'已排队',PENDING:'等待记录',PASSED:'通过',UNCONFIRMED:'待核对'};

export function InvitedTaskEvidence({value}:{value:InvitedSqlContextReceipt}){
  const {revision,run}=value;
  return <>
    <section className="invited-chat-demand" aria-label="原开发需求"><h3>原开发需求</h3><p>{value.message}</p></section>
    <section className="invited-chat-evidence" aria-label="已保存的运行记录">
      <h3><FileCode2 size={18}/>开发记录</h3>
      <dl><div><dt>数据口径</dt><dd>{value.contextId}</dd></div><div><dt>任务状态</dt><dd>{labels[value.taskStatus]??value.taskStatus}</dd></div>
        {run&&<div><dt>记录来源</dt><dd>{value.evidenceSource==='TEST_HARNESS'?'测试执行记录':value.evidenceSource==='STORED_METADATA'?'已存执行记录':'执行来源待核对'}</dd></div>}
        <div><dt>开发尝试</dt><dd>{value.attemptCount} 次</dd></div>
        {revision&&<div><dt>代码版本</dt><dd><code title={revision.id}>{revision.id.slice(0,8)}</code></dd></div>}
        {run&&<div><dt>运行批次</dt><dd><code title={run.id}>{run.id.slice(0,8)}</code></dd></div>}
      </dl>
      {revision&&<pre tabIndex={0} aria-label="已保存的 SQL"><code>{revision.sql}</code></pre>}
      {value.evidenceState==='PENDING'&&<p role="status">任务尚在推进，已保存的记录显示在此处。</p>}
      {value.evidenceState==='UNCONFIRMED'&&<p role="status">原版本和运行依据尚待核对。</p>}
      {run&&<><h4>运行与独立断言</h4>
        <p>{[run.engine,run.engineVersion].filter(Boolean).join(' ')}{run.engine?' · ':''}{labels[run.status]??run.status}</p>
        <dl><div><dt>核验结果</dt><dd>{labels[run.validation.state]??run.validation.state}</dd></div></dl>
        {run.validation.regressions.length>0&&<ul className="invited-chat-checks">{run.validation.regressions.map(c=><li key={c.contextId}><span>{c.contextId}</span>
          <strong>{c.passed?'通过':'未通过'}</strong></li>)}</ul>}
      </>}
    </section>
  </>;
}

export default function InvitedTaskChat({api,authenticated,onLogin,onEditor}:Props){
  const selection=invitedTaskSelection(location.href),pin=invitedEditorSource(location.href);
  const taskId=selection?.taskId,requestId=selection?.requestId;
  const [attempt,setAttempt]=useState(0);
  const [saved,setSaved]=useState<{key:string;value:InvitedSqlContextReceipt}|{key:string;error:string}>();
  const recordKey=JSON.stringify([taskId,requestId,attempt,authenticated]);
  const current=saved?.key===recordKey?saved:undefined;
  useEffect(()=>{
    if(!authenticated||!taskId)return;
    let active=true;
    readInvitedSqlContext({request:path=>api(path)},{taskId,...(requestId?{requestId}:{})}).then(
      value=>{if(active)setSaved({key:recordKey,value});},
      (cause:Error)=>{if(active)setSaved({key:recordKey,error:cause.message});});
    return()=>{active=false;};
  },[api,authenticated,recordKey,requestId,taskId]);
  const value=current&&'value' in current?current.value:undefined;
  const changed=Boolean(pin&&value&&(pin.contextId!==value.contextId||pin.revisionId!==value.revision?.id||
    pin.revisionHash!==value.revision?.hash||pin.runId!==value.run?.id));
  function returnToEditor(selected:InvitedTaskSelection,receipt:InvitedSqlContextReceipt) {
    const {revision,run,contextId}=receipt;
    onEditor(invitedEditorLocation(location.href,selected,revision?{...selected,contextId,revisionId:revision.id,revisionHash:revision.hash,...(run?{runId:run.id}:{})}:undefined).href);
  }
  return <section className="invited-task-chat" aria-label="受邀 SQL 任务上下文">
    <header><h2>SQL 开发对话</h2></header>
    {!selection?<p role="alert">原任务链接不完整或混用了其他来源。</p>
      :!authenticated?<div className="invited-chat-access"><p>请使用创建此任务的受邀账号查看开发记录。</p><button className="button primary" onClick={onLogin}>登录查看原任务</button></div>
      :<><div className="invited-chat-toolbar"><span>原任务 <code title={taskId}>{taskId?.slice(0,8)}</code></span>
        <button className="button" disabled={!current} onClick={()=>setAttempt(n=>n+1)}><RefreshCw size={13}/>重新读取</button></div>
        {changed&&<p role="status">此任务的代码或运行记录已更新。下方显示当前保存的版本。</p>}
        {!current?<p role="status">正在读取原任务…</p>:('error' in current?<p role="alert">原任务暂不可用。{current.error}</p>:<InvitedTaskEvidence value={current.value}/>)}
        {value&&value.evidenceState!=='UNCONFIRMED'&&<button className="button primary" onClick={()=>returnToEditor(selection,value)}>{changed?'打开当前版本编辑器':'返回原任务编辑器'}<ArrowRight size={14}/></button>}
      </>}
  </section>;
}
