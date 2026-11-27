import { deliveryReviewRequirements, reviewAttestationsComplete } from "./delivery-presentation";
import type { ChatChangePublicationReceipt as Receipt } from "../../src/v2/chat-change-publication-client.mjs";

const batchState:Record<string,string>={
  SCHEDULED:"等待调度",RUNNING:"正在执行",SUCCEEDED:"已完成",FAILED:"失败",VALIDATION_FAILED:"断言未通过",CANCELLED:"已取消",INTERRUPTED:"已中断",
};
const eventState:Record<string,string>={
  BATCH_SUCCEEDED:"批次成功",BATCH_FAILED:"批次失败",BATCH_CANCELLED:"批次已取消",BATCH_STARTED:"批次开始执行",
  RELEASE_ACTIVATED:"发布已启用",BATCH_RESULT_UNKNOWN:"批次结果待确认",ALERT_RECOVERED:"告警已恢复",
};
const localTime=(value:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',
  hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));

function VersionSource({value}:{value:Receipt}){
  return <dl className="chat-release-identifiers">
    <div><dt>代码版本</dt><dd><code>{value.source.revisionId}</code></dd></div>
    <div><dt>开发批次</dt><dd><code>{value.source.runId}</code></dd></div>
    <div><dt>文件演练</dt><dd><code>{value.verificationId}</code></dd></div>
    <div><dt>交付包 SHA-256</dt><dd><code>{value.packageDigest}</code></dd></div>
    <div><dt>审阅摘要</dt><dd><code>{value.reviewDigest}</code></dd></div>
  </dl>;
}

export function ChatPublicationReview({value,checked,busy,onCheck,onPublish,onCancel}:{
  value:Receipt;checked:Record<string,boolean>;busy:boolean;onCheck:(id:string,v:boolean)=>void;onPublish:()=>void;onCancel:()=>void;
}){
  const ready=reviewAttestationsComplete(checked,false,true);
  const spec=value.scheduleSpec;
  return <fieldset aria-label="确认测试发布范围" className="chat-release-review" disabled={busy||!value.canPublish}>
    <legend>审阅测试发布</legend>
    <p>两批均处理 <strong>{value.businessDate}</strong> 的冻结样例。调度配置为首批延时 {spec.triggerAfterSeconds} 秒、批次间隔 {spec.intervalSeconds} 秒。</p>
    <VersionSource value={value}/>
    {deliveryReviewRequirements(false,true).map(item=><label key={item.id}>
      <input type="checkbox" checked={checked[item.id]===true} onChange={e=>onCheck(item.id,e.target.checked)}/><span>{item.label}</span>
    </label>)}
    <div className="chat-change-buttons"><button type="button" className="button" disabled={!ready||busy||!value.canPublish} onClick={onPublish}>
      {busy?'正在登记发布…':'确认并发布两批本机测试'}</button>
      <button type="button" className="button" disabled={busy} onClick={onCancel}>暂不发布</button>
    </div>
  </fieldset>;
}

export function ChatPublicationMonitor({value,selectedBatchId,onChooseBatch}:{value:Receipt;selectedBatchId?:string|null;onChooseBatch?:(batchId:string)=>void}){
  const release=value.release;
  if(!release)return null;
  const attention=value.runs.some(run=>run.resultUnknown||['FAILED','VALIDATION_FAILED','INTERRUPTED'].includes(run.status))||
    value.alerts.some(alert=>alert.status==='OPEN');
  const pending=value.runs.some(run=>['SCHEDULED','RUNNING'].includes(run.status)&&!run.resultUnknown);
  const title=value.monitoringVerified?'两批运行与监控已核验':attention?'有批次或告警需要核对':pending?'两批测试进行中':'批次监控待核对';
  return <section className="chat-release-monitor" aria-label="两批运行监控">
    <header><strong role="status">{title}</strong><small>业务日 {value.businessDate}</small></header>
    <ol className="chat-release-batches">{value.runs.map(run=><li key={run.id} data-status={run.resultUnknown?'UNKNOWN':run.status}>
      <div><strong>第 {run.sequence} 批</strong><span>{run.resultUnknown?'执行结果待核对':batchState[run.status]??run.status}</span></div>
      <dl>
        {run.triggeredAt?<div><dt>实际触发</dt><dd>{localTime(run.triggeredAt)} 北京时间</dd></div>:
          <div><dt>计划触发</dt><dd>{localTime(run.scheduledTriggerAt)} 北京时间</dd></div>}
        {run.finishedAt&&<div><dt>结束时间</dt><dd>{localTime(run.finishedAt)} 北京时间</dd></div>}
        {run.schedulerTriggered&&<div><dt>触发方式</dt><dd>本机调度器</dd></div>}
        {run.engine&&<div><dt>执行引擎</dt><dd>{run.engine} {run.engineVersion}</dd></div>}
        {run.status==='SUCCEEDED'&&!run.resultUnknown&&<>
          {run.testSqlPassed&&<div><dt>测试 SQL</dt><dd>通过</dd></div>}
          {run.assertionCount!==undefined&&<div><dt>独立断言</dt><dd>{run.assertionCount} 项通过</dd></div>}
          {run.rowCount!==undefined&&<div><dt>结果行数</dt><dd>{run.rowCount} 行</dd></div>}
          {run.totalAssets!==undefined&&<div><dt>口径内资产合计</dt><dd>{run.totalAssets} 元</dd></div>}
        </>}
      </dl>
      {value.monitoringVerified&&run.status==='SUCCEEDED'&&onChooseBatch&&<button type="button" className="button chat-consumption-open"
        id={'chat-consumption-open-'+run.id} aria-expanded={selectedBatchId===run.id} aria-controls="chat-consumption-panel" onClick={()=>onChooseBatch(run.id)}>
        {selectedBatchId===run.id?'收起':'查看'}第 {run.sequence} 批接口消费</button>}
    </li>)}</ol>
    <details><summary>查看监控事件和发布依据</summary>
      <p>监控事件 {value.events.length} 条 · 开放告警 {value.alerts.filter(a=>a.status==='OPEN').length} 条</p>
      {value.events.length>0&&<ul className="chat-release-events">{value.events.map(e=>{
        const seq=value.runs.find(r=>r.id===e.releaseRunId)?.sequence;
        return <li key={e.id}>{seq!==undefined?'第 '+seq+' 批 · ':''}{eventState[e.type]??e.type}<time dateTime={e.observedAt}>{localTime(e.observedAt)}</time></li>;
      })}</ul>}
      {value.alerts.length>0&&<ul className="chat-release-events">{value.alerts.map(a=><li key={a.id}>告警 {a.id.slice(0,8)} · {a.status==='OPEN'?'待处理':a.status==='RESOLVED'?'已解决':a.status}</li>)}</ul>}
      <dl className="chat-release-identifiers">
        {value.reviewActorScope&&<div><dt>审阅身份</dt><dd>{value.reviewActorScope==='LOCAL_DEVELOPER'?'本机开发者':'已登录项目成员'}</dd></div>}
        {value.reviewId&&<div><dt>版本审阅</dt><dd><code>{value.reviewId}</code></dd></div>}
        {value.approvalId&&<div><dt>批准编号</dt><dd><code>{value.approvalId}</code></dd></div>}
        <div><dt>发布编号</dt><dd><code>{release.id}</code></dd></div>
        {value.runs.map(run=><div key={run.id}><dt>第 {run.sequence} 批编号</dt><dd><code>{run.id}</code></dd></div>)}
      </dl>
      <VersionSource value={value}/>
    </details>
  </section>;
}
