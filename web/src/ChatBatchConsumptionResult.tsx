import type {ChatChangeConsumptionReceipt,ChatConsumptionService} from '../../src/v2/chat-change-consumption-client.mjs';
import {applicationStatusText} from './service-consumption-scope';

const fieldNames:Record<string,string>={client_id:'客户编号',holding_market_value:'持仓市值',available_cash:'可用现金',total_assets:'口径内资产',security_count:'证券数量'};
const time=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});

function ServiceVersion({service,services}:{service:ChatConsumptionService;services:ChatConsumptionService[]}){
  const s=service,{call,pagination}=s;
  const sourceName=(id:string,version:string)=>services.find(v=>v.serviceId===id&&v.versionId===version)?.name;
  const referenced=services.some(v=>v.serviceType==='XAPI'&&v.sourceVersions.some(ref=>ref.serviceId===s.serviceId&&ref.versionId===s.versionId));
  const fields=s.serviceType==='DAPI'?s.sourceVersions[0]?.fields:[];
  return <li className="chat-consumption-service">
    <header><small>{s.serviceType}</small><strong>{s.name}</strong><span>V{s.versionNumber} · {s.versionStatus==='PUBLISHED'?'已发布':'历史版本'}</span></header>
    {s.versionStatus==='PUBLISHED'&&<code className="chat-consumption-endpoint">GET /api/v2/open/{s.serviceType.toLowerCase()}s/{s.slug}</code>}
    {fields?.length?<p>返回字段 · {fields.map(field=>fieldNames[field]??field).join('、')}</p>:null}
    {s.serviceType==='XAPI'&&<p>固定子版本 · {s.sourceVersions.map(ref=>
      (sourceName(ref.serviceId,ref.versionId)??'DAPI')+'（'+ref.versionId.slice(0,8)+'）').join('、')}</p>}
    {call?<dl className="chat-consumption-summary">
      <div><dt>成功调用</dt><dd>本次返回 {call.rowCount} 行</dd></div>
      <div><dt>调用应用</dt><dd>{applicationStatusText(call.applicationStatus,true)}</dd></div>
    </dl>:<p>{referenced?'已被组合 XAPI 引用。':''}暂无本版本已核对的成功直调记录。</p>}
    {pagination?<dl className="chat-consumption-summary">
      <div><dt>分页核对</dt><dd>{pagination.status==='COMPLETE'?'已齐备':'部分已核对'} · {pagination.verifiedPages.length}/{pagination.totalPages} 页</dd></div>
      <div><dt>已核对页码</dt><dd>{pagination.verifiedPages.join('、')||'待核对'} · 每页 {pagination.pageSize} 行</dd></div>
      {pagination.applicationId!==call?.applicationId&&<div><dt>分页调用应用</dt><dd>{applicationStatusText(pagination.applicationStatus,true)}</dd></div>}
    </dl>:call&&<p>分页记录待核对。</p>}
    <details><summary>查看版本与调用依据</summary>
      <dl className="chat-release-identifiers">
        <div><dt>接口版本</dt><dd><code>{s.versionId}</code></dd></div>
        <div><dt>配置摘要</dt><dd><code>{s.configHash}</code></dd></div>
        {call&&<>
          <div><dt>调用时间</dt><dd><time dateTime={call.finishedAt}>{time.format(new Date(call.finishedAt))} 北京时间</time></dd></div>
          <div><dt>调用编号摘要</dt><dd><code>{call.callIdDigest}</code></dd></div>
          <div><dt>结果摘要</dt><dd><code>{call.resultHash}</code></dd></div>
          <div><dt>调用应用编号</dt><dd><code>{call.applicationId}</code></dd></div>
        </>}
        {pagination&&pagination.applicationId!==call?.applicationId&&<div><dt>分页应用编号</dt><dd><code>{pagination.applicationId}</code></dd></div>}
      </dl>
    </details>
  </li>;
}

export function ChatBatchConsumptionResult({receipt}:{receipt:ChatChangeConsumptionReceipt}){
  return <>
    <p className="chat-consumption-status" role="status"><strong>{receipt.status==='MATCHED_ONLY'?'本批消费记录已匹配':'本批消费证据待补齐'}</strong>
      <span>核对范围为本机保存的接口版本、调用和应用授权。</span></p>
    {receipt.truncated&&<p role="status">记录超过查询上限，以下仅展示已读取的版本和调用。</p>}
    {receipt.services.length?<ul className="chat-consumption-services">{receipt.services.map(s=>
      <ServiceVersion key={s.serviceId+':'+s.versionId} service={s} services={receipt.services}/>)}</ul>
      :<p>尚未找到绑定本批结果的已发布接口版本。</p>}
  </>;
}
