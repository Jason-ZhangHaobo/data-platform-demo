export type SqlConditionReferences = {
    protocol: 'shuduo-sql-condition-references/v1' | 'shuduo-sql-condition-reference-summary/v1';
    analysis: 'STATIC_CONDITION_REFERENCES';
    sourceSqlHash: string;
    schemaHash: string;
    semanticImpactAnalyzed: false;
    status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
    scopeCount: number;
    totalClauses: number;
    truncated: boolean;
    reason?: string;
    clauses: {
        id: string;
        scopeId: string;
        scopeLabel?: string;
        kind: 'WHERE' | 'GROUP_BY' | 'HAVING' | 'JOIN_ON' | 'JOIN' | 'DISTINCT';
        status: 'RESOLVED' | 'NO_COLUMN_REFERENCE' | 'UNRESOLVED';
        expression?: string;
        sources: {
            table: string;
            column: string;
        }[];
        joinType?: string;
        reason?: string;
    }[];
};
export function sqlConditionReferences(value: unknown, binding?: {
    sourceSqlHash?: string;
    schemaHash?: string;
    tables?: {
        name: string;
        columns: [
            string,
            string
        ][];
    }[];
    summary?: boolean;
}): SqlConditionReferences | undefined;
export function unavailableSqlConditionReferences(binding: {
    sourceSqlHash: string;
    schemaHash: string;
}): SqlConditionReferences;
