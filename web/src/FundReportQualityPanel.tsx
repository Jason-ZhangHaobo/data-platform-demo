import { useEffect, useState } from 'react';
import { fundQualityRules, readFundReportQuality, runFundReportQuality } from '../../src/v2/fund-report-quality-client.mjs';
import type { FundReportQuality } from '../../src/v2/fund-report-quality-client.mjs';
import type { PublishedReportLineage } from '../../src/v2/published-report-client.mjs';
import { reportRequestId } from '../../src/v2/published-report-request.mjs';

type Api = <T>(path: string, body?: unknown) => Promise<T>;

export function FundReportQualityPanel({ api, requestId, lineage, canWrite }: {
  api: Api; requestId: string; lineage?: PublishedReportLineage; canWrite: boolean;
}) {
  const [result, setResult] = useState<FundReportQuality>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readVersion, setReadVersion] = useState(0);
  useEffect(() => {
    let active = true;
    setError('');
    setResult(undefined);
    void readFundReportQuality({ request: path => api(path) }, { requestId, lineage }).then(
      value => { if (active) setResult(value); },
      cause => { if (active) setError((cause as Error).message); },
    );
    return () => { active = false; };
  }, [api, requestId, lineage, readVersion]);

  async function run() {
    if (!canWrite || busy || !result || result.status !== 'PENDING') return;
    setBusy(true);
    setError('');
    try {
      setResult(await runFundReportQuality({ request: (path, options) => api(path, options?.body) }, {
        requestId, snapshotId: result.snapshot.id, basisDigest: result.basisDigest, confirm: true,
      }, lineage));
    } catch {
      setResult(undefined);
      setError('检测回执尚未确认。请重新读取原回执，避免重复提交。');
    } finally { setBusy(false); }
  }

  return <section aria-label="原批次质量检测">
    {!result && !error && <p role="status">正在读取原快照和质量回执…</p>}
    {error && <p role="alert">{error}</p>}
    {result && <>
      <p>业务日 {result.businessDate} · 批次 <code title={result.source.batchId}>{result.source.batchId.slice(0, 12)}</code>
        {' · 快照 '}<code title={result.snapshot.id}>{result.snapshot.id.slice(0, 12)}</code></p>
      <small>规则版本 {result.ruleSet} · {result.snapshot.rowCount} 行</small>
      <ul>{fundQualityRules(result.businessDate).map((rule, index) => {
        const check = result.status === 'PENDING' ? undefined : result.checks[index];
        return <li key={rule.id}>{rule.name}{check && <strong> · {check.status === 'PASSED' ? '通过' : '失败'} {check.passedCount}/{check.evaluatedCount} 行</strong>}</li>;
      })}</ul>
      {result.status === 'PENDING' ? <>
        <p role="status">待检测。确认后在此快照实际运行三条规则。</p>
        <button className="button" disabled={busy || !canWrite} onClick={() => void run()}>{busy ? '正在检测…' : '确认执行本机质量检测'}</button>
      </> : <p role="status">{result.status === 'PASSED' ? '原批次检测通过' : '原批次检测未通过'} · 回执 <code title={result.checkId}>{result.checkId.slice(0, 12)}</code></p>}
    </>}
    {(result || error) && <button className="button" disabled={busy} onClick={() => setReadVersion(version => version + 1)}>重新读取质量回执</button>}
    {lineage && <a className="button" href={`?module=quality&quality_report_request=${encodeURIComponent(requestId)}`}>在数据质量中查看</a>}
  </section>;
}

export function FundReportQualityLookup({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const initial = new URLSearchParams(window.location.search).get('quality_report_request') ?? '';
  const [input, setInput] = useState(initial);
  const [requestId, setRequestId] = useState(initial);
  const [error, setError] = useState('');
  return <details className="quality-create-v2" open={initial ? true : undefined}>
    <summary>基金报表原批次检测</summary>
    <form className="report-history-form-v2" onSubmit={event => {
      event.preventDefault();
      try { setRequestId(reportRequestId(input.trim())); setError(''); }
      catch { setError('请输入原报表请求编号。'); }
    }}>
      <label>原报表请求编号<input value={input} onChange={event => setInput(event.target.value)} maxLength={36} /></label>
      <button className="button" type="submit" disabled={!input.trim()}>查看原批次质量</button>
    </form>
    {error && <p role="alert">{error}</p>}
    {requestId && <FundReportQualityPanel key={requestId} api={api} requestId={requestId} canWrite={canWrite} />}
  </details>;
}
