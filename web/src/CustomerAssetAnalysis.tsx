import {useEffect,useRef,useState} from 'react';
import {customerAnalysisCsv,displayHoldingRatio} from './customer-analysis-csv';
import {requestTextDownload} from './EvidenceDownload';
import {readCustomerAssetAnalysis, type CustomerAssetAnalysis as Analysis} from '../../src/v2/customer-asset-analysis-client.mjs';
import type {PublishedReportBinding} from '../../src/v2/published-report-request.mjs';
import './customer-asset-analysis.css';

type Input={requestId:string;source?:PublishedReportBinding;reportId:string;reportRunId:string;versionId:string;resultHash:string;reportSnapshotId?:string};
type Api=<T>(path:string)=>Promise<T>;

const money=(value:string)=>{
  const [whole,decimal]=value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+'.'+decimal;
};
function Distribution({title,groups,zero}:{title:string;groups:Analysis['customers'][number]['industries'];zero:boolean}){
  return <section className="wealth-allocation" aria-label={title}><h4>{title}</h4>
    {groups.length>0?<table><thead><tr><th scope="col">分类</th><th scope="col">市值（元）</th><th scope="col">占比</th></tr></thead>
      <tbody>{groups.map(item=><tr key={item.label}><th scope="row">{item.label}
        {!zero&&item.ratio&&<span aria-hidden="true" className="wealth-ratio-track"><i style={{width:displayHoldingRatio(item.ratio)}}/></span>}
      </th><td>{money(item.marketValue)}</td><td>{!zero&&item.ratio?displayHoldingRatio(item.ratio):'不适用'}</td></tr>)}</tbody></table>:
      <p>该客户当日无持仓分类。</p>}
  </section>;
}

function AnalysisView({analysis,title,refresh,verify,fail}:{analysis:Analysis;title:string;refresh:()=>void;verify:()=>Promise<Analysis>;fail:(message:string)=>void}){
  const attempt=useRef(0);
  useEffect(()=>()=>{attempt.current++;},[]);
  const [saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const [customerKey,setCustomerKey]=useState(analysis.customers[0]?.customerKey??'');
  const customer=analysis.customers.find(item=>item.customerKey===customerKey);
  if(!customer)return <p role="status">当前顾问范围内没有可展示的客户。</p>;
  async function download(){
    const ticket=++attempt.current;
    setSaving(true);setNotice('');
    try{
      const verified=await verify();
      if(ticket!==attempt.current)return;
      const file=customerAnalysisCsv(verified,customerKey,analysis.digest);
      requestTextDownload(file.name,file.content,'text/csv; charset=utf-8');
      setNotice('已请求保存所选客户的 CSV，可在浏览器下载中查看。');
    }catch(error){if(ticket===attempt.current)fail((error as Error).message);}
    finally{if(ticket===attempt.current)setSaving(false);}
  }
  const zero=customer.holdingMarketValue==='0.00';
  return <>
    <header className="wealth-analysis-head">
      <div><h3>{title}</h3><p>{analysis.source.businessDate} · 第 {analysis.source.sequence} 批 · MySQL 持仓归档</p></div>
      <label>客户<select aria-label="选择报表客户" value={customerKey} onChange={e=>{attempt.current++;setSaving(false);setNotice('');setCustomerKey(e.currentTarget.value);}}>
        {analysis.customers.map((item,index)=><option key={item.customerKey} value={item.customerKey}>{item.clientLabel}{analysis.customers.some((other,at)=>at!==index&&other.clientLabel===item.clientLabel)?' · '+item.customerKey.slice(0,8):''}</option>)}
      </select></label>
      <button type="button" className="button" disabled={saving} onClick={()=>void download()}>{saving?'正在核对原报表…':'导出所选客户 CSV'}</button>
    </header>
    {notice&&<p role="status">{notice}</p>}
    <div className="wealth-balance">
      <div className="wealth-total"><span>客户总资产（元）</span><strong>{money(customer.totalAssets)}</strong></div>
      <dl className="wealth-breakdown">
        <div><dt>持仓市值（元）</dt><dd>{money(customer.holdingMarketValue)}</dd></div>
        <div><dt>可用现金（元）</dt><dd>{money(customer.availableCash)}</dd></div>
        <div><dt>证券数量</dt><dd>{customer.securityCount} <small>只</small></dd></div>
      </dl>
    </div>
    <div className="wealth-allocations"><Distribution title="资产类别分布" groups={customer.assetClasses} zero={zero}/>
      <Distribution title="行业分布" groups={customer.industries} zero={zero}/></div>
    <p className="wealth-definition">{zero?'该客户当日持仓市值为零，分类占比不适用。':'两张分布表均以该客户当日持仓市值为分母。'}总资产＝持仓市值＋可用现金。行业按原持仓标签分组，证券数量按证券代码去重。</p>
    {customer.nullMarketValueCount>0&&<p role="status">{customer.nullMarketValueCount} 条持仓的市值为空，按本次登记口径计为零。</p>}
    <details className="wealth-origins"><summary>查看原批次与计算口径</summary><dl>
      <div><dt>顾问</dt><dd>{analysis.source.advisorId}</dd></div>
      <div><dt>数据源</dt><dd>MySQL 全量持仓归档</dd></div>
      <div><dt>原同步运行</dt><dd><code>{analysis.source.syncRunId}</code></dd></div>
      <div><dt>持仓快照摘要</dt><dd><code>{analysis.source.landingSnapshotHash}</code></dd></div>
      <div><dt>发布批次</dt><dd><code>{analysis.source.batchId}</code></dd></div>
      <div><dt>报表运行</dt><dd><code>{analysis.report.runId}</code></dd></div>
    </dl><button className="button" type="button" onClick={refresh}>重新核对原报表</button></details>
  </>;
}

export default function CustomerAssetAnalysis({api,selection,title="客户资产分析"}:{api:Api;selection:Input;title?:string}){
  const [read,setRead]=useState<{key:string;value?:Analysis;error?:string}>(),[refresh,setRefresh]=useState(0);
  const key=JSON.stringify(selection);
  useEffect(()=>{
    let active=true;
    setRead(undefined);
    readCustomerAssetAnalysis({request:path=>api(path)},JSON.parse(key) as Input).then(
      value=>{if(active)setRead({key,value});},
      cause=>{if(active)setRead({key,error:(cause as Error).message});}
    );
    return()=>{active=false;};
  },[key,api,refresh]);
  const value=read?.key===key?read:undefined;
  return <section className="wealth-customer-analysis" aria-label="客户持仓与分布">
    {value?.value?<AnalysisView key={value.value.digest} analysis={value.value} title={title}
      verify={()=>readCustomerAssetAnalysis({request:path=>api(path)},selection)}
      fail={error=>setRead({key,error})} refresh={()=>{setRead(undefined);setRefresh(n=>n+1);}}/>:
      value?.error?<div role="alert"><p>{value.error}</p><button type="button" className="button" onClick={()=>{setRead(undefined);setRefresh(n=>n+1);}}>重新核对原报表</button></div>:
      <p role="status">正在核对客户资产与原持仓快照…</p>}
  </section>;
}
