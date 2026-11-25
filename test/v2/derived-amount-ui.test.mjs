import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import React from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {derivedParentCheckpoint} from "../../web/src/agent-context-derivation.ts";
import {validationFamilyForContext} from "../../src/v2/context.mjs";

// Use the production React views with synthetic public fixtures.
const file = new URL("../../web/src/DerivedAmountComparison.tsx",import.meta.url);
let compiled = ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{
  jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022
}}).outputText;
for(const module of ["react","react/jsx-runtime"]) {
  compiled=compiled.replaceAll(`from "${module}"`,`from "${import.meta.resolve(module)}"`);
}
compiled=compiled.replace('import "./derived-amount-comparison.css";',"")
  .replace('from "../../src/v2/derived-comparison-client.mjs"',`from "${new URL("../../src/v2/derived-comparison-client.mjs",file).href}"`);
const {default:Reader,DerivedAmountReport}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
const html=(component,props)=>renderToStaticMarkup(React.createElement(component,props));
const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
const source=(n,contextId,contextName)=>({taskId:id(n),revisionId:id(n+1),runId:id(n+2),revisionHash:"a".repeat(64),
  contextId,validationContractId:validationFamilyForContext(contextId).id,contextName});
const parent=source(1,"holdings-t1","原持仓与现金"),child=source(4,"cash-change","变更现金口径");
const protocol="shuduo-derived-result-comparison/v1";

test("only a different registered task and context with a complete frozen reference enables comparison",()=>{
  const {contextName,...checkpoint}=parent;
  const value={kind:"REGISTERED_CONTEXT_CHANGE",...checkpoint};
  assert.deepEqual(derivedParentCheckpoint(value,child.taskId,child.contextId),checkpoint);
  for(const patch of [undefined,{...value,kind:"MANUAL"},{...value,validationContractId:"unverified"},
    {...value,runId:undefined},{...value,revisionHash:"abc"},{...value,taskId:child.taskId},{...value,extra:true}]) {
    assert.equal(derivedParentCheckpoint(patch,child.taskId,child.contextId),undefined);
  }
  assert.equal(derivedParentCheckpoint(value,child.taskId,parent.contextId),undefined);
});

test("initial view does not request or announce amounts",()=>{
  let calls=0;
  const initial=html(Reader,{api:()=>{calls++;},parent,child});
  assert.match(initial,/查看金额对照/);
  assert.match(initial,/aria-expanded="false"/);
  assert.doesNotMatch(initial,/客户合计|查看运行来源|3250.00/);
  assert.equal(calls,0);
});

test("observed zero, positive and negative differences retain cent precision and point to both run identifiers",()=>{
  const metrics=(holding,cash,total,count)=>({holding_market_value:holding,available_cash:cash,total_assets:total,security_count:count});
  const amounts={before:metrics("100.01","225.00","325.01",1),after:metrics("99.99","226.00","325.99",1),
    delta:metrics("-0.02","1.00","0.98",0)};
  const view=html(DerivedAmountReport,{report:{protocol,taskId:child.taskId,state:"MATCHED",parent,child,
    totals:amounts,rows:[{clientId:"CLIENT-01",...amounts}]}});
  assert.match(view,/<caption>客户 CLIENT-01<\/caption>/);
  assert.match(view,/<caption>客户合计<\/caption>/);
  for(const text of [">-0.02<",">+1.00<",">+0.98<",">0<",parent.contextName,child.contextName,parent.runId,child.runId]) {
    assert.ok(view.includes(text),text);
  }
});

test("pending and changed customer scopes expose a reason without fabricated zeroes or empty result tables",()=>{
  for(const [state,reason,message] of [["PENDING","CHILD_RUNNING","新口径仍在运行"],
    ["UNAVAILABLE","CUSTOMER_SCOPE_CHANGED","包含的客户不同"],["UNAVAILABLE","SOURCE_UNCONFIRMED","尚未核验"]]) {
    const view=html(DerivedAmountReport,{report:{protocol,taskId:child.taskId,state,reason}});
    assert.ok(view.includes(message));
    assert.doesNotMatch(view,/<table|0\.00|查看运行来源/);
  }
});
