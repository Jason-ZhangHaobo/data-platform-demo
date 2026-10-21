import {AlertTriangle,CheckCircle2,Clock3,LoaderCircle} from "lucide-react";

export type LifecycleReport = {
  evaluationRunId: string;
  frozenCaseCount: number;
  completedCaseCount: number;
  succeededCaseCount: number;
  failedCaseCount: number;
  unexecutedCaseCount: number;
  localFullLifecycleRate: number;
  finalRateAvailable: boolean;
  targetMet: boolean;
  totalScheduledBatches: number;
  deploymentScope: string;
  rescuedSucceededCaseCount: number;
  evidenceChecks: {caseId:string;passed:boolean;incompleteStages:string[]}[];
};
const stageLabels:Record<string,string> = {
  requirementUnderstanding:"需求与来源",codeAndDebug:"代码与调试",scheduleFiles:"调度文件",
  deploymentFiles:"部署与演练",engineerReview:"工程师审阅",localRelease:"上线批次",postReleaseMonitoring:"上线后监控",
};
export function LifecycleEvaluationPanel({report,error,loading=false}:{report?:LifecycleReport;error?:string;loading?:boolean}) {
  if(loading)return <div className="ingestion-feedback" role="status"><LoaderCircle className="spin" size={16}/>正在核验评测报告…</div>;
  if(error)return <div className="ingestion-feedback error" role="alert"><AlertTriangle size={16}/><span>评测结果尚未核实：{error}</span></div>;
  if(!report)return null;
  const passed=report.targetMet&&report.finalRateAvailable,failed=report.evidenceChecks.filter(item=>!item.passed);
  return <section className={`ops-e2e-v2 ${passed?"verified":"pending"}`} aria-label="本机历史回放评测">
    <div className="ops-e2e-score-v2"><span>本机回放评测</span><strong>{report.succeededCaseCount}/{report.frozenCaseCount}</strong><small>{(report.localFullLifecycleRate*100).toFixed(0)}% · 固定{report.frozenCaseCount}例为分母</small></div>
    <div><span className="eyebrow">完整链路证据核对</span><h3>需求 → 代码调试 → 调度部署 → 审阅 → 上线 → 监控</h3>
      <p>已执行{report.completedCaseCount}例，未通过{report.failedCaseCount}例，未执行{report.unexecutedCaseCount}例。复用历史模型代码，包含评测执行者审阅；不计入新任务的Agent自主完成率。</p>
      <div className="ops-e2e-detours-v2"><span>{report.totalScheduledBatches}个报告批次</span><span>{report.rescuedSucceededCaseCount}例经救援后通过</span></div>
      {failed.length>0&&<details><summary>查看未通过环节</summary><ul>{failed.map(item=><li key={item.caseId}>{item.caseId}：{item.incompleteStages.length?item.incompleteStages.map(stage=>stageLabels[stage]??stage).join("、"):"案例范围或完成标记未确认"}</li>)}</ul></details>}
    </div>
    <div className="ops-e2e-boundary-v2">{passed?<CheckCircle2 size={18}/>:<Clock3 size={18}/>}<strong>{passed?"本机回放门槛通过":report.finalRateAvailable?"本机回放门槛未通过":"评测尚未完成"}</strong><span>{report.deploymentScope}</span><small>Agent完整E2E：待验收 · 公网：待验收</small><code>{report.evaluationRunId.slice(0,8)}</code></div>
  </section>;
}
