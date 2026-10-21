import React from "react";
import { deliveryReviewRequirements, reviewAttestationsComplete } from "./delivery-presentation";

export function AgentPublicationReview({ cloud, packageDigest, revisionId, runId, verificationId, confirmed, disabled, onConfirm, onPublish, onCancel }: {
  cloud: boolean; packageDigest: string; revisionId?: string; runId?: string; verificationId?: string;
  confirmed: Record<string, boolean>; disabled: boolean;
  onConfirm: (id: string, checked: boolean) => void; onPublish: () => void; onCancel: () => void;
}) {
  const requirements = deliveryReviewRequirements(cloud);
  const count = requirements.filter(item => confirmed[item.id] === true).length;
  return <section className="agent-review-form" aria-label="审阅指定版本">
    <div><h4>发布前确认</h4><p>本次只提交下面这个版本。不会自动代批，不会开放公网或创建生产发布。</p></div>
    <dl className="delivery-review-source"><dt>发布范围</dt><dd>{cloud ? "私有云测试 · 两个冻结样例批次" : "本机测试 · 两个批次"}</dd><dt>代码版本</dt><dd>{revisionId ?? "未确认"}</dd><dt>源运行批次</dt><dd>{runId ?? "未确认"}</dd><dt>文件演练编号</dt><dd>{verificationId ?? "未确认"}</dd><dt>交付包摘要</dt><dd>{packageDigest}</dd></dl>
    {requirements.map(item => <div className="delivery-review-item" key={item.id}><label><input type="checkbox" disabled={disabled} checked={confirmed[item.id] === true} onChange={event => onConfirm(item.id, event.target.checked)} />{item.label}</label><a href={`#${item.target}`}>查看依据</a></div>)}
    <small>{count} / {requirements.length} 项已确认；仅查看文件不会自动勾选。代码、交付包或演练记录变化后需要重新审阅。</small>
    <div className="agent-delivery-actions"><button type="button" className="button primary" disabled={disabled || !revisionId || !runId || !verificationId || !reviewAttestationsComplete(confirmed, cloud)} onClick={onPublish}>确认并发布此版本</button><button type="button" className="button" disabled={disabled} onClick={onCancel}>暂不发布</button></div>
  </section>;
}
