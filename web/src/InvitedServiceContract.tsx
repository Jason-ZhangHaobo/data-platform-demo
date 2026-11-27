import {useState} from 'react';
import {assetQueryDocument,assetQueryFieldNames,boundAssetQueryContract} from '../../src/v2/asset-query-contract.mjs';
import {requestTextDownload} from './EvidenceDownload';
import type {TaskConsumption} from './agent-journey';
import './invited-service-contract.css';

export function InvitedServiceContract({service,batchId}:{service:TaskConsumption['services'][number];batchId:string}){
  const contract=boundAssetQueryContract(service,batchId);
  const [downloaded,setDownloaded]=useState('');
  if(!contract)return null;
  const {serviceType,versionId,current,sources}=contract;
  const endpoint='/api/v2/open/'+serviceType.toLowerCase()+'s/'+contract.slug;
  const command=['curl --get "${SHUDUO_BASE_URL}'+endpoint+'"',
    '  --header "Authorization: Bearer ${SHUDUO_APP_TOKEN}"',"  --data-urlencode 'page=1'","  --data-urlencode 'page_size=1'"].join(' \\\n');
  const described=serviceType==='DAPI'?sources[0].fields:
    ['client_id',...sources.flatMap(s=>s.fields.filter(f=>f!=='client_id').map(f=>s.alias+'.'+f))];
  return <details className="invited-service-contract">
    <summary>调用文档与示例</summary>
    <p>V{contract.versionNumber} · {contract.rateLimitPerMinute} 次/分钟 · 超时 {contract.timeoutMs} 毫秒</p>
    <table><caption>返回字段</caption><thead><tr><th>字段路径</th><th>含义</th></tr></thead>
      <tbody>{described.map(field=><tr key={field}><td><code>data[].{field}</code></td><td>{assetQueryFieldNames[field.split('.').at(-1)!]}</td></tr>)}</tbody>
    </table>
    {current?<><p>调用需要有效窗口和对该版本有查询权限的应用。将站点地址设为 <code>SHUDUO_BASE_URL</code>，在调用方配置应用令牌。</p>
      <pre aria-label={serviceType+' 调用示例'} tabIndex={0}>{command}</pre>
      <p>使用 <code>page</code> 和 <code>page_size</code> 翻页，可按 <code>client_id</code> 筛选。响应中的 <code>service.versionId</code> 应为 <code>{versionId}</code>。</p>
      <button type="button" className="button" onClick={()=>{
        try{requestTextDownload(contract.slug+'-v'+contract.versionNumber+'-openapi.json',JSON.stringify(assetQueryDocument(contract,location.origin),null,2)+'\n');
          setDownloaded(versionId);}
        catch{setDownloaded('failed-'+versionId);}
      }}>下载 OpenAPI 3.1</button>
      {downloaded===versionId&&<p role="status">已请求浏览器保存此版本的 OpenAPI 文档。</p>}
      {downloaded==='failed-'+versionId&&<p role="alert">下载未确认，可再次下载同一版本。</p>}
    </>:<p>已归档版本，可查看当时的字段与配置。</p>}
  </details>;
}
