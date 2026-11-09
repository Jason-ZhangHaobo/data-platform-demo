import test from "node:test";
import assert from "node:assert/strict";
import { buildSqlRepairFeedback, safeSqlRepairFeedback } from "../../src/v2/sql-repair-feedback.mjs";
import { validationFamilyForContext } from "../../src/v2/context.mjs";
import { generateSql } from "../../src/v2/model.mjs";
import { getContext, referenceSqlForContext } from "../../src/v2/context.mjs";
import{createHash}from'node:crypto';import{sqlLineageSchemaHash}from'../../src/v2/sql-column-lineage.mjs';

const contextId = "stock-cash-t1", family = validationFamilyForContext(contextId);
function receipt() {
  return { contextId, status: "VALIDATION_FAILED", rows: [{ secret: "SYNTHETIC_ROW_DO_NOT_SEND" }],
    validation: { passed: false, contractId: family.id, regressions: family.contextIds.map(id => ({ contextId: id,
      passed: !id.includes("duplicate-position"), issues: id.includes("duplicate-position") ? ["SYNTHETIC_CLIENT_ID.holding_market_value 结果不符", "SYNTHETIC_CLIENT_ID.total_assets 结果不符"] : [],
      expected: "SYNTHETIC_EXPECTED_DO_NOT_SEND", actual: "SYNTHETIC_ACTUAL_DO_NOT_SEND" })) } };
}
test("repair feedback describes the failed check and preserves the four successful cases without rows or answers", () => {
  const result = buildSqlRepairFeedback(receipt(), contextId);
  assert.equal(result.failedCaseCount, 1); assert.equal(result.passedCaseCount, 4);
  assert.deepEqual(result.checks[2], { contextId: family.contextIds[2], passed: false,
    fields: ["holding_market_value", "total_assets"], issueKinds: ["VALUE_MISMATCH"] });
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|expected|actual|rows|referenceSql/);
});
test("a wrong contract, mixed or incomplete family, success and other-context receipts cannot become repair evidence", () => {
  for (const change of [r => r.contextId = "holdings-t1", r => r.status = "SUCCEEDED", r => r.validation.passed = true,
    r => r.validation.contractId = "wrong", r => r.validation.regressions.pop(),
    r => r.validation.regressions[2] = r.validation.regressions[0], r => r.validation.regressions[2].contextId = "duplicate-position",
    r => r.validation.regressions[2].passed = "false", r => r.validation.regressions[2].issues = Array(101).fill("bad")]) {
    const run = receipt(); change(run); assert.equal(buildSqlRepairFeedback(run, contextId), undefined);
  }
});
test("model-bound feedback is rebuilt from allowlisted fields even when the caller adds arbitrary values", () => {
  const good = buildSqlRepairFeedback(receipt(), contextId);
  good.extra = "SYNTHETIC_SECRET"; good.checks[2].expected = "SYNTHETIC_EXPECTED";
  assert.doesNotMatch(JSON.stringify(safeSqlRepairFeedback(good, contextId)), /SYNTHETIC_|expected|extra/);
  good.checks[2].fields.push("arbitrary_sql"); assert.equal(safeSqlRepairFeedback(good, contextId), undefined);
});
test("the model request includes bounded real check outcomes but cannot receive fixture values through repair metadata", async () => {
  const feedback = buildSqlRepairFeedback(receipt(), contextId); feedback.expected = "SYNTHETIC_EXPECTED_DO_NOT_SEND";
  let body;
  await generateSql({ message: "修正股票持仓重复问题", context: getContext(contextId), currentSql: "SELECT client_id FROM accounts",
    error: "重复持仓：holding_market_value 结果不符", repairFeedback: feedback, remainingBudget: 16000 },
  { DASHSCOPE_API_KEY: "sk-synthetic-test-only" }, async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ sql: referenceSqlForContext(contextId), explanation: "合成响应，仅验证请求契约" }) } }], usage: { total_tokens: 1000 } }));
  });
  const prompt = JSON.parse(body.messages[1].content);
  assert.equal(prompt.repairFeedback.passedCaseCount, 4);
  assert.equal(prompt.repairFeedback.failedCaseCount, 1);
  assert.doesNotMatch(body.messages[1].content, /SYNTHETIC_EXPECTED|SYNTHETIC_CLIENT|SYNTHETIC_ROW|SYNTHETIC_ACTUAL/);
  assert.equal(Object.hasOwn(prompt.context, "expected"), false);
});
test('current-code value dependencies are summarized without expressions, values or other input fields',async()=>{
 const currentSql=referenceSqlForContext(contextId),digest=createHash('sha256').update(currentSql).digest('hex'),run=receipt();run.engine='Apache Spark';run.mainSqlExecuted=true;run.revisionHash=digest;
 run.columnLineage={protocol:'shuduo-sql-value-lineage/v1',contextId,sourceSqlHash:digest,schemaHash:sqlLineageSchemaHash(getContext(contextId)),analysis:'STATIC_VALUE_DEPENDENCIES',rowSetImpactAnalyzed:false,status:'COMPLETE',fields:['client_id','holding_market_value','available_cash','total_assets','security_count'].map(target=>({target,status:'RESOLVED',sources:[{table:'accounts',column:'client_id',actual:'SYNTHETIC_SOURCE_VALUE'}],expression:'SYNTHETIC_LITERAL_EXPRESSION',expected:'SYNTHETIC_EXPECTED'}))};
 const feedback=buildSqlRepairFeedback(run,contextId,{currentSql});assert.equal(feedback.valueLineage.fields.length,5);assert.equal(feedback.valueLineage.rowSetImpactAnalyzed,false);assert.doesNotMatch(JSON.stringify(feedback),/SYNTHETIC_|expression|expected|actual/);
 assert.equal(buildSqlRepairFeedback(run,contextId,{currentSql:currentSql+'\n-- changed'}).valueLineage,undefined);assert.equal(safeSqlRepairFeedback(feedback,contextId,{currentSql:'SELECT different'}).valueLineage,undefined);
 feedback.valueLineage.fields[0].sources[0].column='unregistered_column';assert.equal(safeSqlRepairFeedback(feedback,contextId,{currentSql}).valueLineage,undefined);
});
test('the model adapter rechecks and transmits only the actual-code source summary, never raw analysis data',async()=>{
 const currentSql=referenceSqlForContext(contextId),digest=createHash('sha256').update(currentSql).digest('hex'),feedback=buildSqlRepairFeedback(receipt(),contextId);feedback.valueLineage={protocol:'shuduo-sql-value-lineage-summary/v1',analysis:'STATIC_VALUE_DEPENDENCIES',rowSetImpactAnalyzed:false,sourceSqlHash:digest,schemaHash:sqlLineageSchemaHash(getContext(contextId)),fields:['client_id','holding_market_value','available_cash','total_assets','security_count'].map(target=>({target,status:'RESOLVED',sources:[{table:'positions',column:'market_value',secret:'SYNTHETIC_ROW'}],expression:'SYNTHETIC_PRIVATE_EXPRESSION'}))};let prompt;
 await generateSql({message:'修正虚构证券金额口径',context:getContext(contextId),currentSql,error:'金额断言失败',repairFeedback:feedback,remainingBudget:16000},{DASHSCOPE_API_KEY:'sk-synthetic-test-only'},async(_url,options)=>{prompt=JSON.parse(JSON.parse(options.body).messages[1].content);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:currentSql,explanation:'合成响应，只验证请求'})}}],usage:{total_tokens:1000}}));});
 assert.equal(prompt.repairFeedback.valueLineage.sourceSqlHash,digest);assert.equal(prompt.repairFeedback.valueLineage.fields.length,5);assert.doesNotMatch(JSON.stringify(prompt.repairFeedback),/SYNTHETIC_|expression|secret/);
});
