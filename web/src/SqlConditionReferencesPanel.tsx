import { Network, ArrowUpRight, AlertTriangle } from 'lucide-react';
import type { SqlConditionReferences } from '../../src/v2/sql-condition-references.mjs';
const kinds = { WHERE: '行筛选', GROUP_BY: '分组键', HAVING: '分组后筛选', JOIN_ON: '关联条件', JOIN: '关联关系', DISTINCT: '去重列集合' };
const statuses = { RESOLVED: '引用已解析', NO_COLUMN_REFERENCE: '无字段引用', UNRESOLVED: '尚未解析' };
export function SqlConditionReferencesPanel({ value, onSource }: {
    value?: SqlConditionReferences;
    onSource?: (table: string) => void;
}) {
    return <details className="sql-condition-references-v2"><summary><Network size={16}/><strong>筛选、关联与去重条件</strong><span>{!value ? '尚未采集' : value.status === 'UNAVAILABLE' ? '引用未确认' : `${value.clauses.length}组 · ${value.status === 'COMPLETE' ? '引用已解析' : '部分未解析'}`}</span></summary>
  <p>这里只说明条件引用哪些源字段，不证明条件正确，也未计算它们对行数、连接倍增、空值保留或权限范围的完整影响。</p>
  {!value ? <p role="status">此运行没有保存条件引用；查看不会从当前草稿补造历史或重新计算。</p> : value.status === 'UNAVAILABLE' ? <p role="status"><AlertTriangle size={14}/>{value.reason ?? '条件作用域或字段来源未核对一致。'}</p> : <>
   <small>{value.scopeCount}个查询作用域 · 共{value.totalClauses}组条件。{value.truncated ? '仅展示前100组，其余未完整展示。' : ''}</small>
   {!value.clauses.length ? <p>此已解析查询中没有本期支持的筛选、关联、分组或去重条件；不代表查询不改变行集。</p> : <div className="column-lineage-table-v2"><table><thead><tr><th>条件与作用域</th><th>引用的源字段</th><th>解析状态</th></tr></thead><tbody>{value.clauses.map(c => <tr key={c.id}><td><strong>{c.id} · {kinds[c.kind]}{c.joinType ? ` · ${c.joinType}` : ''}</strong><small>{c.scopeId} · {c.scopeLabel}</small><code>{c.expression || '没有显式字段条件'}</code></td><td>{c.sources.map(s => onSource ? <button type="button" className="column-source-link-v2" key={`${s.table}.${s.column}`} onClick={() => onSource(s.table)}>{s.table}.{s.column}<ArrowUpRight size={12}/></button> : <code key={`${s.table}.${s.column}`}>{s.table}.{s.column}</code>)}{c.status === 'NO_COLUMN_REFERENCE' && <small>没有字段引用不代表没有行数影响。</small>}{c.status === 'UNRESOLVED' && <small>{c.reason ?? '保留已确认引用，其余来源未解析。'}</small>}</td><td><span className={`column-lineage-state-v2 ${c.status === 'UNRESOLVED' ? 'unresolved' : c.status === 'NO_COLUMN_REFERENCE' ? 'constant' : 'resolved'}`}>{statuses[c.status]}</span></td></tr>)}</tbody></table></div>}
  </>}
 </details>;
}
