import { useEffect, useRef, useState } from "react";
import { readFundPreparation, submitFundPreparation } from "../../src/v2/fund-preparation-client.mjs";
import type { FundPreparationInput, FundPreparationReceipt } from "../../src/v2/fund-preparation-client.mjs";
import { fundConstraintLabels, fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";

type Context = { id: string; name: string; businessDate?: string };
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;

export default function FundAgentPreparation({ api, contexts, canWrite, onDirty, onExecute, executionDisabled, executionNotice, executionRequestId }: {
  api: Api; contexts: Context[]; canWrite: boolean; onDirty: (value: boolean) => void;
  onExecute: (receipt: FundPreparationReceipt) => void; executionDisabled: boolean; executionNotice?: string; executionRequestId?: string;
}) {
  const [requestId, setRequestId] = useState(() => new URLSearchParams(location.search).get("fund_prepare_request") ?? "");
  const [open, setOpen] = useState(Boolean(requestId));
  const [contextId, setContextId] = useState(contexts[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<FundPreparationReceipt>();
  const executionLinked = receipt !== undefined && receipt.requestId === executionRequestId;
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<FundPreparationInput | undefined>(undefined);
  const alive = useRef(true);
  const context = contexts.find(item => item.id === contextId);
  const contract = fundRequirementScope(contextId);
  const client = { request: (path: string, options?: { body?: unknown; idempotencyKey?: string }) =>
    api(path, options?.body, { idempotencyKey: options?.idempotencyKey }) };
  const persistId = (id: string) => {
    const url = new URL(location.href);
    if (id) url.searchParams.set("fund_prepare_request", id);
    else url.searchParams.delete("fund_prepare_request");
    history.replaceState(null, "", url);
    setRequestId(id);
  };
  const accept = (record: FundPreparationReceipt) => {
    setReceipt(record);
    setContextId(record.input.contextId);
    setMessage(record.input.message);
    setMissing(false);
    pending.current = undefined;
  };
  const lookup = async (id = requestId) => {
    setBusy(true);
    setError("");
    try {
      const record = await readFundPreparation(client, id);
      if (alive.current) accept(record);
    } catch (cause) {
      if (!alive.current) return;
      setReceipt(undefined);
      const failure = cause as Error & { status?: number };
      setMissing(failure.status === 404);
      setError(failure.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (requestId) void lookup(requestId);
    return () => { alive.current = false; onDirty(false); };
  }, []);
  useEffect(() => { onDirty(!receipt && Boolean(message.trim() || busy)); }, [receipt, message, busy, onDirty]);

  const save = async () => {
    if (!canWrite || busy || !context?.businessDate || !contract || requestId && !missing && !pending.current) return;
    const input = pending.current ?? {
      contextId, businessDate: context.businessDate, message, metrics: contract.metrics.map(metric => metric.field),
    };
    const id = requestId || crypto.randomUUID();
    pending.current = input;
    persistId(id);
    setBusy(true);
    setError("");
    try {
      const record = await submitFundPreparation(client, input, id);
      if (alive.current) accept(record);
    } catch (cause) {
      if (alive.current) {
        setMissing(false);
        setError((cause as Error).message + "。请按原编号查询或重试。");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return <details className="agent-dev-context fund-agent-preparation" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>基金需求准备</summary>
    {open && <section aria-label="基金需求准备">
      <p>选择登记交易日并保存业务需求。口径按当日组合持仓与底层权重冻结，保存后可按原编号读回。</p>
      {!receipt && <div className="fund-preparation-form">
        <label>基金交易日<select value={contextId} disabled={busy || Boolean(requestId && !missing)} onChange={event => setContextId(event.currentTarget.value)}>
          {contexts.map(item => <option key={item.id} value={item.id}>{item.businessDate}</option>)}
        </select></label>
        <label>基金需求<textarea maxLength={2000} rows={3} value={message} disabled={busy || Boolean(requestId && !missing)}
          onChange={event => setMessage(event.currentTarget.value)} placeholder="例如：按资产类别分析该日组合敞口，并保留未穿透余额。" /></label>
        <p>固定输出：{contract?.metrics.map(metric => metric.label).join("、")}</p>
        <button className="button primary" disabled={!canWrite || busy || message.trim().length < 4 || Boolean(requestId && !missing && !pending.current)}
          onClick={() => void save()}>{requestId ? "按原编号保存" : "保存基金准备"}</button>
      </div>}
      {requestId && <p>原请求 <code title={requestId}>{requestId}</code>{" "}
        <button className="button" disabled={busy} onClick={() => void lookup()}>查回原准备</button></p>}
      {busy && <p role="status">正在核对基金准备记录…</p>}
      {error && <p role="alert">{error}</p>}
      {receipt && <div className="fund-preparation-receipt">
        <header><h4>基金口径已保存</h4><span>{executionLinked ? "已关联开发任务" : "待确认开发"}</span></header>
        <p>交易日 {receipt.basis.parameters.trade_date} · 管理人 {receipt.basis.parameters.manager_id}</p>
        <div className="fund-preparation-result-grid">
          <div><h5>业务需求</h5><p>{receipt.input.message}</p>
            <p>{receipt.basis.definition}</p><small>固定输出 {receipt.basis.metrics.map(metric => metric.label).join("、")}</small>
          </div>
          <div><h5>执行约束</h5><ul>{receipt.basis.constraints.map(id => <li key={id}>{fundConstraintLabels[id]}</li>)}</ul></div>
        </div>
        <small>样例 T+1 {receipt.execution.rehearsalAt} · 口径摘要 <code title={receipt.basis.digest}>{receipt.basis.digest.slice(0, 12)}</code>
          {" · 独立断言 "}<code title={receipt.execution.assertionDigest}>{receipt.execution.assertionDigest.slice(0, 12)}</code></small>
        <footer><p>{executionLinked ? "在下方查看对应任务、SQL 和校验。" : "保存口径未调用模型。确认后可调用模型并运行本机 Spark。"}</p>
          {!executionLinked && <button className="button primary" disabled={!canWrite || busy || executionDisabled}
            onClick={() => onExecute(receipt)}>确认并生成、校验 SQL</button>}
          <button className="button" disabled={!canWrite || busy} onClick={() => {
            setReceipt(undefined); setMessage(""); setError(""); setMissing(false); persistId("");
          }}>新建基金准备</button>
        </footer>
        {!executionLinked && executionNotice && <p role="status">{executionNotice}</p>}
      </div>}
    </section>}
  </details>;
}
