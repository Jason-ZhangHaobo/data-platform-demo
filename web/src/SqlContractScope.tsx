import { Database } from "lucide-react";

export function SqlContractScope({ title, definition, industry, onAgent, onDelivery }: {
  title: string;
  definition: string;
  industry: boolean;
  onAgent?: () => void;
  onDelivery?: () => void;
}) {
  return (
    <aside className="agent-panel distribution-scope-card">
      <header><Database size={18} /><strong>{title}</strong></header>
      <div className="distribution-scope-content">
        <small className="distribution-scope-status">本机 · 经典 SQL</small>
        <p>{definition}</p>
        <div className="distribution-grain">
          <span>{onAgent ? "客户" : "组合"}</span><span>交易日</span>
          <span>{industry ? "行业标签" : "资产类别"}</span>
        </div>
        <div className="distribution-scope-next">
          {onAgent ? <button className="button" onClick={onAgent}>进入 Data Agent</button>
            : <><p>当前支持本机文件演练和经审批的测试调度。Agent 与接口消费待接入。</p>
                <button className="button" disabled={!onDelivery} onClick={onDelivery}>准备本机文件演练</button></>}
        </div>
      </div>
    </aside>
  );
}
