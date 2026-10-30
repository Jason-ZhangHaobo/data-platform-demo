import test from "node:test";
import assert from "node:assert/strict";
import { generateSql, modelSettings } from "../../src/v2/model.mjs";
import { safeModelDiagnostic } from "../../src/v2/model-diagnostics.mjs";
import { getContext, referenceSql } from "../../src/v2/context.mjs";
const input = { message: "虚构证券资产加工", context: getContext(), currentSql: referenceSql };
const env = { DASHSCOPE_API_KEY: "SYNTHETIC_SECRET_NEVER_PERSIST" };
async function diagnostic(overrides, fetchImpl) {
  try { await generateSql({ ...input, ...overrides }, env, fetchImpl); assert.fail("must fail"); }
  catch (error) { return safeModelDiagnostic(error); }
}
test("safe diagnostics distinguish preflight, HTTP, transport and response errors without provider data", async()=>{
  let sent=0;
  const before=await diagnostic({remainingBudget:100},async()=>{sent++;});
  assert.equal(before.code,"MODEL_CONTEXT_BUDGET"); assert.equal(before.phase,"PREPARE");assert.equal(before.requestMayHaveBeenSent,false);assert.equal(sent,0);
  for(const status of [401,429,503]){
    const d=await diagnostic({},async()=>new Response("SYNTHETIC_SECRET_NEVER_PERSIST",{status}));
    assert.equal(d.code,"MODEL_HTTP_ERROR");assert.equal(d.httpStatus,status);assert.equal(d.phase,"RESPONSE");
    assert.ok(!JSON.stringify(d).includes("SECRET"));
  }
  const net=await diagnostic({},async()=>{throw new Error("SYNTHETIC_SECRET_NEVER_PERSIST");});
  assert.equal(net.code,"MODEL_TRANSPORT_ERROR");assert.equal(net.requestMayHaveBeenSent,true);
  const malformed=await diagnostic({},async()=>new Response("not json"));
  assert.equal(malformed.code,"MODEL_RESPONSE_INVALID");assert.equal(malformed.phase,"PARSE");
  const timeout=await diagnostic({},async()=>{throw new DOMException("secret","TimeoutError");});
  assert.equal(timeout.code,"MODEL_TIMEOUT");
  const forged=safeModelDiagnostic(Object.assign(new Error("secret"),{diagnostic:{phase:"PREPARE",raw:"secret"}}));
  assert.equal(forged.code,"MODEL_STEP_ERROR");assert.equal(forged.requestMayHaveBeenSent,true);assert.ok(!JSON.stringify(forged).includes("secret"));
});
test("Qwen 3.7 SQL protocol explicitly disables thinking and binds JSON output within remaining budget",async()=>{
  let request;
  const generated=await generateSql({...input,remainingBudget:8000},env,async(_url,options)=>{
    request=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:referenceSql,explanation:"虚构证券测试"})}}],usage:{prompt_tokens:900,completion_tokens:400,total_tokens:1300}}));
  });
  assert.equal(request.model,"qwen3.7-plus");assert.equal(request.enable_thinking,false);
  assert.deepEqual(request.response_format,{type:"json_object"});
  assert.ok(request.max_tokens>=256&&request.max_tokens<=6000);
  assert.equal(generated.sql,referenceSql);assert.equal(generated.usage.total_tokens,1300);
  assert.deepEqual(modelSettings({V2_MODEL:"qwen3-coder-plus"}).requestOptions,{});
  assert.equal(modelSettings({V2_MODEL:"qwen3.7-plus-2026-05-26"}).requestOptions.enable_thinking,false);
});

test("SQL repair carries grain and rejoin constraints without independent answers or fixture rows",async()=>{
  const context=getContext("stock-cash-t1"),currentSql="SELECT SUM(market_value) FROM positions";
  const error="重复持仓场景：holding_market_value 结果不符";
  let request,calls=0;
  await generateSql({message:"股票持仓与现金加工",context,currentSql,error,remainingBudget:12000},env,async(_url,options)=>{
    calls++;request=JSON.parse(options.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:currentSql,explanation:"合成请求契约测试，不代表生成正确"})}}],usage:{total_tokens:800}}));
  });
  const prompt=JSON.parse(request.messages[1].content),contract=prompt.executionContract;
  assert.equal(prompt.currentSql,currentSql);assert.equal(prompt.error,error);assert.equal(calls,1);
  assert.match(contract.grainReview.join("\n"),/position_id.*JOIN 原始 positions/);
  assert.match(contract.grainReview.join("\n"),/SUM\(DISTINCT market_value\)/);
  assert.match(contract.repairReview,/真实错误和当前 SQL/);
  assert.match(prompt.context.definition,/仅统计 asset_class = '股票'/);
  assert.deepEqual(prompt.context.tables,context.tables.map(({name,columns})=>({name,columns})));
  assert.equal(Object.hasOwn(prompt.context,"expected"),false);
  assert.equal(Object.hasOwn(prompt.context,"referenceSql"),false);
  assert.equal(request.messages[1].content.includes('"rows"'),false);
  assert.equal(request.messages[1].content.includes('"total_assets":"1300.00"'),false);
  assert.ok(request.max_tokens>=256&&request.max_tokens<=6000);
});
