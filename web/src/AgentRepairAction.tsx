import React from "react";
import { failedRunRepairAction, submitFailedRunRepair } from "./agent-repair-action";
import type { FailedRunRepairInput, RepairRequest } from "./agent-repair-action";

export function AgentRepairAction({ input, onSubmit, onExplain }: {
  input: FailedRunRepairInput;
  onSubmit: (request: RepairRequest) => Promise<void>;
  onExplain: (reason: string) => void;
}) {
  const action = failedRunRepairAction(input);
  if (!action.visible) return null;
  return <div className="agent-dev-notice" role="status">
    <div><strong>{input.taskOnly ? "在指定任务范围内继续处理" : "基于失败批次修正"}</strong>
      <p>{action.reason}</p>
      {input.taskOnly && !input.canWrite && <p>当前代码只读；查看与定位不会提交计算。</p>}
    </div>
    {input.taskOnly
      ? <a className="button" href="#agent-code">{input.canWrite ? "查看代码并人工接管" : "查看代码"}</a>
      : <button className="button" disabled={!action.request}
          onClick={() => submitFailedRunRepair(input, {submit:onSubmit,explain:onExplain})}>
          基于失败批次新建修正任务
        </button>}
  </div>;
}
