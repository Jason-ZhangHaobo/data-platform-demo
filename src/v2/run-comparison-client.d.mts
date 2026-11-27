import type { SyncSqlOutputSchema } from './sync-sql-output-schema-client.mjs';
import type { DerivedResultComparison } from './derived-comparison-client.mjs';

export type ComparisonInput = {
    state: string;
    inputHash?: string;
    schemaHash?: string;
};
export type ComparisonSide = {
    runId: string;
    revisionId: string;
    revisionHash?: string;
    contextId: string;
    createdAt: string;
    sourceKind: string;
    runStatus: string;
    engine?: string;
    engineVersion?: string;
    binding: string;
    input: ComparisonInput;
    testSql: {
        state: string;
        sqlHash?: string;
    };
    validation: {
        state: string;
        contractId?: string;
        assertions: {
            state: string;
        };
        cases: {
            contextId: string;
            name: string;
            passed: boolean;
            input: ComparisonInput;
            assertions: {
                state: string;
            };
        }[];
    };
};
export type ReferenceChange = {
    key: string;
    kind: string;
    before?: {
        target?: string;
        kind?: string;
        status: string;
        sources: {
            table: string;
            column: string;
        }[];
        expression: string;
        joinType?: string;
    };
    after?: ReferenceChange['before'];
};
export type SqlRunComparison = {
    protocol: 'shuduo-sql-run-comparison/v1';
    current: ComparisonSide;
    baseline: ComparisonSide;
    code: {
        state: string;
    };
    inputs: {
        state: string;
    };
    assertions: {
        state: string;
    };
    engineSame: boolean;
    valueSources: {
        state: string;
        reason?: string;
        changes: ReferenceChange[];
    };
    conditionReferences: {
        state: string;
        reason?: string;
        changes: ReferenceChange[];
    };
    caseComparison: {
        state: string;
        changes: {
            contextId: string;
            name: string;
            beforePassed: boolean;
            afterPassed: boolean;
        }[];
    };
    causalConclusion: 'NOT_ESTABLISHED';
    readOnly: true;
    notice: string;
    frozenInput?: {
        snapshotHash: string;
        syncRunId: string;
        metadataVersionId: string;
        baseline: FrozenOutcome;
        current: FrozenOutcome;
    };
};
type FrozenOutcome = { output:SyncSqlOutputSchema;selectedRows:'MATCHED'|'MISMATCH'|'UNAVAILABLE' };
export type RunComparisonCandidates = {
    protocol: 'shuduo-run-comparison-candidates/v1';
    currentRunId: string;
    contextId: string;
    snapshotHash?: string;
    truncated: boolean;
    candidates: {
        runId: string;
        revisionId: string;
        revisionHash?: string;
        contextId: string;
        runStatus: string;
        createdAt: string;
        sourceKind: string;
    }[];
};
type Client = {
    request(path: string): Promise<unknown>;
};
export function checkedSqlRunComparison(value: unknown, args: {
    runId: string;
    baselineRunId: string;
    currentRevisionHash?: string;
    baselineRevisionHash?: string;
    contextId?: string;
    snapshotHash?: string;
}): SqlRunComparison;
export function checkedRunComparisonCandidates(value: unknown, args: {
    runId: string;
    contextId?: string;
    snapshotHash?: string;
}): RunComparisonCandidates;
export function readSqlRunComparison(client: Client, args: {
    runId: string;
    baselineRunId: string;
    currentRevisionHash?: string;
    baselineRevisionHash?: string;
    contextId?: string;
    snapshotHash?: string;
}): Promise<SqlRunComparison>;
export function readRunComparisonCandidates(client: Client, args: {
    runId: string;
    contextId?: string;
    snapshotHash?: string;
}): Promise<RunComparisonCandidates>;
export type SqlComparisonSelection = {comparison:SqlRunComparison;derived?:never} |
    {derived:Extract<DerivedResultComparison,{state:'MATCHED'}>;comparison?:never};
export function readComparisonSql(client: Client, args: SqlComparisonSelection): Promise<{
    baselineSql: string;
    currentSql: string;
}>;
