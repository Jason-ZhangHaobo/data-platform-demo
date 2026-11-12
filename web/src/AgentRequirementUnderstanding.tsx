import {distributionGrainLabel} from '../../src/v2/output-contract-metadata.mjs';
import {fundConstraintLabels} from '../../src/v2/fund-requirement-contract.mjs';
import React from 'react';
import {ClipboardList,ChevronDown} from 'lucide-react';
import {sqlRequirementReportMatches} from '../../src/v2/sql-requirement-contract.mjs';

const constraintLabels:Record<string,string>={SCOPED_CLIENTS:'仅限当前顾问的客户',POSITION_ID_DEDUP:'按持仓编号去重',
 SEPARATE_CASH_AGGREGATION:'现金独立聚合后关联',INCLUDE_CASH_ONLY_CLIENTS:'保留仅有现金的客户',NULL_MONEY_AS_ZERO:'空金额按零处理',
 DECIMAL_MONEY:'金额按十进制精度核算',STOCK_POSITIONS_ONLY:'仅统计股票持仓',DISTRIBUTION_COMPOSITE_KEY:'客户、交易日和分类组成唯一键',HOLDINGS_ONLY_DENOMINATOR:'占比分母为持仓市值，不含现金',UNCLASSIFIED_LABEL:'空白标签归未分类',ZERO_DIVISOR_AS_ZERO:'零分母占比为0',RATIO_SCALE_SIX:'占比0—1，六位小数',NONNEGATIVE_MARKET_VALUE:'仅支持非负市值',INDUSTRY_LABEL_NOT_LOOKTHROUGH:'行业按持仓标签，不作穿透'};
export function AgentRequirementUnderstanding({task,dirty,frozen=false}:{task:{id:string;contextId:string;message:string;revisionId?:string;language?:string;
 requirements?:unknown;attempts:unknown[];clarification?:unknown;humanClarified?:boolean;directAutonomousEligible?:boolean;clarificationOriginTaskId?:string};dirty:boolean;frozen?:boolean}){
 if(task.language==='PYTHON')return null;
 const r=task.requirements;
 if(r===undefined)return <p className="agent-requirement-note">尚无结构化需求理解记录；已登记口径可查看，旧任务不补造模型理解。</p>;
 if(!sqlRequirementReportMatches(r,task))return <p className="agent-dev-error-text" role="alert">需求理解记录与原任务、口径或代码版本未确认；不展示为理解完成，请刷新原任务。</p>;
 const clarification=r.status==='CLARIFICATION_REQUIRED',invalid=r.status==='INVALID';
 return <details className={`agent-requirement-card${frozen?' agent-requirement-frozen':''}`} open={clarification||invalid}>
  <summary><ClipboardList size={16}/><strong>{clarification?'先确认一个问题':invalid?'需求理解未确认':frozen?'此交付包冻结的需求理解':'模型如何理解这次需求'}</strong>
   <span>{clarification?'已停止计算':invalid?'未提交计算':frozen?'随包冻结':'可审阅提案'}</span><ChevronDown size={14}/></summary>
  <div className="agent-requirement-body">
   {r.humanClarified&&<p className="agent-requirement-note">此版本经过人工澄清，仍由Agent生成与核验代码；不计直接自主完成。</p>}
   {r.clarification&&<details className="agent-clarification-history"><summary>原需求与{r.clarification.depth}轮问答 · 历史占用 {r.clarification.turns.reduce((n,t)=>n+t.usedTokens,0)} Token</summary>
    <p><strong>原需求</strong>：{r.clarification.originalRequest}</p><ol>{r.clarification.turns.map((t,i)=><li key={t.taskId}>
     <strong>第{i+1}轮问题</strong><p>{t.question}</p><strong>你的回答</strong><p>{t.answer}</p>
     <small>原任务占用 {t.usedTokens} Token{t.usageEstimated?'（含估算／保留额度）':''} · <a href={`/v2/?module=agent-center&task=${t.taskId}#agent-requirement`}>查看原任务</a></small>
    </li>)}</ol><small>历史占用不转入本次计费，也不代替实际账单；原任务和批准不变。</small>
   </details>}
   {invalid?<p role="alert">{r.reason}</p>:<><p>{r.interpretation!.summary}</p>
    {clarification?<><p className="agent-requirement-question">{r.interpretation!.question}</p><small>请补充完整需求后重新委托；本条记录及模型用量保留，没有执行 SQL。</small></>:
    <><dl className="agent-requirement-basis"><div><dt>计算粒度</dt><dd>{r.basis.parameters.manager_id?"组合 / 交易日 / 资产类别":distributionGrainLabel(r.basis.grain)}</dd></div><div><dt>业务口径</dt><dd>{r.basis.contextName}</dd></div>
     <div><dt>参数范围</dt><dd>{r.basis.parameters.manager_id??r.basis.parameters.advisor_id} · {r.basis.parameters.trade_date}</dd></div></dl>
     <div className="agent-requirement-metrics">{r.interpretation!.metrics!.map(m=><div key={m.field}><strong>{r.basis.metrics.find(v=>v.field===m.field)?.label}</strong>
      <p>{m.meaning}</p><small>{m.sourceFields.join(' · ')}</small></div>)}</div>
     <ul>{r.interpretation!.constraints!.map(id=><li key={id}>{constraintLabels[id]??fundConstraintLabels[id]??id}</li>)}</ul>
     <small>第{r.attempt}次模型响应 · 代码版本 {r.revisionId?.slice(0,8)} · 口径V{r.basis.definitionVersion}</small>
     {frozen&&<small className="agent-requirement-note">依据摘要 {r.basis.digest.slice(0,12)} · 内容保存在 validation.json，随包摘要审阅；不是新的模型调用。</small>}
     <p className="agent-requirement-note">{dirty?'代码已编辑；这份理解仅对应原保存版本，不能作为当前草稿已核验的证明。':'结构及字段引用已核对；含义与代码正确性仍须查看独立结果核验，提案不等于执行通过。'}</p>
    </>}
   </>}
  </div>
 </details>;
}
