import { sqlConditionReferences } from './sql-condition-references.mjs';

const identifier = value => typeof value === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value);
const id = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function sqlValueLineageShapeValid(value, outputs) {
  if (!value || value.analysis !== 'STATIC_VALUE_DEPENDENCIES' || value.rowSetImpactAnalyzed !== false ||
      !['COMPLETE', 'PARTIAL', 'UNAVAILABLE'].includes(value.status) || !Array.isArray(value.fields) ||
      value.reason !== undefined && typeof value.reason !== 'string') return false;
  if (value.conditionReferences !== undefined && !sqlConditionReferences(value.conditionReferences, {
    sourceSqlHash: value.sourceSqlHash, schemaHash: value.schemaHash,
  })) return false;
  if (value.status === 'UNAVAILABLE') return value.fields.length === 0;
  if (!id(value.revisionId) || !digest(value.sourceSqlHash) || !digest(value.schemaHash) || value.parser !== 'sqlglot' ||
      typeof value.parserVersion !== 'string' || value.parserVersion.length > 40 ||
      !value.fields.length || value.fields.length !== outputs.length) return false;
  if (value.fields.some((field, index) => !field || field.target !== outputs[index].name || !identifier(field.target) ||
      !['RESOLVED', 'CONSTANT', 'UNRESOLVED'].includes(field.status) || typeof field.expression !== 'string' ||
      field.expression.length > 1000 || !Array.isArray(field.sources) || field.sources.length > 150 ||
      field.sources.some(source => !source || !identifier(source.table) || !identifier(source.column)) ||
      field.status === 'RESOLVED' && !field.sources.length || field.status === 'CONSTANT' && field.sources.length ||
      field.reason !== undefined && typeof field.reason !== 'string')) return false;
  return (value.status === 'COMPLETE') === value.fields.every(field => ['RESOLVED', 'CONSTANT'].includes(field.status));
}
