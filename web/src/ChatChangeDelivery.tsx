import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Download,PackageCheck,RefreshCw} from 'lucide-react';
import {readChatChangeDelivery,prepareChatChangeDelivery} from '../../src/v2/chat-change-delivery-client.mjs';
import type {DerivedRunReference} from '../../src/v2/derived-comparison-client.mjs';
import {DeliveryFilePreview} from './DeliveryFilePreview';
import {requestTextDownload} from './EvidenceDownload';
import type {ChangeApi} from './chat-context-change';
import './agent-development.css';

type Receipt=Awaited<ReturnType<typeof readChatChangeDelivery>>;
type Refs=Pick<DerivedRunReference,'taskId'|'contextId'|'revisionId'|'runId'|'revisionHash'>;
type Props={
  api:ChangeApi;intentId:string;changeRequestId:string;parent:Refs;child:Refs;
  canPrepare:boolean;isCurrent:()=>boolean;onPin:()=>void;
};
const labels:Record<Receipt['status'],string>={
  NOT_PREPARED:'待准备',QUEUED:'等待演练',RUNNING:'演练中',SUCCEEDED:'演练通过',
  FAILED:'演练失败',CANCELLED:'已取消',INTERRUPTED:'演练中断',
};
const nodeLabels:Record<string,string>={execute:'执行 main.sql',validate:'核验 tests.sql',evidence:'记录结果'};
function sameSource(a:Refs,b:Refs){
  return a.taskId===b.taskId&&a.contextId===b.contextId&&a.revisionId===b.revisionId&&a.runId===b.runId&&a.revisionHash===b.revisionHash;
}

export default function ChatChangeDelivery({api,intentId,changeRequestId,parent,child,canPrepare,isCurrent,onPin}:Props){
  const [receipt,setReceipt]=useState<Receipt>(),[error,setError]=useState(''),[working,setWorking]=useState(false);
  const [downloadNotice,setDownloadNotice]=useState('');
  const mounted=useRef(false),flight=useRef(false),readOrder=useRef(0),access=useRef({canPrepare,isCurrent});
  access.current={canPrepare,isCurrent};
  const client=useMemo(()=>({
    request:(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string})=>{
      if(options?.method==='POST'&&(!mounted.current||!access.current.canPrepare||!access.current.isCurrent()))
        throw Error('当前选择或执行权限已变化，请核对原会话');
      return api(path,options?.body,options?.idempotencyKey?{idempotencyKey:options.idempotencyKey}:undefined);
    },
  }),[api]);
  const selector=useMemo(()=>({intentId,changeRequestId,sourceRunId:child.runId,sourceTaskId:child.taskId,expectedParent:parent,expectedSource:child}),
    [intentId,changeRequestId,child,parent]);
  const check=useCallback((value:Receipt)=>{
    if(value.intentId!==intentId||value.changeRequestId!==changeRequestId||!sameSource(value.source,child)||!sameSource(value.parent,parent))
      throw Error('交付回执与所选派生版本不一致，请重新核对');
    return value;
  },[intentId,changeRequestId,child,parent]);
  const load=useCallback(async()=>{
    const ticket=++readOrder.current;
    try{
      const current=check(await readChatChangeDelivery(client,selector));
      if(mounted.current&&ticket===readOrder.current){setReceipt(current);setError('');}
      return current;
    }catch(cause){
      if(mounted.current&&ticket===readOrder.current){setReceipt(undefined);setError((cause as Error).message);}
      return undefined;
    }
  },[check,client,selector]);
  useEffect(()=>{
    mounted.current=true;void load();
    return()=>{mounted.current=false;readOrder.current++;};
  },[load]);
  useEffect(()=>{
    if(working||error||!receipt||!['QUEUED','RUNNING'].includes(receipt.status))return;
    const timer=setTimeout(()=>void load(),2200);
    return()=>clearTimeout(timer);
  },[load,working,error,receipt]);

  async function prepare(){
    if(!receipt||receipt.status!=='NOT_PREPARED'||!canPrepare||!isCurrent()||flight.current)return;
    flight.current=true;setWorking(true);setError('');
    try{
      onPin();
      const next=check(await prepareChatChangeDelivery(client,{...selector,requestId:receipt.requestId,confirm:true}));
      if(mounted.current&&access.current.isCurrent())setReceipt(next);
    }catch(cause){
      if(mounted.current&&access.current.isCurrent()){
        const current=await load();
        if(mounted.current&&current?.status==='NOT_PREPARED')setError((cause as Error).message);
      }
    }finally{flight.current=false;if(mounted.current)setWorking(false);}
  }
  function downloadPackage(){
    if(!receipt?.package)return;
    try{
      requestTextDownload('shuduo-delivery-package.json',JSON.stringify(receipt.package,null,2)+'\n');
      setDownloadNotice('已请求下载此版本的交付包。');
    }catch{setDownloadNotice('未能下载，请重试。');}
  }
  const bundle=receipt?.package,verification=receipt?.verification;
  const regressions=verification?.validation?.regressions??[];
  return <section className="chat-change-delivery" aria-label="派生版本交付">
    <header><h4><PackageCheck size={16}/>派生版本交付</h4>{receipt&&<span className="chat-delivery-state" data-status={receipt.status} role="status">{labels[receipt.status]}</span>}</header>
    <p className="chat-delivery-source">代码版本 <code title={child.revisionId}>{child.revisionId.slice(0,8)}</code> · 开发批次 <code title={child.runId}>{child.runId.slice(0,8)}</code></p>
    {!receipt&&!error&&<p role="status">正在读取交付记录…</p>}
    {error&&<p role="alert">{error} <button className="button" disabled={working} onClick={()=>void load()}><RefreshCw size={13}/>重新读取交付</button></p>}
    {receipt?.status==='NOT_PREPARED'&&!error&&(canPrepare?<><p>使用此版本生成八份交付文件，并用 Spark 执行包内的加工 SQL 和测试 SQL。</p>
      <button className="button chat-prepare" disabled={working} onClick={()=>void prepare()}>{working?'正在准备交付…':'生成交付文件并演练'}</button></>:<p>此版本尚无已保存的交付包。</p>)}
    {receipt?.status==='SUCCEEDED'&&verification&&<dl className="chat-rehearsal-proof" aria-label="文件演练结果">
      <div><dt>执行引擎</dt><dd>{verification.engine} {verification.engineVersion}</dd></div>
      <div><dt>测试 SQL</dt><dd>{verification.testSqlValidation?.passed?'通过':'待核对'}</dd></div>
      <div><dt>回归场景</dt><dd>{regressions.filter(r=>r.passed).length} / {regressions.length} 通过</dd></div>
      {verification.businessDate&&<div><dt>业务日期</dt><dd>{verification.businessDate}</dd></div>}
      {verification.scheduledFor&&<div><dt>演练调度时刻（北京时间）</dt><dd>{verification.scheduledFor.replace('T',' ').replace(/\+08:00$/,'')}</dd></div>}
      {verification.executionOrder&&<div className="chat-delivery-order"><dt>演练执行顺序</dt><dd>{verification.executionOrder.map(id=>nodeLabels[id]??id).join(' → ')}</dd></div>}
    </dl>}
    {receipt&&['FAILED','CANCELLED','INTERRUPTED'].includes(receipt.status)&&<p role="status">请在派生任务中核对此次演练记录。</p>}
    {bundle&&<><DeliveryFilePreview key={bundle.id+':'+bundle.digest} bundle={bundle} current onDownload={(name,body)=>requestTextDownload(name,body,'text/plain;charset=utf-8')}/>
      <button type="button" className="button" onClick={downloadPackage}><Download size={14}/>下载版本化交付包</button>
      {downloadNotice&&<small role="status">{downloadNotice}</small>}</>}
  </section>;
}
