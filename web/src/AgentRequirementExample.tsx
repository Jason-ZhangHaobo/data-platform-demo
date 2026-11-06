import { Send } from "lucide-react";

export function AgentRequirementExample({ readOnly, disabled, example, scoped, onFill }: {
  readOnly: boolean;
  disabled: boolean;
  example: string;
  scoped: boolean;
  onFill: (message: string) => void;
}) {
  // Browsing an example must not create a draft the visitor cannot discard.
  if (readOnly) return <details className="agent-dev-example">
    <summary>查看需求示例</summary>
    <p>{example}</p>
    <small>仅说明需求写法，不创建任务或执行计算；可继续切换工作台。</small>
  </details>;
  return <button type="button" disabled={disabled} onClick={() => { if (!disabled) onFill(example); }}>
    试试：生成{scoped ? "当前口径" : "客户资产"}加工 SQL <Send size={13} />
  </button>;
}
