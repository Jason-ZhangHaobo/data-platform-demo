import {useEffect, useState} from "react";
import {batchServiceHistoryHref, batchServiceHistoryTarget, publicationBatchReportHref, publicationMonitorHref, readOpsPublication} from "./ops-publication";
import {checkedBatchConsumption} from "./agent-delivery-evidence-read";
import {serviceEvidencePath,serviceHandoffLocation} from "./service-source-binding";
import {applicationStatusText} from "./service-consumption-scope";
import "./agent-development.css";

type Reader = <T>(path:string)=>Promise<T>;

export default function BatchServiceHistory({api,workspaceAvailable}:{api:Reader;workspaceAvailable:boolean}) {
  const href=window.location.href;
  const target=batchServiceHistoryTarget(href);
  const [refresh,setRefresh]=useState(0);
  const [state,setState]=useState<{href:string;refresh:number;value?:ReturnType<typeof checkedBatchConsumption>;error?:string}>();
  const current=state?.href===href&&state.refresh===refresh?state:undefined;
  useEffect(()=>{
    const selected=batchServiceHistoryTarget(href);
    if(!selected) return;
    let active=true;
    const load=async()=>{
      const {publication,batchId,binding}=selected;
      const monitor=await readOpsPublication(api,publication);
      if(!active) return;
      if(!monitor.monitoringVerified)throw Error("原发布的两个批次与监控事件尚未核对。");
      const response=await api(serviceEvidencePath(binding)+"&release_batch_id="+encodeURIComponent(batchId));
      if(active)setState({href,refresh,value:checkedBatchConsumption(response,binding,batchId)});
    };
    void load().catch(error=>{if(active)setState({href,refresh,error:error instanceof Error?error.message:"读取失败"});});
    return ()=>{active=false;};
  },[api,href,refresh]);
  const services=current?.value?.services;
  return <section id="release-batch-consumption" className="agent-delivery-panel" aria-label="原批次授权调用">
    <header><strong>原批次授权调用</strong></header>
    {!target ? <p role="alert">批次定位信息不完整，请从原发布重新打开。</p> : <>
      <div className="agent-delivery-actions">
        {[target.publication.firstBatchId,target.publication.secondBatchId].map((id,index)=>
          id===target.batchId?<strong key={id} aria-current="page">第 {index+1} 批</strong>:
            <a key={id} className="button" href={batchServiceHistoryHref(target.publication,id)}>查看第 {index+1} 批</a>)}
        <button className="button" type="button" disabled={!current} onClick={()=>setRefresh(value=>value+1)}>重新核对</button>
      </div>
      <dl className="delivery-review-source"><dt>发布编号</dt><dd>{target.publication.releaseId}</dd><dt>调度批次</dt><dd>{target.batchId}</dd></dl>
      {!current ? <p role="status">正在核对原发布、批次与授权调用…</p> : current.error ? <p role="alert">{current.error}</p> : <>
        <p role="status">已核对所选发布与批次 · 只读历史</p>
        {current.value?.truncated&&<p>记录超过读取上限，以下仅显示已返回的记录。</p>}
        {services?.length ? <ul className="agent-dev-attempts">{services.map(service=><li key={service.serviceId}>
          <strong>{service.serviceType} · {service.name}</strong>
          <code>版本 {service.versionId}</code>
          {service.status==="VERIFIED" && service.call?.verified ? <span>调用 {service.call.callId} · {service.call.rowCount} 行 · {applicationStatusText(service.call.applicationStatus,true)}</span> : <span>{service.notice}</span>}
        </li>)}</ul> : <p>此批次暂无已保存的接口记录。</p>}
      </>}
      <div className="agent-delivery-actions">
        <a className="button" href={publicationMonitorHref(target.publication,true)}>返回原发布</a>
        <a className="button" href={publicationMonitorHref(target.publication)}>返回运维</a>
        {current?.value && <a className="button" href={publicationBatchReportHref(target.publication,target.batchId)}>查看本批次报表</a>}
        {current?.value && workspaceAvailable && <a className="button" href={batchWorkspaceHref(href,target)}>打开本批次接口工作区</a>}
      </div>
    </>}
  </section>;
}

function batchWorkspaceHref(href:string,target:NonNullable<ReturnType<typeof batchServiceHistoryTarget>>) {
  const url=serviceHandoffLocation(href,target.binding);
  url.searchParams.set("release_batch",target.batchId);
  return url.href;
}
