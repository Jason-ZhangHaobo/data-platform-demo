import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { generateAgentIntent, generateReportPlan } from "../src/v2/model.mjs";

const message = "请用第二批持仓生成财富顾问五指标报表，列出客户总资产、持仓市值、证券数量、资产类别分布和行业分布。";
const objective = "使用已选发布的第二批为财富顾问编制客户资产分析，列明总资产、持仓市值、证券数量，以及资产类别与行业分布。";
const reportName = "虚构客户资产分析 · 第2批";
const metrics = ["total_assets","holding_value","client_security_count","asset_class_distribution","industry_distribution"];
const dimensions = ["asset_class_distribution","industry_distribution"];
const summaryMetrics = ["total_assets","holding_value","client_security_count"];
const usage = {prompt_tokens:20,completion_tokens:12,total_tokens:32};

// Only the provider transport is synthetic. The product adapters build and parse
// the actual requests, so we can inspect exactly what the two planners would see.
export function fixtureWealthReportPlanners() {
  const counts = {intent:0,report:0};
  const env = {DASHSCOPE_API_KEY:"fictional-test-only", V2_MODEL:"synthetic-wealth-planner",
    V2_MODEL_BASE_URL:"https://provider.example.invalid/v1"};
  const reply = content => Response.json({choices:[{message:{content:JSON.stringify(content)}}],usage});
  function prompt(request) {
    const payload = JSON.parse(request.body);
    assert.equal(payload.model,env.V2_MODEL);
    const content = payload.messages.find(item=>item.role==="user").content;
    // Assert without printing the full prompt if the data boundary regresses.
    assert.ok(!/CLIENT-00[12]|SEC-DEMO-00[123]|"(?:1300|1000|700|500|300|200)\.00"|"rows"\s*:|"expected"\s*:|"customers"\s*:|"customerKey"\s*:/.test(content),
      "Unexpected customer or holding data in a planning prompt");
    return JSON.parse(content);
  }
  return {
    counts,
    async intentPlanner(input) {
      assert.equal(++counts.intent,1,"Unexpected duplicate intent planning");
      assert.equal(input.pinnedReportBatch,true);
      const result=await generateAgentIntent(input,env,async(_url,request)=>{
        const p=prompt(request);
        assert.equal(p.request,message);
        assert.equal(p.pinnedReportBatch,true);
        assert.ok(p.destinations.some(d=>d.id==="reports"));
        return reply({destinationId:"reports",summary:"从指定第二批生成财富顾问报表",
          rationale:"需求对应已选持仓发布批次的数据报表能力",confidence:1,
          steps:[{destinationId:"reports",objective}]});
      });
      return {...result,mode:"TEST_DOUBLE"};
    },
    async reportPlanner(input) {
      assert.equal(++counts.report,1,"Unexpected duplicate report planning");
      const result=await generateReportPlan(input,env,async(_url,request)=>{
        const p=prompt(request);
        assert.equal(p.request,objective);
        const publication=p.publishedSource, detail=publication.customerAnalysis;
        assert.deepEqual(publication.fields.map(field=>field.name),
          ["client_id","holding_market_value","available_cash","total_assets","security_count"]);
        assert.equal(detail.kind,"MYSQL_HOLDINGS_CUSTOMER_ANALYSIS");
        assert.equal(detail.sourceType,"SERVER_MYSQL");
        assert.deepEqual([...detail.metricIds].sort(),[...metrics].sort());
        assert.deepEqual([...detail.dimensions].sort(),["asset_class","industry"]);
        assert.match(detail.denominator,/持仓市值/);
        assert.match(detail.denominator,/现金/);
        for (const key of ["landingReceiptHash","landingSnapshotHash","snapshotHash"])
          assert.match(detail[key],/^[a-f0-9]{64}$/);
        return reply({kind:"PUBLISHED_REPORT",name:reportName,metricIds:metrics,
          explanation:"使用已发布的客户汇总与同批冻结持仓明细，现金只计入总资产。"});
      });
      return {...result,mode:"TEST_DOUBLE"};
    },
  };
}

async function waitForPlan(client,path) {
  const deadline = Date.now()+20000;
  let task = await client.request(path);
  while (["QUEUED","RUNNING"].includes(task.status) && Date.now()<deadline) {
    await delay(50);
    task = await client.request(path);
  }
  assert.equal(task.status,"SUCCEEDED",path+" ended "+task.status+" "+(task.error?.code??""));
  return task;
}

export async function createWealthReportFromConversation(client,source,otherBatchId) {
  const post = (path,body,idempotencyKey=randomUUID()) => client.request(path,{method:"POST",body,idempotencyKey});
  const key=randomUUID(), body={message,approvalMode:"REQUEST_APPROVAL",reportSource:source};
  // The initial POST has taken effect but the sender loses its response.
  await post("/agent/intents",body,key);
  const originalPath="/agent/intent-requests/"+key;
  const intent=await waitForPlan(client,originalPath);
  const path="/agent/intents/"+intent.id;
  assert.deepEqual(intent.reportSource,source);
  assert.equal(intent.requestId,key);
  assert.equal(intent.messageHash,createHash("sha256").update(message).digest("hex"));
  assert.equal(intent.message,undefined);
  await assert.rejects(client.request(originalPath,{authorization:"Bearer synthetic-unrelated-fixture"}),error=>error.status===403);
  assert.equal((await post("/agent/intents",body,key)).id,intent.id);
  assert.deepEqual(intent.route.steps.map(s=>s.destinationId),["reports"]);
  const reviewedObjective=intent.route.steps[0].objective;
  assert.equal(reviewedObjective,objective);
  assert.notEqual(reviewedObjective,message);
  const catalog=await client.request("/agent/tools"), tool=catalog.tools.find(t=>t.id==="reports");
  assert.ok(tool);
  const input={message:reviewedObjective,source};
  const contract={catalogVersion:catalog.version,contractDigest:catalog.contractDigest};
  await post("/agent/tools/reports/validate",{...contract,input});
  const approvalKey=randomUUID(), approval=await post(path+"/approvals",{destinationId:"reports"},approvalKey);
  assert.equal(approval.status,"APPROVED");
  const invoke=path+"/tools/reports/invoke", invocation={...contract,input,approvalId:approval.id};
  await assert.rejects(post(invoke,{...invocation,input:{message:objective,source:{...source,batchId:otherBatchId}}}),
    error=>error.code==="AGENT_REPORT_SOURCE_MISMATCH");
  const started=await post(invoke,invocation);
  const planPath=tool.detailPath.replace("{id}",started.specialist.id), plan=await waitForPlan(client,planPath);
  assert.equal(plan.planMode,"PUBLISHED_SOURCE_REPORT_V1");
  assert.deepEqual(plan.sourceBinding,source);
  assert.equal(plan.planningMode,"TEST_DOUBLE");
  assert.deepEqual(plan.proposal.metricIds,[...metrics].sort());
  assert.deepEqual(plan.proposal.widgets.map(w=>w.id).sort(),[...summaryMetrics].sort());
  assert.deepEqual([...plan.proposal.customerAnalysis.metricIds].sort(),[...dimensions].sort());
  assert.equal(plan.proposal.customerAnalysis.kind,"MYSQL_HOLDINGS_CUSTOMER_ANALYSIS");
  assert.equal((await post(invoke,invocation)).specialist.id,plan.id);
  assert.equal((await client.request(path+"/approvals")).length,1);
  const apply=tool.applyPath.replace("{id}",plan.id);
  await assert.rejects(post(apply,{proposalHash:"0".repeat(64)}),error=>error.status===409);
  await post(apply,{proposalHash:plan.proposalHash});
  // Reopen the conversation without retaining the original apply response.
  const recovered=await client.request(originalPath);
  const graph=await client.request("/agent/intents/"+recovered.id+"/graph");
  assert.equal(graph.steps.length,1);
  assert.equal(graph.steps[0].specialistStatus,"APPLIED");
  assert.equal(graph.steps[0].specialistTaskId,plan.id);
  const detail=await client.request(tool.detailPath.replace("{id}",graph.steps[0].specialistTaskId));
  const receipt=detail.reportCreation;
  assert.equal(receipt.status,"SUCCEEDED");
  assert.equal(receipt.requestId,plan.id);
  assert.deepEqual(receipt.source,source);
  assert.deepEqual((await post(apply,{proposalHash:plan.proposalHash})),receipt);
  return receipt;
}
