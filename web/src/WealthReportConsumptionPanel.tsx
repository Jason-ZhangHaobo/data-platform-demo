import { useEffect, useState } from 'react';
import { readWealthConsumption } from '../../src/v2/wealth-report-consumption-client.mjs';
import type { WealthReportConsumption } from '../../src/v2/wealth-report-consumption-client.mjs';

type Run = { id: string; reportVersionId: string; resultHash: string };
type Response = { key: string; value?: WealthReportConsumption; error?: string };
const fieldLabels: Record<string, string> = {
  client_id: '客户编号', holding_market_value: '持仓市值', available_cash: '可用现金',
  total_assets: '资产口径合计', security_count: '证券数量',
};
const applicationLabels = { ACTIVE: '应用有效', EXPIRED: '应用已到期', REVOKED: '应用已撤销' };

export default function WealthReportConsumptionPanel({ api, reportId, runs }: {
  api: <T>(path: string) => Promise<T>; reportId: string; runs: Run[];
}) {
  const [open, setOpen] = useState(false), [selectedId, setSelectedId] = useState('');
  const [response, setResponse] = useState<Response>(), [readVersion, setReadVersion] = useState(0);
  const selected = runs.find(run => run.id === selectedId) ?? runs[0];
  const runId = selected?.id, versionId = selected?.reportVersionId, resultHash = selected?.resultHash;
  const key = JSON.stringify([reportId, runId, versionId, resultHash]);
  useEffect(() => {
    if (!open || !runId) return;
    let active = true;
    void readWealthConsumption({ request: path => api(path) }, { reportId, runId, versionId, resultHash }).then(
      value => { if (active) setResponse({ key, value }); },
      cause => { if (active) setResponse({ key, error: (cause as Error).message }); },
    );
    return () => { active = false; };
  }, [api, open, reportId, runId, versionId, resultHash, key, readVersion]);
  const current = response?.key === key ? response : undefined;
  const value = current?.value;
  if (!runs.length) return null;

  return <details className="report-development-v2" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) setResponse(undefined);
  }}>
    <summary>回看报表授权消费</summary>
    {open && <section aria-label="财富管理报表授权消费">
      {runs.length > 1 && <label>选择要核对的报表运行<select value={runId} onChange={event => {
        setResponse(undefined); setSelectedId(event.target.value);
      }}>{runs.map(run => <option key={run.id} value={run.id}>{run.id.slice(0, 12)} · 版本 {run.reportVersionId.slice(0, 8)}</option>)}</select></label>}
      {!current && <p role="status">正在核对原发布批次和授权回执…</p>}
      {current?.error && <p role="alert">{current.error}</p>}
      {value && <>
        <p>{value.context.name} · 工程师编写 · 本机历史证据</p>
        <p>报表运行 <code title={value.report.runId}>{value.report.runId.slice(0, 12)}</code>
          {' · 发布批次 '}<code title={value.source.batchId}>{value.source.batchId.slice(0, 12)}</code>
          {' · 快照 '}<code title={value.snapshot.id}>{value.snapshot.id.slice(0, 12)}</code></p>
        <p role="status">{value.status === 'VERIFIED' ? '原批次 DAPI 与 XAPI 已核对完整分页' :
          value.status === 'UNCONFIRMED' ? '存在未确认回执，原批次消费核验尚未通过' : '原批次尚缺完整的授权调用分页'}
          {' · '}{value.verifiedCalls} 条已核对回执</p>
        {value.unconfirmedCalls > 0 && <p>{value.unconfirmedCalls} 条历史回执未确认。</p>}
        {value.truncated && <p>本次核对最近 100 条同批调用。</p>}
        {value.services.map(service => <details key={service.versionId}>
          <summary>{service.type} · V{service.versionNumber} · {service.fields.map(field => fieldLabels[field] ?? field).join('、')}
            {' · '}{service.calls.length} 条回执</summary>
          <small>固定版本 <code title={service.versionId}>{service.versionId.slice(0, 12)}</code>
            {service.childVersionIds.length > 0 && <> · 子版本 {service.childVersionIds.map(id => id.slice(0, 8)).join('、')}</>}</small>
          <ul>{service.calls.map(call => <li key={call.callId}>第 {call.page} 页 · {call.rowCount} 行 · {applicationLabels[call.applicationStatus]}
            {' · '}<code title={call.callId}>{call.callId.slice(0, 8)}</code></li>)}</ul>
        </details>)}
      </>}
      {current && <button className="button" onClick={() => { setResponse(undefined); setReadVersion(version => version + 1); }}>重新核对原回执</button>}
    </section>}
  </details>;
}
