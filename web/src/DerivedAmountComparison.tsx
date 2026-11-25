import { useEffect, useId, useRef, useState } from "react";
import { checkedDerivedComparison, type DerivedRunReference, type DerivedResultComparison } from "../../src/v2/derived-comparison-client.mjs";
import "./derived-amount-comparison.css";

type Props = {
  api:(path:string)=>Promise<unknown>; parent:DerivedRunReference; child:DerivedRunReference;
};
type Matched = Extract<DerivedResultComparison,{state:"MATCHED"}>;

const metricLabels = {
  total_assets:"口径内资产（元）", holding_market_value:"持仓市值（元）",
  available_cash:"可用现金（元）", security_count:"证券数量（只）"
} as const;
const metricKeys = Object.keys(metricLabels) as (keyof typeof metricLabels)[];
const reasons:Record<string,string> = {
  CHILD_RUNNING:"新口径仍在运行，完成核验后可以刷新。",
  NOT_DERIVED:"当前任务缺少已登记的口径变更来源。",
  UNSUPPORTED_GRAIN:"两次运行的输出粒度暂不支持逐客户对照。",
  SCOPE_CHANGED:"两次运行的顾问范围或业务日期不同。",
  SOURCE_UNCONFIRMED:"原口径的运行证据尚未核验。",
  CHILD_UNCONFIRMED:"新口径的运行证据尚未核验。",
  INVALID_ROWS:"运行结果存在重复客户或无效数值。",
  CUSTOMER_SCOPE_CHANGED:"两次运行包含的客户不同，暂时无法逐客对照。"
};

function signedDelta(value:string|number) {
  const text = String(value);
  return text === "0" || text === "0.00" || text.startsWith("-") ? text : "+" + text;
}

function AmountTable({caption,values}:{caption:string;values:Matched["totals"]}) {
  return <div className="derived-amount-table-scroll"><table className="derived-amount-table">
    <caption>{caption}</caption>
    <thead><tr><th scope="col">指标</th><th scope="col">原口径</th><th scope="col">新口径</th><th scope="col">差额</th></tr></thead>
    <tbody>{metricKeys.map(key=><tr key={key}>
      <th scope="row">{metricLabels[key]}</th>
      <td>{values.before[key]}</td><td>{values.after[key]}</td><td>{signedDelta(values.delta[key])}</td>
    </tr>)}</tbody>
  </table></div>;
}

function RunSource({label,source}:{label:string;source:Matched["parent"]}) {
  return <div><dt>{label} · {source.contextName}</dt><dd><span>运行编号</span><code>{source.runId}</code></dd></div>;
}

export function DerivedAmountReport({report}:{report:DerivedResultComparison}) {
  const [page,setPage]=useState(0);
  if(report.state !== "MATCHED") {
    return <p className="derived-amount-status" role="status">{reasons[report.reason] ?? "两次运行的金额尚未核验。"}</p>;
  }
  const pageSize=5;
  const pages=Math.ceil(report.rows.length/pageSize);
  const activePage=Math.max(0,Math.min(page,pages-1));
  return <>
    <p className="derived-amount-context"><strong>原口径</strong> {report.parent.contextName}<br/><strong>新口径</strong> {report.child.contextName}</p>
    <details className="derived-amount-sources"><summary>查看运行来源</summary><dl>
      <RunSource label="原口径" source={report.parent}/><RunSource label="新口径" source={report.child}/>
    </dl></details>
    <AmountTable caption="客户合计" values={report.totals}/>
    <p className="derived-amount-note">差额为新口径减原口径。合计中的证券数量为各客户证券数量之和。</p>
    {report.rows.slice(activePage*pageSize,(activePage+1)*pageSize).map(row=><AmountTable key={row.clientId} caption={`客户 ${row.clientId}`} values={row}/>)}
    {pages>1&&<nav aria-label="客户明细分页" className="derived-amount-pages">
      <button type="button" className="button" disabled={activePage===0} onClick={()=>setPage(activePage-1)}>上一页</button>
      <span aria-live="polite">{activePage+1} / {pages} 页 · {report.rows.length} 位客户</span>
      <button type="button" className="button" disabled={activePage+1>=pages} onClick={()=>setPage(activePage+1)}>下一页</button>
    </nav>}
  </>;
}

type ReadState = {stage:"CLOSED"|"LOADING"|"ERROR"}|{stage:"READY";report:DerivedResultComparison};

function Reader({api,parent,child}:Props) {
  const [read,setRead] = useState<ReadState>({stage:"CLOSED"});
  const request = useRef(0);
  const id = useId();
  useEffect(()=>()=>{request.current++;},[]);
  const open = read.stage !== "CLOSED";
  async function load() {
    const sequence = ++request.current;
    setRead({stage:"LOADING"});
    try {
      const value = await api(`/agent/tasks/${encodeURIComponent(child.taskId)}/derivation-comparison`);
      const report = checkedDerivedComparison(value,{taskId:child.taskId,parent,child});
      if(request.current === sequence) setRead({stage:"READY",report});
    } catch {
      if(request.current === sequence) setRead({stage:"ERROR"});
    }
  }
  function close() {
    request.current++;
    setRead({stage:"CLOSED"});
  }
  return <section className="derived-amount-panel" aria-label="派生口径金额对照">
    <div className="derived-amount-toolbar"><h4>派生口径金额对照</h4>
      <button type="button" className="button" aria-controls={id} aria-expanded={open} onClick={open?close:load}>{open?"收起对照":"查看金额对照"}</button>
    </div>
    <div id={id} hidden={!open}>
      {read.stage==="LOADING"&&<p className="derived-amount-status" role="status">正在读取两次运行的已保存结果…</p>}
      {read.stage==="ERROR"&&<p className="derived-amount-status" role="alert">未能读取或核验当前检查点。请确认账号仍有查看权限，再刷新对照。</p>}
      {read.stage==="READY"&&<DerivedAmountReport report={read.report}/>}
      {open&&<button type="button" className="button" disabled={read.stage==="LOADING"} onClick={load}>刷新对照</button>}
    </div>
  </section>;
}

export default function DerivedAmountComparison(props:Props) {
  const checkpointKey=(value:DerivedRunReference)=>[value.taskId,value.revisionId,value.revisionHash,value.runId,value.contextId,value.validationContractId];
  return <Reader key={JSON.stringify([checkpointKey(props.parent),checkpointKey(props.child)])} {...props}/>;
}
