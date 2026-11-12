import { useEffect, useRef, useState } from "react";
import { agentCallHistoryHref, readAgentCallHistory } from "./agent-call-history";
import { applicationStatusText } from "./service-consumption-scope";
import { currentAgentTaskLocation } from "./service-source-binding";

type Reader = <T>(path: string) => Promise<T>;
type HistoryEntry = Awaited<ReturnType<typeof readAgentCallHistory>>;

export function AgentCallHistoryLink({taskId, release, packageDigest, batch, callId}: {
  taskId: string; release: string; packageDigest: string; batch: string; callId: string;
}) {
  const [href, setHref] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    agentCallHistoryHref(location.href, {taskId, release, package: packageDigest, batch}, callId)
      .then(value => { if (active) setHref(value); }, () => { if (active) setNotice("原调用链接暂不可用。"); });
    return () => { active = false; };
  }, [taskId, release, packageDigest, batch, callId]);
  return <div>
    {href && <>
      <a className="button" href={href} target="_blank" rel="noopener noreferrer" aria-label={"查看原调用 " + callId.slice(0, 8)}>查看原调用</a>{" "}
      <button className="button" type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(href); setNotice("已复制原调用链接。"); }
        catch { setNotice("可通过「查看原调用」的链接菜单复制地址。"); }
      }}>复制原调用链接</button>
    </>}
    {notice && <small role="status">{notice}</small>}
  </div>;
}

export function AgentCallHistory({api, target, loading, onLogin}: {
  api: Reader; target: Parameters<typeof readAgentCallHistory>[1] | null; loading: boolean; onLogin: () => void;
}) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{entry?: HistoryEntry; error?: "AUTH" | "UNCONFIRMED"}>({});
  const reader = useRef(api); reader.current = api;
  const selection = useRef(target);
  useEffect(() => {
    if (!selection.current || loading) return;
    let active = true;
    setState({});
    readAgentCallHistory(reader.current, selection.current).then(
      entry => { if (active) setState({entry}); },
      (error: {status?: number}) => { if (active) setState({error: error?.status === 401 ? "AUTH" : "UNCONFIRMED"}); },
    );
    return () => { active = false; };
  }, [loading, retry]);
  const entry = state.entry, call = entry?.call;
  const back = target ? currentAgentTaskLocation(location.href, target.taskId).href : "/v2/?module=agent-center";
  return <section id="agent-call-history" className="agent-delivery-panel agent-call-history" aria-labelledby="agent-call-history-title">
    <div className="agent-workflow-title"><h3 id="agent-call-history-title">原调用核验</h3></div>
    {target === null ? <p role="alert">原调用链接不完整或与当前任务不一致。</p>
      : state.error === "AUTH" ? <><p role="status">请先用原任务所属账号登录。</p><button className="button" type="button" onClick={onLogin}>受邀账号登录</button></>
      : state.error ? <p role="alert">无法核验原调用，请确认已用原任务账号登录，并从原发布重新打开链接。</p>
      : !entry || !call ? <p role="status">正在核对原调用与发布批次…</p>
      : <>
        <p role="status">原调用核验通过 · {applicationStatusText(call.applicationStatus, true)}</p>
        <dl>
          <dt>接口</dt><dd>{entry.serviceType} · {entry.name}</dd>
          <dt>调用与版本</dt><dd>{call.callId.slice(0, 8)} · 版本 {entry.versionId.slice(0, 8)}</dd>
          <dt>发布与批次</dt><dd>{target.release.slice(0, 8)} · 批次 {target.batch.slice(0, 8)}</dd>
          <dt>结果</dt><dd>{call.rowCount} 行 · 摘要 {call.resultHash.slice(0, 12)}</dd>
        </dl>
      </>}
    <div className="agent-delivery-actions">
      {target && (state.entry || state.error === "UNCONFIRMED") && <button className="button" type="button" onClick={() => setRetry(value => value + 1)}>重新核对原调用</button>}
      <a className="button" href={back}>返回任务工作台</a>
    </div>
  </section>;
}
