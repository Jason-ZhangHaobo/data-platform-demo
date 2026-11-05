import React from "react";
import {validationDetailsView,validationFieldLabels,validationMismatchCells} from "./validation-details";
import type {ValidationDetailSource} from "./validation-details";
import "./validation-details.css";

export function ValidationDetails({details,expectedSource,dirty=false,historical=false}: {
  details?:unknown;expectedSource:ValidationDetailSource;dirty?:boolean;historical?:boolean;
}) {
  const view=validationDetailsView(details,expectedSource),failed=view.scenarios.filter(scenario=>!scenario.passed);
  return <section className="validation-details" aria-label="独立核验差异">
    <h4>独立核验差异</h4>
    {dirty&&<p className="validation-details-warning" role="status">代码有未保存修改；以下证据只属于已保存版本，不代表当前草稿。</p>}
    {historical&&<p className="validation-details-warning" role="status">以下为原报告的历史证据，不是当前编辑版本的核验结论。</p>}
    {view.status==="LEGACY_UNAVAILABLE"?<p>该历史批次未保存差值；不从当前结果推测其他回归场景，也不会自动重新执行。</p>
      :view.status==="UNVERIFIED"?<p role="status">差异证据的来源或格式尚未核对，暂不显示数值。请先确认当前批次、代码版本与业务口径。</p>
      :<><p className="validation-details-source">批次 {expectedSource.runId} · 版本 {expectedSource.revisionId} · 口径 {expectedSource.contextId}。预期来自独立断言，实际值来自各场景的执行回执，不是当前结果表的复制。</p>
        {!failed.length?<p>此回执没有失败场景差异；完整通过结论仍以上方核验项为准。</p>:failed.map(scenario=><details className="validation-details-scenario" key={scenario.contextId} open>
          <summary><strong>{scenario.name}</strong><span>未通过</span></summary>
          <small>场景：{scenario.contextId}</small>
          {scenario.detailsStatus==="LEGACY_UNAVAILABLE"?<p>该历史批次未保存差值。</p>
            :scenario.detailsStatus==="INVALID"?<p role="status">此场景的差异明细尚未核对，不显示数值；保留原未通过结论。</p>
            :<>{scenario.mismatches.length?<table className="validation-details-table"><caption>{scenario.name} · 独立预期与实际执行对照</caption><thead><tr><th scope="col">差异项／客户</th><th scope="col">独立预期</th><th scope="col">实际执行</th></tr></thead><tbody>
              {scenario.mismatches.map((item,index)=>{const cell=validationMismatchCells(item);return <tr key={index}><th scope="row"><span>{cell.label}</span>{item.field&&<span>{validationFieldLabels[item.field]}</span>}{item.clientId&&<small>{item.clientId}</small>}</th><td>{cell.expected}</td><td>{cell.actual}</td></tr>;})}
            </tbody></table>:<p>未保存可展示的字段差值；原未通过结论仍保留。</p>}
            {scenario.truncated&&<p className="validation-details-warning" role="status">差异已截断：展示 {scenario.mismatches.length} / {scenario.totalMismatches} 项，不代表完整明细。</p>}</>}
        </details>)}</>}
  </section>;
}

export function ValidationResultScope({contextId,contextName,runId,revisionId,dirty=false}: {
  contextId?:string;contextName?:string;runId:string;revisionId?:string;dirty?:boolean;
}) {
  return <div className="validation-result-scope" role="note"><strong>当前结果所属场景：{contextName??contextId??"历史记录未声明场景"}</strong>
    <p>此表仅展示该场景的执行结果；失败回归场景的独立差异请查看“校验”。</p>
    <small>批次 {runId} · 已保存版本 {revisionId??"未确认"}</small>
    {dirty&&<p>当前草稿已修改，以上结果不是草稿的新执行结果。</p>}
  </div>;
}
