import {useEffect, useRef, useState} from "react";
import {opsPublicationTarget, readOpsPublication} from "./ops-publication";

type Api = <T>(path: string) => Promise<T>;
type Evidence = Awaited<ReturnType<typeof readOpsPublication>>;
const statuses: Record<string,string> = {
  WAITING_SCHEDULER:"等待调度", RUNNING_CLOUD_TEST:"运行中", ACTIVE_CLOUD_TEST:"已开始执行",
  COMPLETED_CLOUD_TEST:"已结算", SCHEDULED:"等待调度", RUNNING:"运行中", SUCCEEDED:"成功",
  FAILED:"失败", VALIDATION_FAILED:"校验失败", CANCELLED:"已停止", PENDING:"等待运行",
  OBSERVING:"观察中", HEALTHY:"健康", CRITICAL:"有告警", RECOVERED_WITH_FAILURE:"有失败记录", STOPPED:"已停止",
};
const label = (value?: string) => (value && statuses[value]) || "状态待确认";

export function OpsPublicationPanel({api}: {api: Api}) {
  const location = window.location.href;
  const target = opsPublicationTarget(location);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([location, revision]);
  const [response, setResponse] = useState<{key:string; evidence?:Evidence}>();
  const current = response?.key === key ? response : undefined;
  const request = useRef(api);
  request.current = api;
  useEffect(() => {
    if (!target) return;
    let active = true;
    readOpsPublication(request.current, target).then(
      evidence => { if (active) setResponse({key, evidence}); },
      () => { if (active) setResponse({key}); },
    );
    return () => { active = false; };
  }, [key]);
  if (target === undefined) return null;
  const evidence = current?.evidence;
  return <section id="ops-exact-publication" className="ops-live-evaluation-v2" aria-labelledby="ops-exact-publication-title">
    <header>
      <div><h3 id="ops-exact-publication-title">原发布批次</h3><p>私有测试记录 · 只读核对同一发布与代码版本</p></div>
      {target && <button className="button" disabled={!current} onClick={() => setRevision(value => value + 1)}>重新读取批次</button>}
    </header>
    {target === null ? <p role="alert">发布定位信息不完整，请从原任务的发布记录打开。</p>
      : !current ? <p role="status">正在核对原发布与两个批次…</p>
      : !evidence ? <p role="alert">原发布记录暂未确认，请核对当前账号和发布来源后重新读取。</p>
      : <>
        <div className="ops-live-table-v2">
          <table aria-label="确切发布批次">
            <caption>发布 {target.releaseId} · 代码版本 {target.revisionId}</caption>
            <thead><tr><th scope="col">原批次编号</th><th scope="col">保存状态</th><th scope="col">调度状态</th></tr></thead>
            <tbody>{evidence.batches.map(batch => <tr key={batch.id}>
              <th scope="row">第 {batch.sequence} 批 <small>{batch.id}</small></th>
              <td>{label(batch.status)}</td><td>{batch.schedulerTriggered ? "已触发" : "未触发"}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p>发布 {label(evidence.status)} · 监控 {label(evidence.health)}</p>
        <a href={"/v2/?module=agent-center&task=" + target.taskId + "#agent-publication"}>查看原任务的发布证据</a>
      </>}
  </section>;
}
