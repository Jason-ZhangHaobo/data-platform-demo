import {useEffect, useRef, useState} from "react";
import {batchArchiveListPath, listBatchArchives, readBatchArchive} from "../../src/v2/private-batch-archive-client.mjs";
import type {ArchiveIndex, BatchArchive} from "../../src/v2/private-batch-archive-client.mjs";
import type {PublishedReportBinding} from "../../src/v2/published-report-request.mjs";
import {agentArchiveHref, agentArchivePin, checkedAgentArchive} from "./agent-archive-location";
import type {AgentArchivePin} from "./agent-archive-location";
import {BatchArchiveDetail} from "./BatchArchiveDetail";

type Api = <T>(path: string) => Promise<T>;
type Choice = {sequence: number; source: PublishedReportBinding};
type Read<T> = {api: Api; key: string; value?: T; error?: string};

export function AgentBatchArchivePanel({api, taskId, choices}: {api: Api; taskId: string; choices: Choice[]}) {
  const [pin, setPin] = useState(() => typeof window === "undefined" ? undefined : agentArchivePin(window.location.href, taskId));
  const [batchId, setBatchId] = useState(pin?.batchId ?? "");
  const [retry, setRetry] = useState(0);
  const [index, setIndex] = useState<Read<ArchiveIndex>>();
  const [record, setRecord] = useState<Read<BatchArchive>>();
  const section = useRef<HTMLElement>(null);
  const detail = useRef<HTMLDivElement>(null);
  const source = choices.find(choice => choice.source.batchId === batchId)?.source;
  const listKey = source ? batchArchiveListPath(source) + ":" + retry : "";
  const recordKey = pin ? JSON.stringify([taskId, pin, retry]) : "";
  const currentIndex = index?.api === api && index.key === listKey ? index : undefined;
  const currentRecord = record?.api === api && record.key === recordKey ? record : undefined;
  useEffect(() => {
    if (!source) return;
    let active = true;
    listBatchArchives({request:api}, source).then(
      value => {if (active) setIndex({api, key:listKey, value});},
      (error: Error) => {if (active) setIndex({api, key:listKey, error:error.message});},
    );
    return () => {active = false;};
  }, [api, listKey]);
  useEffect(() => {
    if (!pin) return;
    let active = true;
    readBatchArchive({request:api}, {requestId:pin.requestId}).then(receipt => checkedAgentArchive(receipt, taskId, pin)).then(
      value => {if (active) setRecord({api, key:recordKey, value});},
      (error: Error) => {if (active) setRecord({api, key:recordKey, error:error.message});},
    );
    return () => {active = false;};
  }, [api, recordKey]);
  useEffect(() => {
    if (window.location.hash === "#agent-report-archives") section.current?.scrollIntoView({block:"start"});
  }, []);
  useEffect(() => {
    if (currentRecord?.value) detail.current?.scrollIntoView({block:"start"});
  }, [currentRecord?.value]);

  if (!choices.length && pin === undefined) return null;
  const change = (next?: AgentArchivePin) => {
    history.replaceState(history.state, "", agentArchiveHref(window.location.href, taskId, next));
    setPin(next);
  };
  return <section ref={section} id="agent-report-archives" className="agent-publication-card" aria-label="原批次报表归档">
    <div className="agent-workflow-title"><h3>原批次报表归档</h3></div>
    <p>在任务内核对已审阅的报表版本、原需求与固定汇总。</p>
    {choices.length > 0 && <div className="published-report-actions-v2" aria-label="选择原批次">
      {choices.map(choice => <button className="button" key={choice.source.batchId}
        aria-pressed={batchId === choice.source.batchId}
        onClick={() => {if (batchId !== choice.source.batchId || pin === null) {setBatchId(choice.source.batchId); change();}}}>
        查看第 {choice.sequence} 批归档
      </button>)}
    </div>}
    {pin === null && <p role="alert">归档链接不完整或任务不一致，请从原发布批次选择版本。</p>}
    {source && pin !== null && (!currentIndex
      ? <p role="status">正在读取所选批次的归档…</p>
      : currentIndex.error ? <p role="alert">{currentIndex.error}</p>
      : currentIndex.value?.entries.length === 0 ? <p>此批次暂无已归档报表。</p>
      : <div className="published-report-actions-v2" aria-label="选择归档版本">
        {currentIndex.value?.entries.map(entry => <button className="button" key={entry.requestId}
          aria-pressed={pin?.requestId === entry.requestId}
          onClick={() => change({requestId:entry.requestId, batchId:source.batchId, digest:entry.digest})}>
          查看 V{entry.reportVersion} · {entry.title}
        </button>)}
      </div>)}
    {pin && (!currentRecord ? <p role="status">正在核对原报表版本…</p> :
      currentRecord.error ? <p role="alert">{currentRecord.error}</p> :
      currentRecord.value && <div ref={detail}><BatchArchiveDetail archive={currentRecord.value}/></div>)}
    {(currentIndex?.error || currentRecord?.error) &&
      <button className="button" onClick={() => setRetry(value => value + 1)}>重新核对归档</button>}
  </section>;
}
