import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server, PROJECT} from "../../src/v2/server.mjs";
import {createFcIngress} from "../../src/v2/fc-ingress.mjs";
import {MetadataStore} from "../../src/v2/store.mjs";
import {getContext} from "../../src/v2/context.mjs";
import {ReportManager} from "../../src/v2/reports.mjs";

const alias = "dataset:customer_assets_t1";
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),"shuduo-invited-published-"));
  const store = new MetadataStore(join(root,"meta.sqlite"));
  let modelCalls = 0, computeCalls = 0, modelContext;
  const app = createV2Server({root,store,env:{
    V2_LOCAL_DEVELOPMENT:"false",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",V2_RELEASE_SCHEDULER_MODE:"DISABLED",
  },ingress:createFcIngress({publicHttpEnabled:true}),
    runner:()=>{computeCalls++;throw Error("NO_COMPUTATION");},
    reportPlanner:async input=>{
      modelCalls++;modelContext=input;
      const [dataset] = input.datasets;
      return {model:"TEST_DOUBLE",plan:{kind:"REPORT",datasetId:dataset?.id,name:"虚构计划",
        code:"invited_report_plan",description:"普通合成资产",widgets}};
    },
  });
  const password = "SyntheticPublished!2026";
  function member(name, role) {
    const email = name + "@example.invalid";
    const item = app.auth.bootstrapAdmin({email,password,displayName:"虚构测试成员"});
    store.update("auth_user",item.id,PROJECT,{memberships:[{projectId:PROJECT,role}]});
    return {id:item.id,email};
  }
  const owner = member("owner","ENGINEER"), reader = member("reader","PRODUCT_MANAGER");
  const originalTask = store.create("agent",PROJECT,{submittedBy:owner.id,status:"SUCCEEDED",attempts:[]});
  const release = store.create("release",PROJECT,{sourceAgentTaskId:originalTask.id,submittedBy:owner.id,status:"ACTIVE_LOCAL"});
  const rows = getContext("holdings-t1").expected;
  const batch = store.create("release_run",PROJECT,{releaseId:release.id,sourceAgentTaskId:originalTask.id,
    status:"SUCCEEDED",published:true,publicDeployed:false,schedulerTriggered:true,engine:"Apache Spark",engineVersion:"3.5.7",
    mainSqlExecuted:true,testSqlValidation:{passed:true},rows,validation:{passed:true}});
  const legacy = new ReportManager({store,reportStore:app.reportStore,project:PROJECT,assets:{
    reportRows:()=>({asset:{id:alias,versionId:batch.id,evidenceHash:"fixture-only",
      fields:[{name:"client_id"},{name:"total_assets"}]},rows}),
  }});
  const legacyDataset = legacy.createDataset({assetId:alias,name:"虚构受保护的旧数据集",code:"legacy_published",
    fields:["client_id","total_assets"]});
  const legacySnapshot = legacy.refreshDataset(legacyDataset.id).currentSnapshot;
  const legacyReport = legacy.createReport({name:"虚构受保护旧报表",code:"legacy_report",datasetId:legacyDataset.id,
    description:"原发布批次结果",widgets});
  const legacyRun = legacy.runReport(legacyReport.id).run;
  const oldPlan = store.create("report_agent_plan",PROJECT,{status:"SUCCEEDED",proposal:{datasetId:legacyDataset.id},
    explanation:"虚构旧来源信息"});
  const oldService = app.dataServices.createDapi({name:"虚构本机旧接口",slug:"legacy-source-test",
    sourceReleaseRunId:batch.id,fields:["client_id","total_assets"]});
  await app.dataServices.test(oldService.id,{clientId:"CLIENT-001"});
  app.dataServices.publish(oldService.id);
  const oldGrant = app.dataServices.createApplication({name:"虚构本机旧应用",serviceIds:[oldService.id]});
  const ordinaryAsset = "landing:invited_fixture";
  const metadata=store.create("source_metadata",PROJECT,{columns:[{name:"client_id",type:"STRING"},{name:"total_assets",type:"DECIMAL"}]});
  store.create("offline_sync_task",PROJECT,{targetTable:"invited_fixture",name:"虚构落地",metadataVersionId:metadata.id,
    mapping:{client_id:"client_id",total_assets:"total_assets"},mode:"FULL",status:"SUCCEEDED"});
  app.landingStore.sync({targetTable:"invited_fixture",mode:"FULL",mapping:{client_id:"client_id",total_assets:"total_assets"},
    rows:[{client_id:"FICTIONAL",total_assets:"42.00"}],keyFields:["client_id"],sourceHash:"fixture",
    syncedAt:new Date().toISOString()});
  await new Promise(resolve=>app.server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{
    app.releaseScheduler.shutdown();app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));
    store.close();rmSync(root,{recursive:true,force:true});
  });
  const base = "http://127.0.0.1:"+app.server.address().port+"/api/v2";
  const call = async (path, headers, body) => {
    const response = await fetch(base+path,{method:body===undefined?"GET":"POST",headers:{
      "content-type":"application/json","x-shuduo-client":"workbench","idempotency-key":randomUUID(),...headers,
    },...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  };
  const login = async user => {
    const result=await call("/auth/login",undefined,{email:user.email,password});
    assert.equal(result.status,200);
    return {cookie:result.cookies.map(value=>value.split(";")[0]).join("; "),"x-csrf-token":result.body.csrfToken};
  };
  return {store,app,call,owner:await login(owner),reader:await login(reader),batch,legacyDataset,legacySnapshot,legacyReport,legacyRun,
    oldPlan,oldService,oldGrant,ordinaryAsset,counts:()=>({modelCalls,computeCalls}),context:()=>modelContext};
}
const widgets = [{id:"asset_total",type:"KPI",title:"虚构总额",field:"total_assets",aggregation:"SUM"}];

test("invited asset, report, and service routes cannot read or rematerialize local published evidence",async t=>{
  const f=await fixture(t), id=f.legacyReport.id;
  const snapshot=()=>["report_dataset","report_snapshot","report","report_version","report_run","data_service","service_call"]
    .map(kind=>f.store.list(kind,PROJECT));
  const before=snapshot(), beforeRows=f.app.reportStore.db.prepare("SELECT COUNT(*) AS count FROM report_snapshots").get().count;
  assert.equal((await f.call("/release/runs/"+f.batch.id,f.reader)).status,403);
  assert.equal((await f.call("/assets/"+alias,f.reader)).status,404);
  const assets=await f.call("/assets",f.reader);
  assert.equal(assets.status,200);
  assert(!JSON.stringify(assets.body).includes(alias));
  assert(!JSON.stringify(assets.body).includes(f.oldService.id));
  assert.equal((await f.call("/reports/datasets",f.reader,{
    assetId:alias,name:"无权的数据集",code:"denied_dataset",fields:["client_id","total_assets"],
  })).status,403);
  for(const path of ["/reports/datasets/"+f.legacyDataset.id,"/reports/"+id,"/reports/"+id+"/export"])
    assert.equal((await f.call(path,f.reader)).status,403,path);
  for(const path of ["/reports/datasets/"+f.legacyDataset.id+"/refresh","/reports/"+id+"/run","/reports/"+id+"/versions"])
    assert.equal((await f.call(path,f.reader,{})).status,403,path);
  assert.equal((await f.call("/reports/agent/plans/"+f.oldPlan.id,f.reader)).status,404);
  assert.equal((await f.call("/reports/agent/plans/"+f.oldPlan.id+"/apply",f.reader,{})).status,404);
  const overview=(await f.call("/reports/overview",f.reader)).body;
  assert.equal(overview.counts.runs,0);
  assert(!JSON.stringify(overview).includes(id));
  assert(!JSON.stringify((await f.call("/operations/overview",f.reader)).body).includes(f.legacyRun.id));
  assert.equal((await f.call("/data-services/dapis",f.reader)).status,403);
  assert.equal((await f.call("/data-services/dapis",f.reader,{sourceReleaseRunId:f.batch.id})).status,403);
  assert.deepEqual(snapshot(),before);
  assert.equal(f.app.reportStore.db.prepare("SELECT COUNT(*) AS count FROM report_snapshots").get().count,beforeRows);
  const path="/open/dapis/legacy-source-test?client_id=CLIENT-001";
  const granted={authorization:"Bearer "+f.oldGrant.token};
  assert.equal((await f.call(path)).status,401);
  const allowed=await f.call(path,granted);
  assert.equal(allowed.status,200);
  assert.equal(allowed.body.localTestOnly,true);
  assert.equal(allowed.body.data.length,1);
  f.app.dataServices.revokeApplication(f.oldGrant.application.id);
  const revoked=await f.call(path,granted);
  assert.equal(revoked.status,401);
  assert.equal(revoked.body.data,undefined);
  assert.deepEqual(f.counts(),{modelCalls:0,computeCalls:0});
});

test("ordinary invited reports still materialize and export while a wrong snapshot or legacy plan remains isolated",async t=>{
  const f=await fixture(t);
  const made=await f.call("/reports/datasets",f.reader,{
    assetId:f.ordinaryAsset,name:"普通虚构报表源",code:"invited_clean",fields:["client_id","total_assets"],
  });
  assert.equal(made.status,201);
  const dataset=made.body;
  const ready=await f.call("/reports/datasets/"+dataset.id+"/refresh",f.reader,{});
  assert.equal(ready.status,201);
  const clean=await f.call("/reports",f.reader,{datasetId:dataset.id,name:"普通合成报表",code:"ordinary_report",
    description:"按已有普通数据源核对",widgets});
  assert.equal(clean.status,201);
  assert.equal((await f.call("/reports/"+clean.body.id+"/run",f.reader,{})).status,201);
  const exported=await f.call("/reports/"+clean.body.id+"/export",f.reader);
  assert.equal(exported.status,200);
  assert.match(exported.body.content,/42\.00/);

  const initiated=await f.call("/reports/agent/plans",f.reader,{message:"生成普通资产的报表方案"});
  assert.equal(initiated.status,202);
  let current;
  for(let index=0;index<60;index++){
    current=(await f.call("/reports/agent/plans/"+initiated.body.id,f.reader)).body;
    if(!["QUEUED","RUNNING"].includes(current.status))break;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(current.status,"SUCCEEDED");
  assert.deepEqual(f.context().datasets.map(item=>item.id),[dataset.id]);
  assert.equal((await f.call("/reports/agent/plans/"+initiated.body.id,f.owner)).status,404);

  // A local historical snapshot's data row cannot be made visible by changing
  // only its catalog label to an ordinary asset.
  const {id:oldId, ...tainted}=f.legacySnapshot;
  f.store.create("report_snapshot",PROJECT,{...tainted,datasetId:dataset.id,assetId:f.ordinaryAsset,assetVersionId:"mislabelled"});
  assert.equal((await f.call("/reports/datasets/"+dataset.id,f.reader)).status,403);
  assert.equal((await f.call("/reports/"+clean.body.id+"/export",f.reader)).status,403);
});
