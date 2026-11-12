import {distributionMetadataForContext} from './output-contract-metadata.mjs';
import {fundRequirementScope} from './fund-requirement-contract.mjs';
import { getContext,validationFamilyForContext } from "./context.mjs";
import {createHash}from'node:crypto';
import {sqlLineageSchemaHash}from'./sql-column-lineage.mjs';
import{sqlConditionReferences}from'./sql-condition-references.mjs';

const protocol = "SECURITIES_SQL_REPAIR_FEEDBACK_V1";
const legacyFields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
const legacyKinds = ["VALUE_MISMATCH", "INVALID_NUMBER", "CLIENT_COUNT", "DUPLICATE_CLIENT", "CLIENT_SCOPE", "OUTPUT_FIELDS"];
const fieldsFor=id=>fundRequirementScope(id)?.metrics.map(metric=>metric.field)??distributionMetadataForContext(id)?.fields.map(f=>f.name)??legacyFields;
const kindsFor=id=>distributionMetadataForContext(id)?[...legacyKinds,"ROW_COUNT","DUPLICATE_KEY","GROUP_SCOPE","DECIMAL_RANGE"]:legacyKinds;
const classify = (issues,fields,issueKinds) => {
  const selectedFields = new Set(), kinds = new Set();
  for (const raw of issues) {
    if (typeof raw !== "string") continue;
    const issue = raw.slice(0, 1024);
    for (const field of fields) if (new RegExp(`\\b${field}\\b`).test(issue)) selectedFields.add(field);
    if (issue.includes("结果不符") || issue.includes("独立预期不符")) kinds.add("VALUE_MISMATCH");
    if (issue.includes("非有效数值")) kinds.add("INVALID_NUMBER");
    if (issue.includes("客户记录数不符")) kinds.add("CLIENT_COUNT");
    if (issue.includes("客户记录重复")) kinds.add("DUPLICATE_CLIENT");
    if (issue.includes("缺少客户") || issue.includes("范围外客户")) kinds.add("CLIENT_SCOPE");
    if (issue.includes("分组记录数")) kinds.add("ROW_COUNT");
    if (issue.includes("复合键重复")) kinds.add("DUPLICATE_KEY");
    if (issue.includes("未登记分组")||issue.includes("缺少登记分组")) kinds.add("GROUP_SCOPE");
    if (issue.includes("分组数值")) {kinds.add("VALUE_MISMATCH");kinds.add("DECIMAL_RANGE");}
    if (issue.includes("输出字段")) kinds.add("OUTPUT_FIELDS");
  }
  return { fields: fields.filter(field => selectedFields.has(field)), issueKinds: issueKinds.filter(kind => kinds.has(kind)) };
};

// Describe registered check outcomes, never fixture rows, reference SQL, expected
// values, client identifiers or untrusted error text. The ordinary error summary
// remains a separate input to the model; this adds which checks already passed.
export function buildSqlRepairFeedback(run, contextId, {currentSql}={}) {
  const family = validationFamilyForContext(contextId), validation = run?.validation;
  if (!family || run?.contextId !== contextId || run.status !== "VALIDATION_FAILED" || validation?.passed !== false ||
      validation.contractId !== family.id || !Array.isArray(validation.regressions) || validation.regressions.length !== family.contextIds.length)
    return undefined;
  const fields=fieldsFor(contextId),issueKinds=kindsFor(contextId);
  const cases = new Map();
  for (const row of validation.regressions) {
    if (!row || !family.contextIds.includes(row.contextId) || cases.has(row.contextId) || typeof row.passed !== "boolean" ||
        !Array.isArray(row.issues) || row.issues.length > 100) return undefined;
    cases.set(row.contextId, { contextId: row.contextId, passed: row.passed, ...classify(row.issues,fields,issueKinds) });
  }
  const trace=run.columnLineage,sourceSqlHash=typeof currentSql==='string'?createHash('sha256').update(currentSql).digest('hex'):undefined;
  const valueLineage=trace?.protocol==='shuduo-sql-value-lineage/v1'&&run.engine==='Apache Spark'&&run.mainSqlExecuted===true&&run.revisionHash===sourceSqlHash&&trace.sourceSqlHash===sourceSqlHash&&trace.contextId===contextId&&
    ['COMPLETE','PARTIAL'].includes(trace.status)?{...trace,protocol:'shuduo-sql-value-lineage-summary/v1'}:undefined;
  return safeSqlRepairFeedback({ protocol, contextId, contractId: family.id, checks: family.contextIds.map(id => cases.get(id)),...(valueLineage?{valueLineage}:{}) }, contextId,{currentSql});
}

function safeValueLineage(value,contextId,currentSql){
 const fields=fieldsFor(contextId);
 if(typeof currentSql!=='string'||!currentSql.length||currentSql.length>20000||value?.protocol!=='shuduo-sql-value-lineage-summary/v1'||value.analysis!=='STATIC_VALUE_DEPENDENCIES'||value.rowSetImpactAnalyzed!==false)return;
 const context=getContext(contextId),sourceSqlHash=createHash('sha256').update(currentSql).digest('hex'),schemaHash=sqlLineageSchemaHash(context),known=new Map(context.tables.map(t=>[t.name,new Set(t.columns.map(c=>c[0]))]));
 if(value.sourceSqlHash!==sourceSqlHash||value.schemaHash!==schemaHash||!Array.isArray(value.fields)||value.fields.length!==fields.length)return;
 const summaries=[];for(const target of fields){const matches=value.fields.filter(f=>f?.target===target);if(matches.length!==1)return;const f=matches[0];if(!['RESOLVED','CONSTANT','UNRESOLVED'].includes(f.status)||!Array.isArray(f.sources)||f.sources.length>150||f.sources.some(s=>!s||!known.get(s.table)?.has(s.column))||new Set(f.sources.map(s=>`${s.table}.${s.column}`)).size!==f.sources.length||f.status==='RESOLVED'&&!f.sources.length||f.status==='CONSTANT'&&f.sources.length)return;summaries.push({target,status:f.status,sources:f.sources.map(s=>({table:s.table,column:s.column}))});}
 const conditionReferences=sqlConditionReferences(value.conditionReferences,{sourceSqlHash,schemaHash,tables:context.tables,summary:true});
 return{protocol:'shuduo-sql-value-lineage-summary/v1',analysis:'STATIC_VALUE_DEPENDENCIES',sourceSqlHash,schemaHash,rowSetImpactAnalyzed:false,fields:summaries,
  ...(conditionReferences&&conditionReferences.status!=='UNAVAILABLE'?{conditionReferences}:{})};
}

export function safeSqlRepairFeedback(value, contextId,{currentSql}={}) {
  const family = validationFamilyForContext(contextId),fields=fieldsFor(contextId),issueKinds=kindsFor(contextId);
  if (!family || value?.protocol !== protocol || value.contextId !== contextId || value.contractId !== family.id ||
      !Array.isArray(value.checks) || value.checks.length !== family.contextIds.length) return undefined;
  const checks = [];
  for (const id of family.contextIds) {
    const rows = value.checks.filter(row => row?.contextId === id);
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    if (typeof row.passed !== "boolean" || !Array.isArray(row.fields) || row.fields.length > fields.length ||
        !Array.isArray(row.issueKinds) || row.issueKinds.length > issueKinds.length ||
        row.fields.some(field => !fields.includes(field)) || row.issueKinds.some(kind => !issueKinds.includes(kind)) ||
        row.passed && (row.fields.length || row.issueKinds.length)) return undefined;
    checks.push({ contextId: id, passed: row.passed,
      fields: fields.filter(field => row.fields.includes(field)), issueKinds: issueKinds.filter(kind => row.issueKinds.includes(kind)) });
  }
  const failedCaseCount = checks.filter(check => !check.passed).length;
  if (!failedCaseCount) return undefined;
  const valueLineage=safeValueLineage(value.valueLineage,contextId,currentSql);
  return { protocol, contextId, contractId: family.id, checks, passedCaseCount: checks.length - failedCaseCount, failedCaseCount,...(valueLineage?{valueLineage}:{}) };
}
