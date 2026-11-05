import React from "react";

export function AgentModelRecovery({stage, consent, disabled, onConsent}: {
  stage?: string; consent: boolean; disabled: boolean; onConsent: (value: boolean) => void;
}) {
  if (stage === "MODEL_NOT_SENT") return <div className="agent-dev-notice" role="status">
    <div><strong>本次模型请求未发送</strong><p>请先修复上方诊断指出的配置、上下文或预算条件，再点击“修复后重试原任务”或“修复后恢复后台”。页面刷新不会重试；再次执行将实际发送模型请求，可能产生费用。</p>
      <small>原任务、尝试次数及预算预留保留；这不代表历史未知调用的费用已核清。</small></div>
  </div>;
  if (stage === "MODEL_OUTCOME_UNKNOWN") return <label className="agent-dev-consent">
    <input type="checkbox" checked={consent} disabled={disabled} onChange={event => onConsent(event.target.checked)} />
    上次模型结果未知，可能已产生费用。我确认在剩余预算内再次调用。
  </label>;
  return null;
}
