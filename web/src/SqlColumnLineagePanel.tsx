import { GitBranch, ArrowUpRight, AlertTriangle } from 'lucide-react';
import type { SqlValueLineage } from './sql-column-lineage';
import{SqlConditionReferencesPanel}from'./SqlConditionReferencesPanel';
export function SqlColumnLineagePanel({ items, onSource, sourceLabel = '发布批次' }: {
    items: SqlValueLineage[];
    onSource?: (table: string) => void;
    sourceLabel?: '发布批次' | '开发运行';
}) {
    return <section className="asset-column-lineage-v2" aria-label="SQL字段值来源"><header><GitBranch size={17}/><h4>SQL 字段值来源</h4><span className="module-badge">静态分析</span></header>
  <p>分别展示字段值来源和条件引用的源字段。字面量已隐藏；连接、筛选、分组及权限对行集的完整语义影响仍未覆盖。</p>
  {items.map(item => <article key={`${item.assetId}:${item.runId}`}><div className="column-lineage-source-v2"><strong>{item.status === 'COMPLETE' ? '本版值来源已解析' : item.status === 'PARTIAL' ? '本版值来源部分解析' : '本版值来源未确认'}</strong><small>{sourceLabel} {item.runId.slice(0, 8)}{item.revisionId ? ` · 代码版本 ${item.revisionId.slice(0, 8)}` : ''}{item.sourceSqlHash ? ` · SQL摘要 ${item.sourceSqlHash.slice(0, 12)}` : ''}</small></div>
   <SqlConditionReferencesPanel value={item.conditionReferences} onSource={onSource}/>
   {item.status === 'UNAVAILABLE' ? <p role="status"><AlertTriangle size={14}/> {item.reason ?? '此版本尚无可核对的字段来源记录。'}</p> : <div className="column-lineage-table-v2"><table><thead><tr><th>输出字段与表达式</th><th>源字段</th><th>解析状态</th></tr></thead><tbody>{item.fields.map(f => <tr key={f.target}><td><strong>{f.target}</strong><code>{f.expression || '表达式未确认'}</code></td><td>{f.sources.map(s => onSource ? <button type="button" className="column-source-link-v2" key={`${s.table}.${s.column}`} onClick={() => onSource(s.table)}>{s.table}.{s.column}<ArrowUpRight size={12}/></button> : <code key={`${s.table}.${s.column}`}>{s.table}.{s.column}</code>)}{f.status === 'CONSTANT' && <small>常量表达式，无源字段</small>}{f.status === 'UNRESOLVED' && <small>{f.reason ?? '值来源或行集依赖未完整确认'}</small>}</td><td><span className={`column-lineage-state-v2 ${f.status.toLowerCase()}`}>{f.status === 'RESOLVED' ? '来源已解析' : f.status === 'CONSTANT' ? '常量' : '尚未解析'}</span></td></tr>)}</tbody></table></div>}
  </article>)}
  <small>字段值来源不等于完整数据影响分析，也不替代实际 Spark 执行、结果断言或发布审阅。</small>
 </section>;
}
