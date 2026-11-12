import {useEffect, useRef, useState} from "react";
import {isAgentSampleLanding, publicAgentSamples} from "./agent-startup-samples";

export default function AgentStartupPreview({read, selected, onSelect}: {
  read: () => Promise<unknown>; selected?: string; onSelect: (id: string) => void;
}) {
  const enabled = isAgentSampleLanding(location.href);
  const request = useRef(read);
  const [samples, setSamples] = useState<ReturnType<typeof publicAgentSamples>>();
  const [choice, setChoice] = useState(selected);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    request.current().then(
      value => { if (active) setSamples(publicAgentSamples(value)); },
      () => { if (active) setSamples([]); },
    );
    return () => { active = false; };
  }, [enabled]);
  if (!enabled) return <div className="workbench-loading" role="status">正在核验原任务访问权限。</div>;
  const context = samples?.find(sample => sample.id === choice) ?? samples?.[0];
  return <section className="agent-startup-preview" aria-labelledby="agent-startup-title">
    <h2 id="agent-startup-title">公开样例</h2>
    {context ? <>
      <div className="agent-startup-actions">
        <label>业务口径与验证数据<select aria-label="Agent 验证数据" value={context.id} onChange={event => {
          setChoice(event.target.value);
          onSelect(event.target.value);
        }}>
          {samples?.map(sample => <option key={sample.id} value={sample.id}>{sample.name}</option>)}
        </select></label>
        <button className="button" type="button" disabled>新建任务</button>
      </div>
      <p>交易日 {context.businessDate}</p>
      <p>{context.definition}</p>
    </> : <p role="status">{samples ? "公开样例暂不可用。" : "正在读取公开样例…"}</p>}
  </section>;
}
