import type { SqlConditionReferences } from './sql-condition-references.mjs';

export type SqlValueLineage = {
  assetId: string;
  runId: string;
  revisionId?: string;
  sourceSqlHash?: string;
  schemaHash?: string;
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  analysis: 'STATIC_VALUE_DEPENDENCIES';
  rowSetImpactAnalyzed: false;
  reason?: string;
  parser?: string;
  parserVersion?: string;
  notice?: string;
  conditionReferences?: SqlConditionReferences;
  fields: {
    target: string;
    status: 'RESOLVED' | 'CONSTANT' | 'UNRESOLVED';
    expression: string;
    sources: { table: string; column: string }[];
    reason?: string;
  }[];
};

export function sqlValueLineageShapeValid(value: unknown, outputs: { name: string }[]): value is SqlValueLineage;
