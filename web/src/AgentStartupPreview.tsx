import {isAgentSampleLanding, type publicAgentSamples} from "./agent-startup-samples";

export {isAgentSampleLanding as isOpeningLanding};
const data = document.getElementById("agent-opening-data")?.textContent;
const samples: ReturnType<typeof publicAgentSamples> = data ? JSON.parse(data) : [];
export const selection = document.querySelector<HTMLSelectElement>("#root .agent-startup-preview select")?.value;

export function Preview({selected, onSelect}: {
  selected?: string; onSelect: (id: string) => void;
}) {
  const context = samples.find(sample => sample.id === selected) ?? samples[0];
  return <section className="agent-startup-preview" aria-labelledby="agent-startup-title">
    <h2 id="agent-startup-title">公开样例</h2>
    {context ? <>
      <div className="agent-startup-actions">
        <label>业务口径与验证数据<select aria-label="Agent 验证数据" value={context.id} onChange={event => onSelect(event.target.value)}>
          {samples.map(sample => <option key={sample.id} value={sample.id}>{sample.name}</option>)}
        </select></label>
        <button className="button" type="button" disabled>新建任务</button>
      </div>
      <p>交易日 {context.businessDate}</p>
      <p>{context.definition}</p>
    </> : <p role="status">公开样例暂不可用。</p>}
  </section>;
}
