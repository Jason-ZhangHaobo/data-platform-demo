import {useEffect,useState} from 'react';
import {PublishedReportCreator} from './PublishedReportCreator';
import {wealthReportTarget,type WealthReportTarget} from './native-report-location';
import {serviceSourcesPath,sourceRunEligible,sourceRunMatches} from './service-source-binding';
import {lookupPublishedReport,type PublishedReportReceipt} from '../../src/v2/published-report-client.mjs';
import {readSyncSqlOutputSchema} from '../../src/v2/sync-sql-output-schema-client.mjs';
import CustomerAssetAnalysis from './CustomerAssetAnalysis';

type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type Props={api:Api;canCreate:boolean;local:boolean};
type Candidate=Parameters<typeof sourceRunMatches>[0]&{sequence:number;sourceEvidence?:{
  protocol?:string;snapshotHash?:string;metadataVersionId?:string;syncRunId?:string;businessDate?:string}};

function OriginalReport({api,target,requestId}:{api:Api;target:WealthReportTarget;requestId:string}){
  const [state,setState]=useState<{receipt?:PublishedReportReceipt;error?:string}>(),[retry,setRetry]=useState(0);
  const sourceKey=JSON.stringify(target.source);
  useEffect(()=>{
    let active=true;setState(undefined);
    lookupPublishedReport({request:path=>api(path)},{requestId,source:JSON.parse(sourceKey)}).then(
      receipt=>{if(active)setState({receipt});},cause=>{if(active)setState({error:(cause as Error).message});}
    );
    return()=>{active=false;};
  },[sourceKey,api,requestId,retry]);
  if(state?.error) return <section role="alert"><p>{state.error}</p><button className="button" onClick={()=>{setState(undefined);setRetry(v=>v+1);}}>重新读取原请求</button></section>;
  if(!state?.receipt)return <p role="status">正在核对原报表运行…</p>;
  const r=state.receipt;
  if(r.status!=='SUCCEEDED'||!r.reportId||!r.reportRunId||!r.reportVersionId||!r.resultHash||!r.snapshotId)
    return <p role="status">原报表尚未生成完整结果。<a href={'?module=agent-center&report_request='+encodeURIComponent(requestId)}>查看原请求</a></p>;
  return <CustomerAssetAnalysis title={r.name} api={api} selection={{requestId:r.requestId,source:r.source,reportId:r.reportId,reportRunId:r.reportRunId,
    versionId:r.reportVersionId,resultHash:r.resultHash,reportSnapshotId:r.snapshotId}}/>;
}

function BatchReport({api,canCreate,target}:{api:Api;canCreate:boolean;target:WealthReportTarget}){
  const [requestId,setRequestId]=useState(target.requestId),[source,setSource]=useState<{batch?:Candidate;error?:string}>(),[retry,setRetry]=useState(0);
  const bindingKey=JSON.stringify(target.binding),batchId=target.source.batchId;
  useEffect(()=>{
    let active=true;setSource(undefined);
    async function verify(){
      const binding=JSON.parse(bindingKey) as WealthReportTarget['binding'];
      const [runs,schema]=await Promise.all([api<Candidate[]>(serviceSourcesPath(binding)),
        readSyncSqlOutputSchema({request:path=>api(path)},{runId:binding.runId!})]);
      if(!Array.isArray(runs)||!runs.every(run=>sourceRunMatches(run,binding)))throw Error('发布来源未能核对，请返回原批次。');
      const matching=runs.filter(run=>run.id===batchId && sourceRunEligible(run));
      const batch=matching[0],e=batch?.sourceEvidence;
      if(matching.length!==1||![1,2].includes(batch.sequence)||!e||e.protocol!=='shuduo-sync-sql-consumption-source/v1'||
        schema.status!=='MATCHED'||schema.source.revisionId!==binding.revisionId||schema.source.snapshotHash!==e.snapshotHash||
        schema.inputMetadata?.sourceType!=='SERVER_MYSQL'||schema.inputMetadata.syncRunId!==e.syncRunId||
        schema.inputMetadata.frozen.metadataVersionId!==e.metadataVersionId)throw Error('指定批次或原 MySQL 快照尚未核对。');
      if(active)setSource({batch});
    }
    verify().catch(cause=>{if(active)setSource({error:(cause as Error).message});});
    return()=>{active=false;};
  },[api,bindingKey,batchId,retry]);
  const ready=source?.batch;
  return <section className="wealth-batch-report" aria-label="按发布批次生成资产报表">{(!ready||!requestId)&&<header><h2>财富顾问资产分析报表</h2>
    {ready&&<p>{ready.sourceEvidence?.businessDate} · 第 {ready.sequence} 批 · MySQL 持仓归档</p>}</header>}
    {source?.error?<section role="alert"><p>{source.error}</p><button type="button" className="button" onClick={()=>{setSource(undefined);setRetry(n=>n+1);}}>重新核对指定批次</button></section>:
     !ready?<p role="status">正在核对指定批次与原持仓快照…</p>:requestId?<OriginalReport key={requestId} api={api} target={target} requestId={requestId}/>:
     <PublishedReportCreator pinnedBatch api={api} canCreate={canCreate} defaultName="客户资产分析报表"
       source={{kind:'AGENT',taskId:target.source.taskId,releaseId:target.source.releaseId,packageDigest:target.source.packageDigest,
         revisionId:target.source.revisionId,runId:target.source.runId,batchIds:[batchId]}}
       onCreated={receipt=>{
         const url=new URL(window.location.href);url.searchParams.set('report_request',receipt.requestId);
         history.replaceState(null,'',url.pathname+url.search+url.hash);setRequestId(receipt.requestId);
       }}/>}
  </section>;
}

export default function BatchWealthReport({api,canCreate,local}:Props){
  const target=wealthReportTarget(window.location.href);
  if(!target||!local) return <section role="alert"><p>{!target?'原批次定位信息不完整，请从对应发布的监控页重新打开。':'已保存的 MySQL 持仓报表仅在本机工作台可用。'}</p></section>;
  return <BatchReport key={JSON.stringify(target.source)} target={target} api={api} canCreate={canCreate}/>;
}
