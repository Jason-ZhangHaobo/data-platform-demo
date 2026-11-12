import { useEffect, useState } from "react";
import { checkedSyncReportLineage } from "../../src/v2/published-report-client.mjs";
import type { PublishedReportReceipt, SyncReportLineage as Lineage } from "../../src/v2/published-report-client.mjs";

export function SyncReportLineage({ api, receipt }: {
  api: <T>(path: string) => Promise<T>;
  receipt: PublishedReportReceipt;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<Lineage>();
  const [error, setError] = useState("");
  const path = "/reports/published/requests/" + receipt.requestId + "/lineage";
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api(path).then(response => checkedSyncReportLineage(response, { receipt, requestId: receipt.requestId })).then(
      result => { if (active) setValue(result); },
      cause => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, receipt, open]);
  return <section className="report-lineage-v2" aria-label="冻结持仓溯源">
    <button className="button" aria-expanded={open} onClick={() => {
      setOpen(!open); setValue(undefined); setError("");
    }}>{open ? "收起冻结来源" : "核对冻结来源与授权调用"}</button>
    {open && (value ? <>
      <h4>同批次授权调用</h4>
      <p>业务日 {value.release.businessDate} · 原同步 {value.release.syncRunId.slice(0,8)} · 快照 {value.release.snapshotHash.slice(0,12)}。</p>
      <p>{value.calls.length} 条原调用已核对结果、分页和固定版本。</p>
      <ul>{value.calls.map(call => <li key={call.callId}>{call.serviceType} · 版本 {call.versionId.slice(0,8)} · {call.rowCount} 行 · 应用
        {call.applicationStatus === "REVOKED" ? "已撤销" : call.applicationStatus === "EXPIRED" ? "已过期" : "有效"}</li>)}</ul>
      <a className="button" href={"/api/v2"+path+"?download_digest="+value.digest}>下载原批次溯源 JSON</a>
      <a className="button" href={"?module=assets&asset="+encodeURIComponent(value.snapshot.assetId)}>查看原批次资产血缘</a>
    </> : error ? <p role="alert">{error}</p> : <p role="status">正在核对原批次与历史授权…</p>)}
  </section>;
}
