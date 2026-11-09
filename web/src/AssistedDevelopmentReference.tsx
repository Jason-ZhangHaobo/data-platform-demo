import type {AssistedDevelopmentReference as Reference} from '../../src/v2/assisted-development-reference.mjs';
export function AssistedDevelopmentReference({value}:{value:Reference}){
  const continuation=value.kind==='ASSISTED_CONTINUATION',root=continuation?value.rootReference!:value;
  return <details className="agent-assisted-reference"><summary>本次辅助开发依据 · 已绑定交付版本</summary>
    {continuation&&<><p>基于成功版本续改 · 第{value.depth}次。父版本与原始参考分别保留，新版本不继承原批准。</p><dl>
      <div><dt>父任务</dt><dd><code>{value.parentTaskId}</code></dd></div>
      <div><dt>父运行批次</dt><dd><code>{value.sourceRunId}</code></dd></div>
      <div><dt>父代码摘要</dt><dd><code>{value.sourceRevisionHash}</code></dd></div>
      <div><dt>父证据摘要</dt><dd><code>{value.parentEvidenceDigest}</code></dd></div>
    </dl></>}
    <dl><div><dt>{root.kind==='MANUAL_SUCCESS_REFERENCE'?'手工成功批次':'原失败批次'}</dt><dd><code>{root.sourceRunId}</code></dd></div>
      <div><dt>{root.kind==='MANUAL_SUCCESS_REFERENCE'?'手工代码摘要':'原代码摘要'}</dt><dd><code>{root.sourceRevisionHash}</code></dd></div>
      {root.kind==='MANUAL_SUCCESS_REFERENCE'&&<><div><dt>手工保存证据</dt><dd><code>{root.evidenceDigest}</code></dd></div>{root.originAgentTaskId&&<div><dt>原关联任务</dt><dd><code>{root.originAgentTaskId}</code></dd></div>}</>}
      {root.baselineRunId&&<><div><dt>参考基线批次</dt><dd><code>{root.baselineRunId}</code></dd></div>
        <div><dt>参考基线代码摘要</dt><dd><code>{root.baselineRevisionHash}</code></dd></div>
        <div><dt>保存证据摘要</dt><dd><code>{root.evidenceDigest}</code></dd></div></>}
    </dl><p>{root.kind==='MANUAL_SUCCESS_REFERENCE'?'手工代码是本次开发起点；新版本仍须独立核验和审阅，不继承原成功结论或批准。':'基线仅作开发参考；本次代码、文件、演练和审阅独立绑定，不继承原发布批准。'}</p>
  </details>;
}
