import {useEffect, useMemo, useRef, useState} from "react";
import {batchArchiveListPath, listBatchArchives, prepareBatchArchive, readBatchArchive, submitBatchArchive} from "../../src/v2/private-batch-archive-client.mjs";
import type {ArchiveIndex, BatchArchive, ReviewedBatchArchive} from "../../src/v2/private-batch-archive-client.mjs";
import type {PrivateBatchSummary} from "../../src/v2/private-batch-report-client.mjs";
import type {PublishedReportBinding} from "../../src/v2/published-report-request.mjs";

type Api = <T>(path: string, body?: unknown, options?: {idempotencyKey?: string}) => Promise<T>;
type Pending = {requestId: string; reviewedDigest: string};
const savedKey = (index: ArchiveIndex, source: PublishedReportBinding) => "shuduo:batch-archive:" + index.actorId + ":" + batchArchiveListPath(source);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function OpsBatchArchivePanel({api, source, summary}: {api: Api; source: PublishedReportBinding; summary?: PrivateBatchSummary}) {
  const client = useMemo(() => ({request:(path: string, options?: {body?: unknown; idempotencyKey?: string}) =>
    api<unknown>(path, options?.body, {idempotencyKey:options?.idempotencyKey})}), [api]);
  const [index, setIndex] = useState<ArchiveIndex>();
  const [pending, setPending] = useState<Pending>();
  const [confirmedMissing, setConfirmedMissing] = useState(false);
  const [archive, setArchive] = useState<BatchArchive>();
  const [title, setTitle] = useState("");
  const [requirement, setRequirement] = useState("");
  const [reviewed, setReviewed] = useState<ReviewedBatchArchive>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [boundClient, setBoundClient] = useState(client);
  if (boundClient !== client) {
    setBoundClient(client); setIndex(undefined); setArchive(undefined); setPending(undefined); setConfirmedMissing(false);
    setReviewed(undefined); setTitle(""); setRequirement(""); setNotice(""); setBusy(false);
  }
  const generation = useRef(0);
  const active = useRef(false);
  const remember = (state: ArchiveIndex, value?: Pending) => {
    try {
      if (value) localStorage.setItem(savedKey(state, source), JSON.stringify(value));
      else localStorage.removeItem(savedKey(state, source));
    } catch { /* The server archive list remains available after a restart. */ }
  };
  useEffect(() => {
    const current = ++generation.current;
    listBatchArchives(client, source).then(state => {
      if (generation.current !== current) return;
      setIndex(state);
      try {
        const value = JSON.parse(localStorage.getItem(savedKey(state, source)) ?? "null");
        if (value && uuid.test(value.requestId) && /^[a-f0-9]{64}$/.test(value.reviewedDigest)) setPending(value);
      } catch { /* Recover saved archives through the server list. */ }
    }, (error: Error) => { if (generation.current === current) setNotice(error.message); });
    return () => { generation.current++; };
  }, [client, source, reload]);

  const run = async (action: (current: () => boolean) => Promise<void>) => {
    if (active.current) return;
    active.current = true;
    const token = generation.current, current = () => token === generation.current;
    setBusy(true); setNotice("");
    try { await action(current); }
    catch (error) { if (current()) setNotice((error as Error).message); }
    finally { active.current = false; if (current()) setBusy(false); }
  };
  const accept = (record: BatchArchive, state: ArchiveIndex) => {
    setArchive(record);
    const {review, reportVersion, digest} = record;
    const entry = {requestId:review.requestId, title:review.draft.title, reportVersion, reviewedAt:review.reviewedAt, digest};
    setIndex({...state, entries:[entry, ...state.entries.filter(item => item.requestId !== review.requestId)]
      .sort((a, b) => b.reportVersion - a.reportVersion).slice(0, 20)});
    if (pending?.requestId === record.review.requestId) {
      remember(state); setPending(undefined); setConfirmedMissing(false);
    }
  };
  const lookup = (requestId: string, reviewedDigest?: string) => void run(async current => {
    if (!index) return;
    setConfirmedMissing(false);
    try {
      const record = await readBatchArchive(client, {requestId, source,
        reviewedDigest:reviewedDigest ?? (pending?.requestId === requestId ? pending.reviewedDigest : undefined)});
      if (current()) accept(record, index);
    } catch (error) {
      if (current() && pending?.requestId === requestId &&
          (error as {code?: string}).code === "BATCH_REPORT_ARCHIVE_NOT_FOUND") setConfirmedMissing(true);
      throw error;
    }
  });
  const prepare = () => void run(async current => {
    if (!summary) return;
    const value = await prepareBatchArchive({source, summaryDigest:summary.digest, title, requirement});
    if (current()) setReviewed(value);
  });
  const submit = () => void run(async current => {
    if (!index?.canArchive || !reviewed || !summary || reviewed.draft.summaryDigest !== summary.digest ||
        (pending && (!confirmedMissing || pending.reviewedDigest !== reviewed.reviewedDigest))) return;
    const request = pending ?? {requestId:crypto.randomUUID(), reviewedDigest:reviewed.reviewedDigest};
    setPending(request); remember(index, request); setConfirmedMissing(false);
    let record: BatchArchive;
    try {
      record = await submitBatchArchive(client, {...reviewed, requestId:request.requestId});
    } catch (error) {
      if (current() && (error as {code?: string}).code === "BATCH_REPORT_SUMMARY_CHANGED") {
        remember(index); setPending(undefined); setReviewed(undefined);
      }
      throw error;
    }
    if (!current()) return;
    remember(index); setPending(undefined); setReviewed(undefined); setTitle(""); setRequirement(""); accept(record, index);
    setNotice("已归档固定报表版本。");
  });

  return <section className="ops-live-evaluation-v2 published-report-create-v2" aria-label="报表方案审阅与版本归档">
    <header><div><h4>报表方案审阅与版本归档</h4><p>保留原需求、审阅摘要及已核验的三个汇总指标</p></div></header>
    {!index && !notice && <p role="status">正在读取原批次的归档…</p>}
    {!index && notice && <button className="button" disabled={busy} onClick={() => {setNotice(""); setReload(value => value + 1);}}>重读归档</button>}
    {index && <>
      {index.entries.length === 0 && <p>此批次暂无已归档报表。</p>}
      {index.entries.map(entry => <p key={entry.requestId}>
        <button className="button" disabled={busy} onClick={() => lookup(entry.requestId)}>查看 V{entry.reportVersion} · {entry.title}</button>
      </p>)}
      {pending && <div><p>待核对原请求 {pending.requestId}</p>
        <button className="button" disabled={busy} onClick={() => lookup(pending.requestId, pending.reviewedDigest)}>核对原归档请求</button>
        {confirmedMissing && <p>服务端暂无此请求。填写相同名称和需求后，可按原编号重试。</p>}
      </div>}
      {index.canArchive && summary && (!pending || confirmedMissing) && <>
        <div className="published-report-form-v2">
          <label>归档名称 <input value={title} maxLength={80} disabled={busy} onChange={event => {setTitle(event.target.value); setReviewed(undefined);}}/></label>
          <label>报表需求 <textarea rows={3} value={requirement} maxLength={1000} disabled={busy} onChange={event => {setRequirement(event.target.value); setReviewed(undefined);}}/></label>
          <button className="button" disabled={busy || title.trim().length < 2 || requirement.trim().length < 4} onClick={prepare}>审阅归档方案</button>
        </div>
        {reviewed && reviewed.draft.summaryDigest === summary.digest && <div className="source-report-proposal-v2">
          <p><strong>{reviewed.draft.title}</strong> · {reviewed.draft.requirement}</p>
          <p>{summary.metrics.map(metric => metric.title + " " + metric.value).join(" · ")}</p>
          <p>批次 {source.batchId} · 汇总摘要 {summary.digest}</p>
          <p>审阅摘要 {reviewed.reviewedDigest}</p>
          <button className="button" disabled={busy || Boolean(pending && pending.reviewedDigest !== reviewed.reviewedDigest)} onClick={submit}>确认归档此方案</button>
        </div>}
      </>}
      {!index.canArchive && <p>当前可查看已归档版本。</p>}
    </>}
    {archive && <div className="source-report-proposal-v2">
      <h5>V{archive.reportVersion} · {archive.review.draft.title}</h5>
      <p>{archive.review.draft.requirement}</p>
      <p>审阅时间 <time dateTime={archive.review.reviewedAt}>{new Date(archive.review.reviewedAt).toLocaleString("zh-CN")}</time></p>
      {archive.summary.metrics.map(metric => <p key={metric.id}>{metric.title} {metric.value}</p>)}
      <p>审阅摘要 {archive.review.reviewedDigest}</p>
      <a className="button" href={"/api/v2/reports/published/batch-archives/" + archive.review.requestId + "?download_digest=" + archive.digest}>下载归档溯源 JSON</a>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
