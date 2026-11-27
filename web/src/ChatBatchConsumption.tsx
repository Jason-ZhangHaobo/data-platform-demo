import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {readChatChangeConsumption,type ChatChangeConsumptionReceipt} from '../../src/v2/chat-change-consumption-client.mjs';
import type {ChatChangePublicationReceipt,ChatPublicationRun} from '../../src/v2/chat-change-publication-client.mjs';
import {ChatBatchConsumptionResult} from './ChatBatchConsumptionResult';
import {serviceHandoffLocation} from './service-source-binding';
import type {ChangeApi} from './chat-context-change';

type Props={api:ChangeApi;publication:ChatChangePublicationReceipt;batch:ChatPublicationRun;onClose:()=>void};
type Read={key:string;receipt:ChatChangeConsumptionReceipt}|{key:string;error:string};

export default function ChatBatchConsumption({api,publication,batch,onClose}:Props){
  const [attempt,setAttempt]=useState(0),[read,setRead]=useState<Read>();
  const heading=useRef<HTMLHeadingElement>(null);
  const releaseId=publication.release!.id;
  const key=[publication.intentId,publication.changeRequestId,releaseId,batch.id,publication.packageDigest,attempt].join(':');
  const current=read?.key===key?read:undefined;
  useEffect(()=>{
    const frame=requestAnimationFrame(()=>{
      heading.current?.focus({preventScroll:true});
      heading.current?.scrollIntoView({block:'nearest'});
    });
    return ()=>cancelAnimationFrame(frame);
  },[batch.id]);
  useEffect(()=>{
    let active=true;
    setRead(undefined);
    const input={
      intentId:publication.intentId,changeRequestId:publication.changeRequestId,releaseId,batchId:batch.id,
      sequence:batch.sequence,sourceRunId:publication.source.runId,expectedSource:publication.source,
      expectedParent:publication.parent,packageId:publication.packageId,packageDigest:publication.packageDigest,verificationId:publication.verificationId,
    };
    if (publication.monitoringVerified&&batch.status==='SUCCEEDED'&&!batch.resultUnknown){
      readChatChangeConsumption({request:path=>api(path)},input).then(receipt=>{
        if (receipt.batch.rowCount!==undefined&&receipt.batch.rowCount!==batch.rowCount) throw Error('消费来源与本批发布结果不一致，请重新核对。');
        if(active)setRead({key,receipt});
      }).catch(e=>{if(active)setRead({key,error:(e as Error).message});});
    }
    return ()=>{active=false;};
  },[api,key,publication,batch,releaseId]);

  let href:string|undefined;
  if(current&&'receipt' in current){
    const {source,packageDigest}=current.receipt;
    const url=serviceHandoffLocation(location.href,{sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',
      taskId:source.taskId,revisionId:source.revisionId,runId:source.runId,releaseId,packageDigest});
    url.searchParams.set('release_batch',batch.id);
    href=url.href;
  }
  return <section id="chat-consumption-panel" className="chat-batch-consumption" aria-label="批次接口消费">
    <header><h4 ref={heading} tabIndex={-1}>第 {batch.sequence} 批 · 接口消费</h4>
      <button type="button" className="button" disabled={!current} onClick={()=>setAttempt(n=>n+1)}>
        <RefreshCw size={13}/>重新核对
      </button>
    </header>
    {!current?<p role="status">正在核对本批接口版本和历史调用…</p>
      :'error' in current?<p role="alert">{current.error}</p>
      :<ChatBatchConsumptionResult receipt={current.receipt}/>}
    <div className="chat-change-buttons">
      {href&&<a className="button" href={href}>在数据服务中查看本批</a>}
      <button type="button" className="button" onClick={onClose}>返回批次监控</button>
    </div>
  </section>;
}
