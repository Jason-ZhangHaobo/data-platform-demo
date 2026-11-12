import {sqlConditionReferences}from'../../src/v2/sql-condition-references.mjs';
import { sqlValueLineageShapeValid } from '../../src/v2/sql-value-lineage-view.mjs';
import type { SqlValueLineage } from '../../src/v2/sql-value-lineage-view.mjs';

export type { SqlValueLineage } from '../../src/v2/sql-value-lineage-view.mjs';

const id = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
export function sqlValueLineageValid(value: unknown, nodes: unknown[]): value is SqlValueLineage {
    const v = value as SqlValueLineage | undefined, node = nodes.find(x => x && typeof x === 'object' && (x as {
        id?: unknown;
    }).id === v?.assetId) as {
        id: string;
        kind: string;
        versionId?: string;
        fields: {
            name: string;
        }[];
    } | undefined;
    return Boolean(v && node && node.kind === 'PUBLISHED_DATASET' && node.versionId === v.runId && id(v.runId) && sqlValueLineageShapeValid(v, node.fields));
}
export type DevelopmentLineageRun = {
    id: string;
    revisionId?: string;
    revisionHash?: string;
    contextId?: string;
    engine?: string;
    status?: string;
    mainSqlExecuted?: boolean;
    columns?: {
        name: string;
        type: string;
    }[];
    columnLineage?: unknown;
};
export type DevelopmentLineageContext = {
    id: string;
    tables: {
        name: string;
        columns: [
            string,
            string
        ][];
    }[];
};
const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical((v as Record<string, unknown>)[k])])) : v;
const hash = async (v: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v)))].map(x => x.toString(16).padStart(2, '0')).join('');
export async function developmentSqlValueLineage({ run, revisionId, sql, context }: {
    run: DevelopmentLineageRun;
    revisionId?: string;
    sql: string;
    context?: DevelopmentLineageContext;
}): Promise<{
    state: 'READY';
    item: SqlValueLineage;
} | {
    state: 'UNAVAILABLE' | 'ERROR';
    message: string;
}> {
    if (run.columnLineage === undefined)
        return { state: 'UNAVAILABLE', message: '此运行尚未保存字段值来源；查看不会用当前草稿重新解析或执行。' };
    try {
        if (!id(run.id) || !id(revisionId) || run.revisionId !== revisionId || !context || run.contextId !== context.id || run.engine !== 'Apache Spark' || run.mainSqlExecuted !== true || !['SUCCEEDED', 'VALIDATION_FAILED'].includes(run.status ?? ''))
            throw Error('SOURCE');
        const value = run.columnLineage as Record<string, unknown>, sourceSqlHash = await hash(sql), schemaHash = await hash(JSON.stringify(canonical({ tables: context.tables.map(t => ({ name: t.name, columns: t.columns })) })));
        if (value?.protocol !== 'shuduo-sql-value-lineage/v1' || value.dialect !== 'spark' || value.contextId !== context.id || value.sourceSqlHash !== sourceSqlHash || run.revisionHash !== sourceSqlHash || value.schemaHash !== schemaHash || !Array.isArray(run.columns))
            throw Error('BINDING');
        const item = { ...value, assetId: `run:${run.id}`, runId: run.id, revisionId } as unknown as SqlValueLineage;
        if (!sqlValueLineageShapeValid(item, run.columns))
            throw Error('SHAPE');
        const known = new Map(context.tables.map(t => [t.name, new Set(t.columns.map(c => c[0]))]));
        if (item.fields.some(f => f.sources.some(s => !known.get(s.table)?.has(s.column))))
            throw Error('COLUMN');
        if(item.conditionReferences!==undefined&&!sqlConditionReferences(item.conditionReferences,{sourceSqlHash,schemaHash,tables:context.tables}))throw Error('CONDITION_COLUMN');
        return { state: 'READY', item };
    }
    catch {
        return { state: 'ERROR', message: '字段来源与当前保存代码、运行或输入结构未核对一致；未采用其他版本的分析。' };
    }
}
