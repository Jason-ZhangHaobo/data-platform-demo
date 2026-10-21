import React, { useState } from "react";
import { Download, FileText } from "lucide-react";
import { deliveryFilePresentation } from "./delivery-presentation";

export function DeliveryFilePreview({ bundle, current, onDownload }: {
  bundle: { id: string; digest: string; files: Record<string, string> };
  current: boolean;
  onDownload: (name: string, value: string) => void;
}) {
  const [selected, setSelected] = useState("schedule.json");
  const [notice, setNotice] = useState("");
  const { entries, active, missing } = deliveryFilePresentation(bundle.files, selected);
  return <section className="delivery-file-browser" aria-label="交付文件预览">
    <header className="delivery-file-heading"><div><strong>{current ? "当前版本交付文件" : "历史交付文件 · 仅供对照"}</strong><small>{entries.length} 份文件 · 只读预览，修改代码后需重新核验和生成交付</small></div></header>
    {missing.length > 0 && <p role="alert" className="agent-dev-error-text">交付文件缺失或为空：{missing.join("、")}。不能据此确认完整交付。</p>}
    <div className="delivery-file-layout">
      <nav aria-label="选择交付文件">{entries.map(entry => <button type="button" key={entry.name} aria-pressed={entry.name === active?.name} onClick={() => { setSelected(entry.name); setNotice(""); }}><FileText size={15} /><span><strong>{entry.label}</strong><small>{entry.name}</small></span></button>)}</nav>
      <div className="delivery-file-content">{active ? <>
        <div className="delivery-file-toolbar"><div><strong>{active.name}</strong><p>{active.purpose}</p></div><button type="button" className="button" onClick={() => {
          try { onDownload(active.name.replace(/[^a-zA-Z0-9._-]/g, "_"), bundle.files[active.name]); setNotice("已请求保存此文件，请核对浏览器下载列表；这不会执行或发布任务。"); }
          catch { setNotice("未确认下载成功；文件内容已保留，可重试。不会重新生成交付包。"); }
        }}><Download size={14} />下载此文件</button></div>
        {notice && <p role="status">{notice}</p>}
        <pre className="agent-delivery-file" tabIndex={0} aria-label={`${active.name} 内容`}>{bundle.files[active.name] || "此文件为空，不能用于完整交付。"}</pre>
      </> : <p className="agent-dev-empty">该交付包没有可预览的文件；请先核对交付记录，不会自动重新计算。</p>}</div>
    </div>
    <details className="delivery-version-details"><summary>版本与来源标识</summary><dl><dt>交付包编号</dt><dd>{bundle.id}</dd><dt>完整包摘要</dt><dd>{bundle.digest}</dd></dl><small>标识用于对照来源；显示摘要本身不代表已完成完整性校验或发布审批。</small></details>
  </section>;
}
