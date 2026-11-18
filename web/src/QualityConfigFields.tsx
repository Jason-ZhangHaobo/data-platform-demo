import type {QualityConfigDraft} from './quality-rule-config';
import {qualityTypes} from './quality-rule-config';
const labels:Record<string,string>={VALUE_RANGE:'数值范围',NOT_NULL:'非空',UNIQUE:'唯一',ALLOWED_VALUES:'允许值',FRESHNESS_SECONDS:'时效'};
export function QualityConfigFields({draft,onChange,disabled,prefix}:{draft:QualityConfigDraft;onChange:(draft:QualityConfigDraft)=>void;disabled:boolean;prefix:string}){
 const change=(patch:Partial<QualityConfigDraft>)=>onChange({...draft,...patch});
 return <>
  <label>规则类型<select aria-label={`${prefix}规则类型`} disabled={disabled} value={draft.type} onChange={event=>change({type:event.target.value})}>{qualityTypes.map(type=><option key={type} value={type}>{labels[type]} · {type}</option>)}</select></label>
  {draft.type==='VALUE_RANGE'&&<><label>最小值<input aria-label={`${prefix}最小值`} disabled={disabled} value={draft.min} maxLength={80} onChange={event=>change({min:event.target.value})}/></label><label>最大值<input aria-label={`${prefix}最大值`} disabled={disabled} value={draft.max} maxLength={80} onChange={event=>change({max:event.target.value})}/></label></>}
  {draft.type==='ALLOWED_VALUES'&&<><label className="wide">{draft.valuesJson===undefined?'允许值（每行一项）':'允许值JSON（保留值内换行）'}<textarea aria-label={`${prefix}允许值`} disabled={disabled} rows={4} maxLength={draft.valuesJson===undefined?2430:15000} value={draft.valuesJson??draft.valuesText} onChange={event=>change(draft.valuesJson===undefined?{valuesText:event.target.value}:{valuesJson:event.target.value})}/></label>{draft.valuesJson===undefined&&<label className="quality-empty-option"><input type="checkbox" aria-label={`${prefix}允许空字符串`} disabled={disabled} checked={draft.allowEmpty} onChange={event=>change({allowEmpty:event.target.checked})}/>允许空字符串</label>}<p className="quality-config-note">空行忽略，空格是值的一部分；最多30项，每项80字符。实际null或缺失字段不等于空字符串。</p></>}
  {draft.type==='FRESHNESS_SECONDS'&&<><label>最大延迟（秒）<input aria-label={`${prefix}最大延迟秒数`} disabled={disabled} inputMode="numeric" value={draft.maxAgeSeconds} maxLength={10} onChange={event=>change({maxAgeSeconds:event.target.value})}/></label><p className="quality-config-note">检查字段是否早于检测时刻减阈值，支持1—2678400秒；本规则未约束未来时间。</p></>}
  {draft.type==='NOT_NULL'&&<p className="quality-config-note">检测null、空字符串和缺失字段，不需要额外阈值。</p>}
  {draft.type==='UNIQUE'&&<p className="quality-config-note">检测单字段重复，缺失字段失败；需要必填时另配非空规则。</p>}
 </>;
}
