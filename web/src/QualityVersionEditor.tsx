import {useState} from 'react';
import {QualityConfigFields} from './QualityConfigFields';
import {qualityVersionBody,qualityConfig} from './quality-rule-config';
import type {QualityEditableVersion,QualityVersionDraft} from './quality-rule-config';
export type PendingQualityVersion={requestId:string;body:ReturnType<typeof qualityVersionBody>;state:'POSTING'|'UNKNOWN'|'NOT_FOUND'};
export function QualityVersionEditor({draft,captured,current,fields,canWrite,busy,pending,onChange,onLoadCurrent,onSave,onLookup,onRefresh}:{
 draft:QualityVersionDraft;captured:boolean;current:QualityEditableVersion&{versionNumber:number};fields:string[];canWrite:boolean;busy:boolean;pending?:PendingQualityVersion;
 onChange:(draft:QualityVersionDraft)=>void;onLoadCurrent:()=>void;onSave:()=>void;onLookup:()=>void;onRefresh:()=>void;
}){
 const [open,setOpen]=useState(false),stale=draft.baseVersionId!==current.id;
 let problem='';try{const body=qualityVersionBody(draft);if(!fields.includes(draft.field))problem='原检测字段不在当前资产中，请选择已登记字段';
   else if(!pending&&body.field===current.field&&body.type===current.type&&JSON.stringify(qualityConfig(draft))===JSON.stringify(current.config)&&body.description===current.description)problem='尚未修改字段、类型、参数或说明，无需创建重复版本';
 }catch(error){problem=error instanceof Error?error.message:'配置未通过';}
 return <details className="quality-version-form-v2" open={open} onToggle={event=>{const next=event.currentTarget.open;setOpen(next);if(next&&!captured&&!pending)onChange({...draft});}}>
  <summary>编辑并保存规则新版本</summary>
  <p>基于版本 {draft.baseVersionId.slice(0,8)}。保存仅创建待检测版本，旧回执保留。</p>
  {stale&&<p role="status">当前规则已有V{current.versionNumber}，草稿仍基于原版本。请重读后载入并审阅，不能静默保存。</p>}
  <div><label>检测字段<select aria-label="版本检测字段" value={draft.field} disabled={!canWrite||busy||Boolean(pending)} onChange={event=>onChange({...draft,field:event.target.value})}>{!fields.includes(draft.field)&&<option value={draft.field}>{draft.field}（当前资产未登记）</option>}{fields.map(field=><option key={field}>{field}</option>)}</select></label>
   <QualityConfigFields draft={draft} prefix="版本" disabled={!canWrite||busy||Boolean(pending)} onChange={value=>onChange({...draft,...value})}/>
   <label className="wide">版本说明<input aria-label="版本说明" disabled={!canWrite||busy||Boolean(pending)} value={draft.description} maxLength={500} onChange={event=>onChange({...draft,description:event.target.value})}/></label>
  </div>
  {problem&&<p role="status">{problem}</p>}
  {pending&&<p role="status">{pending.state==='NOT_FOUND'?'尚未找到原保存回执，可按原编号重试':'保存结果待确认，请先查找原回执'} · 请求 {pending.requestId}。输入已保留。</p>}
  <footer><button className="button" disabled={busy} onClick={onRefresh}>重读当前规则</button><button className="button" disabled={busy||Boolean(pending&&pending.state!=='NOT_FOUND')} onClick={onLoadCurrent}>载入当前版本（替换草稿）</button>
   {pending&&pending.state!=='POSTING'&&<button className="button" disabled={busy} onClick={onLookup}>查找原保存回执</button>}
   <button className="button" disabled={!canWrite||busy||stale||Boolean(problem)||Boolean(pending&&pending.state!=='NOT_FOUND')} onClick={onSave}>{pending?'以原请求编号重试':'保存为新版本'}</button>
  </footer>
 </details>;
}
