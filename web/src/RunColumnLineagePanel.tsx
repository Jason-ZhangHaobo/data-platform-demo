import { useEffect, useRef, useState } from 'react';
import { SqlColumnLineagePanel } from './SqlColumnLineagePanel';
import { developmentSqlValueLineage } from './sql-column-lineage';
import type { DevelopmentLineageRun, DevelopmentLineageContext } from './sql-column-lineage';
type Result = Awaited<ReturnType<typeof developmentSqlValueLineage>>;
export default function RunColumnLineagePanel({ run, revisionId, sql, context, dirty }: {
    run: DevelopmentLineageRun;
    revisionId?: string;
    sql: string;
    context?: DevelopmentLineageContext;
    dirty: boolean;
}) {
    const key = JSON.stringify([run.id, run.revisionId, run.revisionHash, run.columnLineage, revisionId, sql, context?.id, context?.tables.map(t => ({ name: t.name, columns: t.columns }))]), [read, setRead] = useState<{
        key: string;
        result: Result;
    }>(), epoch = useRef(0);
    useEffect(() => { const ticket = ++epoch.current; void developmentSqlValueLineage({ run, revisionId, sql, context }).then(result => { if (ticket === epoch.current)
        setRead({ key, result }); }); return () => { epoch.current++; }; }, [key]);
    const result = read?.key === key ? read.result : undefined;
    return <div aria-label="当前开发运行字段来源">{dirty && <p role="status">原版本字段值来源；当前未保存修改尚未验证，不继承此分析。</p>}{!result ? <p role="status">正在核对原SQL、结构和运行摘要；不调用模型或Spark。</p> : result.state === 'READY' ? <SqlColumnLineagePanel items={[result.item]} sourceLabel="开发运行"/> : <p role={result.state === 'ERROR' ? 'alert' : 'status'}>{result.message}</p>}</div>;
}
