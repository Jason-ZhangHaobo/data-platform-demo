import type {ContextDerivationDraft,VerifiedDerivationSource} from "./agent-context-derivation";

export function AgentContextDerivation({draft,source,state,error,reason,contexts,busy,pending,locked,onTarget,onRead,onExit}:{
  draft?:ContextDerivationDraft;source?:VerifiedDerivationSource;state:"LOADING"|"READY"|"ERROR";error:string;reason:string;
  contexts:{id:string;name:string;definition:string}[];busy:boolean;pending:boolean;locked:boolean;onTarget:(id:string)=>void;onRead:()=>void;onExit:()=>void;
}){
  const original=contexts.find(context=>context.id===source?.contextId),target=contexts.find(context=>context.id===draft?.targetContextId);
  return <section className="agent-context-derivation" aria-label="已登记口径变更草稿">
    <header><div><span>新任务草稿 · 原任务不变</span><h3>基于已验证版本，改变业务口径</h3></div><button className="button" disabled={busy||pending} onClick={onExit}>{draft?"退出并返回原任务":"退出变更草稿"}</button></header>
    <p>原SQL保持只读。确认后将创建新的 Agent 任务并重新执行五场景校验；不继承原审阅、批准或发布，也不重置原尝试与费用记录。</p>
    <div className="agent-context-derivation-grid"><div><small>原已验证口径</small><strong>{original?.name??(state==="LOADING"?"正在核验原版本…":"来源待核验")}</strong>
      {draft&&<><code>任务 {draft.source.taskId}</code><code>版本 {draft.source.revisionId}</code><code>运行 {draft.source.runId}</code><small>SQL SHA-256 · {draft.source.revisionHash.slice(0,16)}</small></>}</div>
      <label>目标口径<select aria-label="口径变更目标" value={draft?.targetContextId??""} disabled={state!=="READY"||busy||pending||locked} onChange={event=>onTarget(event.target.value)}>
        {!draft&&<option value="">请从成功任务创建草稿</option>}{contexts.map(context=><option key={context.id} value={context.id}>{context.name}{context.id===source?.contextId?"（原口径，请另选）":""}</option>)}</select><small>{target?.definition}</small></label></div>
    <div className="agent-context-derivation-status" role={error?"alert":"status"}>{error||reason||(state==="LOADING"?"只读恢复原SQL与成功证据，不发送任务请求。":"来源已核验。请在下方确认新需求，再选择“确认新建口径任务并验证”。")}</div>
    {draft&&<button className="button" disabled={busy||pending} onClick={onRead}>重新读取原冻结来源</button>}
    <small>恢复链接仅保存来源编号、摘要与目标口径，不保存SQL、需求文字或凭证。</small>
  </section>;
}
