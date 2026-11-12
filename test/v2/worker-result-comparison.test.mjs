// Load only pure Worker functions with Python's stdlib AST. No sqlglot/pyspark
// import, Spark process, model call, cloud request or private input is required.
import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const worker=fileURLToPath(new URL("../../src/v2/worker.py",import.meta.url));
const harness=String.raw`
import ast, json, sys, re, hashlib
from decimal import Decimal
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1]).parent))
from output_contracts import preflight_contexts, registered_contract, verify_output
tree=ast.parse(Path(sys.argv[1]).read_text(encoding="utf-8"))
names={"is_fund_context","comparison_number","verify","preflight_execution_contexts","verify_context_rows","execute_with_validation"}
constants={"COMPARISON_FIELDS","COMPARISON_LIMIT"}
selected=[node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name in names or
    isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id in constants for target in node.targets)]
scope={"Decimal":Decimal,"re":re,"hashlib":hashlib,"preflight_contexts":preflight_contexts,"registered_contract":registered_contract,"verify_output":verify_output}
exec(compile(ast.Module(body=selected,type_ignores=[]),"pure-worker-verification","exec"),scope)
input=json.load(sys.stdin)
if input["operation"]=="numbers":
    result=[scope["comparison_number"](item) for item in input["values"]]
elif input["operation"]=="verify":
    result=scope["verify"](input["rows"],input["expected"])
else:
    calls=[]
    def execute(_spark,_sql,context):
        calls.append(context["id"])
        return {"rows":context["actual"],"columns":[],"engine":"SYNTHETIC_NO_SPARK","engineVersion":"synthetic"}
    scope["execute"]=execute
    scope["execute_test_sql"]=lambda *_args:{"passed":input.get("testPassed",True),"sqlHash":"synthetic"}
    try:
        result=scope["execute_with_validation"](None,"SYNTHETIC_SQL_NOT_EXECUTED",input["context"],input["validationContexts"],input.get("testSql"))
        result={"result":result,"executedContextIds":calls}
    except ValueError:
        result={"error":"INVALID_CASE_COUNT","executedContextIds":calls}
print(json.dumps(result,ensure_ascii=False))
`;
function run(input){
  const child=spawnSync("python3",["-c",harness,worker],{input:JSON.stringify(input),encoding:"utf8",timeout:10000,maxBuffer:1024*1024,
    env:{PATH:"/usr/bin:/bin:/usr/local/bin",PYTHONUTF8:"1"}});
  assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);return JSON.parse(child.stdout);
}
const row=(client_id="CLIENT-001",patch={})=>({client_id,holding_market_value:"1000.25",available_cash:"300.5",total_assets:"1300.75",security_count:2,...patch});
const verify=(rows,expected)=>run({operation:"verify",rows,expected});

test("amount mismatches have bounded canonical decimal strings, while error summaries contain no numeric answers",()=>{
  const expected=[row()],actual=[row("CLIENT-001",{holding_market_value:"2000.2500",total_assets:"2300.7500"})],value=verify(actual,expected);
  assert.equal(value.passed,false);assert.deepEqual(value.comparison,{schema:"shuduo-result-comparison/v1",totalMismatches:2,truncated:false,mismatches:[
    {kind:"VALUE_MISMATCH",clientId:"CLIENT-001",field:"holding_market_value",expected:"1000.25",actual:"2000.25"},
    {kind:"VALUE_MISMATCH",clientId:"CLIENT-001",field:"total_assets",expected:"1300.75",actual:"2300.75"},
  ]});
  assert.ok(value.issues.every(issue=>issue.endsWith("结果不符")));
  for(const amount of ["1000.25","2000.25","1300.75","2300.75"])assert.equal(JSON.stringify(value.issues).includes(amount),false);
});
test("duplicates never pick the last row as a unique value; missing and out-of-scope rows are independently reported",()=>{
  const value=verify([row("CLIENT-001",{total_assets:"999999.99"}),row(),row("SYNTHETIC_OUTSIDE_PRIVATE_ID")],[row(),row("CLIENT-002")]);
  assert.equal(value.passed,false);assert.deepEqual(value.comparison.mismatches,[
    {kind:"CLIENT_COUNT",expectedCount:2,actualCount:3},{kind:"DUPLICATE_CLIENT",clientId:"CLIENT-001",actualCount:2},
    {kind:"MISSING_CLIENT",clientId:"CLIENT-002"},{kind:"OUT_OF_SCOPE_CLIENTS",actualCount:1},
  ]);
  assert.equal(value.comparison.totalMismatches,4);assert.equal(value.comparison.truncated,false);
  assert.equal(JSON.stringify(value.comparison).includes("SYNTHETIC_OUTSIDE_PRIVATE_ID"),false);
  assert.equal(value.comparison.mismatches.some(item=>item.kind==="VALUE_MISMATCH"),false);
  assert.ok(value.issues.includes("客户记录重复"));assert.ok(value.issues.includes("缺少客户 CLIENT-002"));
});
test("invalid actual values never echo raw text; output-field failures emit one fixed marker",()=>{
  for(const actual of ["SYNTHETIC_PRIVATE_VALUE",null,"NaN","sNaN","Infinity","-Infinity","1e999999999999999999999","1e38","1e-19",true]){
    const value=verify([row("CLIENT-001",{holding_market_value:actual})],[row()]);
    assert.equal(value.passed,false);assert.deepEqual(value.comparison.mismatches,[{kind:"INVALID_VALUE",clientId:"CLIENT-001",field:"holding_market_value",expected:"1000.25"}]);
    assert.equal(value.comparison.totalMismatches,1);assert.equal(value.comparison.truncated,false);
    assert.equal(Object.hasOwn(value.comparison.mismatches[0],"actual"),false);assert.equal(JSON.stringify(value).includes("SYNTHETIC_PRIVATE_VALUE"),false);
  }
  const value=verify([{...row(),SYNTHETIC_UNKNOWN_FIELD:"SYNTHETIC_PRIVATE_VALUE",ANOTHER_FIELD:"hidden"}],[row()]);
  assert.equal(value.passed,false);assert.deepEqual(value.comparison.mismatches,[{kind:"OUTPUT_FIELDS"}]);
  assert.equal(JSON.stringify(value).includes("SYNTHETIC_UNKNOWN_FIELD"),false);assert.equal(JSON.stringify(value).includes("SYNTHETIC_PRIVATE_VALUE"),false);
});
test("decimal precision survives beyond default Decimal context and giant exponents are rejected before expansion",()=>{
  const expected="12345678901234567890123456789012345678.123456789012345678",actual="12345678901234567890123456789012345678.123456789012345679";
  const value=verify([row("CLIENT-001",{holding_market_value:actual})],[row("CLIENT-001",{holding_market_value:expected})]);
  assert.equal(value.comparison.mismatches[0].expected,expected);assert.equal(value.comparison.mismatches[0].actual,actual);assert.equal(value.passed,false);
  assert.deepEqual(run({operation:"numbers",values:["+1.234500e2","-0.0000","0.000000000000000001","-99999999999999999999999999999999999999.123456789012345678",
    "999999999999999999999999999999999999999","0.0000000000000000001","1e1000000000","1e-1000000000","0e1000000000","1".repeat(129)]}),
    ["123.45","0","0.000000000000000001","-99999999999999999999999999999999999999.123456789012345678",null,null,null,null,null,null]);
  for(const actualCount of ["-1","1.5"]){const result=verify([row("CLIENT-001",{security_count:actualCount})],[row()]);
    assert.deepEqual(result.comparison.mismatches,[{kind:"VALUE_MISMATCH",clientId:"CLIENT-001",field:"security_count",expected:"2",actual:actualCount}]);}
  for(const invalidCount of ["-1","1.5"]){const result=verify([row("CLIENT-001",{security_count:invalidCount})],[row("CLIENT-001",{security_count:invalidCount})]);
    assert.equal(result.passed,false);assert.equal(result.comparison.mismatches.length,0);assert.equal(result.comparison.totalMismatches,1);assert.equal(result.comparison.truncated,true);}
});
test("each scenario retains at most twenty details but counts every mismatch and never claims a truncated failure passed",()=>{
  const expected=Array.from({length:30},(_,index)=>row(`CLIENT-${index}`,{holding_market_value:"0",available_cash:"0",total_assets:"0",security_count:0}));
  const actual=expected.map(value=>({...value,holding_market_value:"1",available_cash:"1",total_assets:"1",security_count:1}));
  const value=verify(actual,expected);assert.equal(value.passed,false);assert.equal(value.comparison.mismatches.length,20);
  assert.equal(value.comparison.totalMismatches,120);assert.equal(value.comparison.truncated,true);
  assert.ok(value.comparison.mismatches.every(item=>item.kind==="VALUE_MISMATCH"));
});
test("unsafe or unregistered client identifiers are omitted rather than echoed, with omissions counted honestly",()=>{
  const unsafe="SYNTHETIC<PRIVATE_ID>";
  const value=verify([],[row(unsafe)]);assert.equal(JSON.stringify(value.comparison).includes(unsafe),false);
  assert.equal(value.comparison.totalMismatches,2);assert.equal(value.comparison.mismatches.length,1);assert.equal(value.comparison.truncated,true);
  for(const size of [80,81]){const id="C".repeat(size),result=verify([],[row(id)]);
    assert.equal(result.comparison.mismatches.some(item=>item.kind==="MISSING_CLIENT"),size===80);assert.equal(result.comparison.truncated,size===81);}
});
test("five regression scenarios pass their own comparison through and enforce the total 100-detail cap",()=>{
  const expected=Array.from({length:6},(_,index)=>row(`CLIENT-${index}`,{holding_market_value:"0",available_cash:"0",total_assets:"0",security_count:0}));
  const actual=expected.map(value=>({...value,holding_market_value:"1",available_cash:"1",total_assets:"1",security_count:1}));
  const contexts=Array.from({length:5},(_,index)=>({id:`case-${index}`,name:`虚构场景${index}`,expected,actual}));
  const {result,executedContextIds}=run({operation:"execute",context:contexts[0],validationContexts:contexts});
  assert.equal(result.status,"VALIDATION_FAILED");assert.equal(result.validation.passed,false);assert.equal(result.validation.regressions.length,5);
  assert.deepEqual(executedContextIds,contexts.map(context=>context.id));
  assert.equal(result.validation.regressions.reduce((sum,entry)=>sum+entry.comparison.mismatches.length,0),100);
  for(const entry of result.validation.regressions){assert.equal(entry.comparison.totalMismatches,24);assert.equal(entry.comparison.truncated,true);}
  const six=run({operation:"execute",context:contexts[0],validationContexts:Array.from({length:5},(_,index)=>({...contexts[0],id:`other-${index}`}))});
  assert.deepEqual(six,{error:"INVALID_CASE_COUNT",executedContextIds:[]});
});
test("complete success still requires every scenario and tests.sql, independent of the comparison display",()=>{
  const expected=[row()],contexts=Array.from({length:5},(_,index)=>({id:`case-${index}`,name:`虚构场景${index}`,expected,actual:expected}));
  const passed=run({operation:"execute",context:contexts[0],validationContexts:contexts}).result;
  assert.equal(passed.status,"SUCCEEDED");assert.equal(passed.validation.passed,true);
  assert.ok(passed.validation.regressions.every(entry=>entry.passed&&entry.comparison.totalMismatches===0&&!entry.comparison.truncated));
  const changed=structuredClone(contexts);changed[4].actual=[row("CLIENT-001",{total_assets:"0"})];
  const failed=run({operation:"execute",context:changed[0],validationContexts:changed}).result;
  assert.equal(failed.validation.selectedPassed,true);assert.equal(failed.status,"VALIDATION_FAILED");assert.equal(failed.validation.regressions[4].passed,false);
  const badTest=run({operation:"execute",context:contexts[0],validationContexts:contexts,testSql:"SYNTHETIC_TEST_SQL",testPassed:false}).result;
  assert.equal(badTest.status,"VALIDATION_FAILED");assert.equal(badTest.testSqlValidation.passed,false);
});
