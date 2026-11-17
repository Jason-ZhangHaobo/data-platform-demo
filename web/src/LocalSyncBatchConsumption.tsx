import {useEffect,useState} from "react";
import {checkedLocalSyncBatchConsumption} from "./agent-delivery-evidence-read";
import {serviceEvidencePath} from "./service-source-binding";
import type {ServiceSourceBinding} from "./service-source-binding";
import {applicationStatusText} from "./service-consumption-scope";

type Api = <T>(path:string)=>Promise<T>;

export function LocalSyncBatchConsumption({api,binding,batchId,snapshotHash,sequence}:{
  api:Api;binding:ServiceSourceBinding;batchId:string;snapshotHash:string;sequence:number;
}) {
  const [open,setOpen]=useState(false);
  const [result,setResult]=useState<ReturnType<typeof checkedLocalSyncBatchConsumption>>();
  const [error,setError]=useState("");
  const path=serviceEvidencePath(binding)+"&release_batch_id="+encodeURIComponent(batchId);
  useEffect(()=>{
    if(!open)return;
    let active=true;
    setResult(undefined);
    setError("");
    void api<unknown>(path).then(value=>checkedLocalSyncBatchConsumption(value,binding,batchId,snapshotHash,sequence))
      .then(value=>{if(active)setResult(value);})
      .catch(cause=>{if(active)setError((cause as Error).message);});
    return ()=>{active=false;};
  },[api,path,snapshotHash,sequence,open]);
  return <>
    <button className="button" type="button" aria-expanded={open} aria-label={`核对第 ${sequence} 批授权消费`}
      onClick={()=>setOpen(!open)}>{open?"收起授权消费":"查看本批授权消费"}</button>
    {open&&<section className="monitor-context-v2" aria-label={`第 ${sequence} 批授权消费证据`}>
      {error?<span role="alert">{error}</span>:!result?<span role="status">正在核对原监控事件与授权调用…</span>:<>
        <p>监控事件 <code>{String(result.monitor.eventId).slice(0,8)}</code> · 业务日 {String(result.monitor.businessDate)}</p>
        <strong role="status">{result.proof.status==="VERIFIED"?"本批 DAPI 与 XAPI 消费已核验":"本批消费待核验"}</strong>
        {!result.proof.services.length&&<p>该批次暂无可核对的历史调用。</p>}
        {result.proof.services.map(service=><p key={service.serviceId+":"+service.versionId}>
          <span>{service.serviceType} · {service.name}</span><code>{service.versionStatus==="RETIRED"?"退役版本":"版本"} {service.versionId.slice(0,8)}</code>
          {service.status==="VERIFIED"&&service.call?.verified?<small>
            {service.call.coverage==="SINGLE_CUSTOMER"&&"单客户授权 · "}调用 {service.call.callId.slice(0,8)} · {service.call.rowCount} 行 · {applicationStatusText(service.call.applicationStatus,true)}
          </small>:<small>{service.notice}</small>}
        </p>)}
      </>}
    </section>}
  </>;
}
