import {useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import AgentConsumptionPanel from './AgentConsumptionPanel';
import {InvitedServiceContract} from './InvitedServiceContract';
import {checkedBatchConsumption} from './agent-delivery-evidence-read';
import {serviceEvidencePath} from './service-source-binding';
import {applicationStatusText,serviceApplicationStatus} from './service-consumption-scope';
import {consumptionWindowOpen} from './service-consumption-window';
import {pinInvitedBatch} from './invited-task-location';
import type {InvitedStartWindow} from './invited-chat-start';
import {checkedInvitedApplications,invitedConsumptionRequestId,invitedConsumptionRequests,invitedConsumptionWritable,matchesInvitedConsumption,
  issueInvitedApplication,prepareInvitedServices,readInvitedServiceCatalog,type Api,type Original,type Source} from './invited-batch-services';
import {invitedPagePlan,runInvitedConsumptionPages} from './invited-consumption-pages';

type Props={api:Api;source:Source;batchIds:string[];access:InvitedStartWindow;verified:boolean;fund:boolean};
type History=ReturnType<typeof checkedBatchConsumption>;
type Catalog=Awaited<ReturnType<typeof readInvitedServiceCatalog>>;
type RecordState={proof:History;originals:Original[];truncated:boolean;applications:ReturnType<typeof checkedInvitedApplications>;appsTruncated:boolean;catalog?:Catalog};
const active=(app:Catalog['target'])=>app&&serviceApplicationStatus(app.application)==='ACTIVE';

export default function InvitedBatchConsumption(props:Props){
  const {source,batchIds}=props;
  const [batchId,setBatch]=useState(()=>new URL(location.href).searchParams.get('invited_batch')??batchIds[0]);
  const [working,setWorking]=useState(false);
  function select(id:string){
    history.replaceState(history.state,'',pinInvitedBatch(location.href,source.releaseId,batchIds,id));setBatch(id);
  }
  return <section className="invited-consumption" aria-label="本批次接口消费">
    <header><h4>本批次接口消费</h4><div className="invited-delivery-actions" role="group" aria-label="选择发布批次">
      {batchIds.map((id,index)=><button type="button" className="button" key={id} disabled={working} aria-pressed={batchId===id} onClick={()=>select(id)}>第 {index+1} 批</button>)}
    </div></header>
    {batchIds.includes(batchId)?<BatchRecord key={JSON.stringify([source.releaseId,batchId,props.access.consumptionScope??null])} {...props} batchId={batchId} onWorking={setWorking}/>:
      <p role="alert">原链接中的批次不属于这项发布，请选择要核对的批次。</p>}
  </section>;
}

function BatchRecord({api,source,batchIds,batchId,access,verified,fund,onWorking}:Props & {batchId:string;onWorking:(value:boolean)=>void}){
  const scope=access.consumptionScope;
  const [record,setRecord]=useState<RecordState>(),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [busy,setBusy]=useState(false),[reading,setReading]=useState(true),[confirmRevoke,setConfirmRevoke]=useState(false);
  const [confirmPages,setConfirmPages]=useState(false);
  const [observed,setObserved]=useState(0);
  const mounted=useRef(false),epoch=useRef(0),working=useRef(false),latest=useRef({access,verified});
  latest.current={access,verified};
  const matches=matchesInvitedConsumption(scope,source,batchId),target=record?.catalog?.target;
  const writable=verified&&invitedConsumptionWritable(scope,source,batchId,access);
  function assertOpen(){
    const q=new URL(location.href).searchParams;
    if(!mounted.current||!latest.current.verified||!invitedConsumptionWritable(latest.current.access.consumptionScope,source,batchId,latest.current.access)||
      q.get('invited_release')!==source.releaseId||(q.get('invited_batch')??batchIds[0])!==batchId)
      throw Error('消费窗口或所选批次已变化，请重新核对本批记录。');
  }
  const load=useCallback(async()=>{
    const stamp=++epoch.current;
    setReading(true);setError('');
    const current=()=>mounted.current&&epoch.current===stamp;
    try{
      const raw=await api<History & {agentConsumptionRequests?:unknown;agentConsumptionRequestsTruncated?:boolean;applications?:unknown;applicationsTruncated?:boolean}>(serviceEvidencePath(source)+'&release_batch_id='+batchId);
      const proof=checkedBatchConsumption(raw,source,batchId,fund);
      const originals=invitedConsumptionRequests(raw.agentConsumptionRequests??[],source,batchId);
      const applications=checkedInvitedApplications(raw.applications??[],proof.services.map(s=>s.serviceId),proof.truncated);
      let catalog:Catalog|undefined;
      if(!fund&&raw.agentConsumptionRequests!==undefined&&matches){
        try{catalog=await readInvitedServiceCatalog(api,scope,source,batchId);}
        catch(cause){if(current())setError('已保存的消费记录可查看。当前操作范围暂未核实。'+(cause as Error).message);}
      }
      if(current())setRecord({proof,originals,catalog,applications,appsTruncated:raw.applicationsTruncated===true,truncated:raw.agentConsumptionRequestsTruncated===true});
    }catch(cause){if(current()){setRecord(undefined);setError((cause as Error).message);}}
    finally{if(current())setReading(false);}
  },[api,source,batchId,fund,matches,scope]);
  useEffect(()=>{mounted.current=true;void load();return()=>{mounted.current=false;epoch.current++;};},[load,observed]);
  const refresh=()=>setObserved(v=>v+1);
  useEffect(()=>()=>onWorking(false),[onWorking]);
  async function mutate(action:'prepare'|'issue'|'pages'|'revoke'){
    if(!record?.catalog||!matches||working.current||reading)return;
    working.current=true;setBusy(true);onWorking(true);setNotice('');setError('');
    try{
      assertOpen();
      if(action==='prepare'){
        await prepareInvitedServices(api,scope,source,batchId,assertOpen);
        if(mounted.current)setNotice('本批两个 DAPI 和一个 XAPI 已测试并发布。');
      }else if(action==='issue'){
        await issueInvitedApplication(api,scope,source,batchId,assertOpen);
        if(mounted.current)setNotice('测试应用已签发，可以委托 Agent 读取固定版本。');
      }else if(action==='pages'){
        if(!confirmPages)return;
        const rows=await runInvitedConsumptionPages(api,scope,source,batchId,assertOpen,
          key=>history.replaceState(history.state,'',pinInvitedBatch(location.href,source.releaseId,batchIds,batchId,key)),
          message=>{if(mounted.current)setNotice(message);});
        if(mounted.current)setNotice('本次核验通过。DAPI 与 XAPI 各 '+invitedPagePlan(rows.length)?.totalPages+' 页、'+rows.length+' 行，均与原批结果一致。'+
          rows.slice(0,5).map(row=>row.clientId+(row.assets?' 口径内资产 '+row.assets+' 元':'')).join('，')+(rows.length>5?'（前五行）':'')+'。应用已撤销，旧凭证返回 HTTP 401（TOKEN_INVALID）。');
      }else{
        const fresh=await readInvitedServiceCatalog(api,scope,source,batchId);
        if(!confirmRevoke||!target||!fresh.grantCurrent||target.application.id!==fresh.target?.application.id||!active(fresh.target))
          throw Error('原测试应用的授权状态已变化，请刷新本批记录。');
        assertOpen();
        const revoked=await api<{id:string;status:string}>('/data-services/applications/'+target.application.id+'/revoke',{});
        if(revoked.id!==target.application.id||revoked.status!=='REVOKED')throw Error('撤销回执与原应用不符。');
        if(mounted.current)setNotice('已撤销本批测试应用。');
      }
    }catch(cause){if(mounted.current)setNotice('请按原批次核对已保存进度。'+(cause as Error).message);}
    finally{working.current=false;if(mounted.current){onWorking(false);setBusy(false);setConfirmRevoke(false);setConfirmPages(false);await load();}}
  }
  const pin=new URL(location.href).searchParams.get('invited_consume_request')??undefined;
  const currentOriginal=target?record?.originals.find(o=>o.applicationId===target.application.id):undefined;
  const selectedOriginal=pin?record?.originals.find(o=>o.requestId===pin):currentOriginal??record?.originals[0];
  const requestId=pin??selectedOriginal?.requestId;
  const {requestId:ignored,...savedInput}=selectedOriginal??{} as Original;
  const sameTarget=!selectedOriginal||target&&target.input.applicationId===selectedOriginal.applicationId&&
    target.input.dapiVersionId===selectedOriginal.dapiVersionId&&target.input.xapiVersionId===selectedOriginal.xapiVersionId;
  const sourceBinding={taskId:source.taskId,releaseId:source.releaseId,packageDigest:source.packageDigest,sourceReleaseRunId:batchId};
  async function beforeWrite(){
    assertOpen();
    if(!target||!matches||working.current)throw Error('请先核对本批已发布版本与有效测试应用。');
    const fresh=await readInvitedServiceCatalog(api,scope,source,batchId);
    if(!fresh.grantCurrent||!active(fresh.target)||JSON.stringify(target.input)!==JSON.stringify(fresh.target?.input))throw Error('授权或接口版本已变化，请刷新本批记录。');
    assertOpen();
  }
  const mayAct=writable&&!reading&&!busy;
  const versionsReady=record?.catalog?.services.filter(s=>s.status==='PUBLISHED'&&s.currentVersion?.id===s.publishedVersion?.id).length===3;
  const pages=invitedPagePlan(record?.catalog?.rowCount);
  return <>
    <p className="invited-batch-id">所选批次 <code>{batchId}</code></p>
    <button type="button" className="button" disabled={busy||reading} onClick={refresh}><RefreshCw size={14}/>刷新本批记录</button>
    {error&&<p role="alert">{error}</p>}
    {reading&&!record&&<p role="status">正在核对本批接口与调用…</p>}
    {notice&&<p role="status">{notice}</p>}
    {record&&<>
      <h5>已保存的接口与调用</h5>
      {record.proof.truncated&&<p>仅展示已读取的记录，仍有接口待核对。</p>}
      {record.truncated&&<p>原委托数量超过显示上限，可使用保存的原请求链接核对。</p>}
      {record.proof.services.length?<ul className="invited-service-records">{record.proof.services.map(s=><li key={s.serviceId+':'+s.versionId}>
        <strong>{s.serviceType} · {s.name}</strong><p>版本 <code>{s.versionId}</code></p>
        {s.status==='VERIFIED'&&s.call?.verified?<p>{s.call.coverage==='SINGLE_CUSTOMER'?'单客户授权调用':'已核对调用'} · {s.call.rowCount} 行 · {applicationStatusText(s.call.applicationStatus,true)}</p>:<p>{s.notice}</p>}
        {s.paginationCoverage?<p>分页核对 {s.paginationCoverage.verifiedPages.length} / {s.paginationCoverage.totalPages} 页 · 每页 {s.paginationCoverage.pageSize} 行 · 已核对页码 {s.paginationCoverage.verifiedPages.join('、')||'暂无'}</p>:s.call&&<p>分页记录待核对。</p>}
        {!fund&&<InvitedServiceContract service={s} batchId={batchId}/>}
      </li>)}</ul>:<p>此批次暂无已保存的接口记录。</p>}
      {record.applications.length>0&&<><h5>本批已签发应用</h5><ul className="invited-service-records">{record.applications.map(app=>
        <li key={app.applicationId}><strong>{app.name} · {applicationStatusText(app.status)}</strong><p>应用 <code>{app.applicationId}</code></p>
          <p>到期 {new Date(app.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}（北京）{app.revokedAt&&' · 撤销于 '+new Date(app.revokedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京）'}</p></li>)}</ul></>}
      {record.appsTruncated&&<p>已签发应用超过显示上限，以下仅展示已返回的记录。</p>}
      {!writable&&<p>{matches&&!consumptionWindowOpen(scope)?'该批次的消费窗口尚未开放或已到期，可查看已保存记录。':'查看本批历史记录。接口操作需要此批次的有效消费窗口。'}</p>}
      {matches&&record.catalog&&!target&&writable&&!requestId&&!record.truncated&&<>
        {!versionsReady?<><h5>准备冻结计划中的接口</h5><p>{scope.plan.dapis.map(s=>s.name).join('、')} 和 {scope.plan.xapi.name}。查询测试通过后发布固定版本。</p>
        <button type="button" className="button" disabled={!mayAct} onClick={()=>void mutate('prepare')}>准备本批接口</button></>:<>
          <h5>测试应用 · {scope.plan.applicationName}</h5>
          {pages&&[scope.plan.dapis[0],scope.plan.xapi].every(s=>s.rateLimitPerMinute>=pages.totalPages+1)?<>
            <p>Agent 将读取两个接口各一次。随后使用同一应用查询全部 {pages.total} 行，每个接口 {pages.totalPages} 页，每页上限 {pages.pageSize} 行，并用旧凭证验证撤销结果。</p>
            <label><input type="checkbox" disabled={!mayAct} checked={confirmPages} onChange={event=>setConfirmPages(event.target.checked)}/>同意签发一次、委托 Agent 查询，并在分页核验后撤销授权。</label>
            <button type="button" className="button primary" disabled={!mayAct||!confirmPages} onClick={()=>void mutate('pages')}>用短期测试应用验证{pages.totalPages===2?'两页':'一页'}并撤销</button>
          </>:<p>分页核验支持 1–100 行，并要求每个接口的限额能覆盖一次签名查询和所有分页请求。</p>}
          <details><summary>仅使用后台委托</summary><p>单独签发后可使用原应用委托 Agent 查询。一次性凭证无法重新领取。</p>
            <button type="button" className="button" disabled={!mayAct} onClick={()=>void mutate('issue')}>仅签发本批测试应用</button></details>
        </>}
      </>}
      {(requestId||target)&&<AgentConsumptionPanel key={[requestId??'',target?.application.id??''].join(':')} api={api}
        target={sameTarget?target:undefined} readOnlySelection={selectedOriginal?savedInput:undefined}
        applicationStatus={target?serviceApplicationStatus(target.application):undefined} canAct={Boolean(mayAct&&sameTarget&&active(target)&&record.catalog?.grantCurrent)}
        inChat={{requestId,source:sourceBinding,requestKey:invitedConsumptionRequestId,beforeWrite,afterRead:refresh,
          pin:key=>history.replaceState(history.state,'',pinInvitedBatch(location.href,source.releaseId,batchIds,batchId,key))}}/>}
      {record.originals.filter(o=>o.requestId!==requestId).map(({requestId,...input})=><AgentConsumptionPanel key={requestId} api={api} readOnlySelection={input}
        inChat={{requestId,source:sourceBinding,requestKey:invitedConsumptionRequestId,beforeWrite,afterRead:refresh,pin:()=>{}}}/>)}
      {target&&!record.catalog?.grantCurrent&&<p>此应用签发于另一个窗口，可查阅已保存回执。</p>}
      {target&&record.catalog?.grantCurrent&&active(target)&&writable&&<div className="invited-revoke">
        {!confirmRevoke?<button type="button" className="button" disabled={!mayAct} onClick={()=>setConfirmRevoke(true)}>撤销本批测试应用</button>:<>
          <p>撤销后，该应用立即失去调用权限，本窗口无法补发。已保存的调用记录可继续查看。</p>
          <button type="button" className="button" disabled={!mayAct} onClick={()=>void mutate('revoke')}>确认撤销</button>
          <button type="button" className="button" onClick={()=>setConfirmRevoke(false)}>保留授权</button></>}
      </div>}
    </>}
  </>;
}
