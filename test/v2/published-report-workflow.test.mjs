import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdtempSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{MetadataStore}from'../../src/v2/store.mjs';import{ReportDataStore,ReportManager}from'../../src/v2/reports.mjs';import{resolvePublishedReportSource}from'../../src/v2/published-report-source.mjs';import{createPublishedReportWorkflow}from'../../src/v2/published-report-workflow.mjs';import{seedLocalServiceSource}from'./fixtures/local-service-sources.mjs';
const project='synthetic-published-report',actor='local-engineer';
function managers(store,reportStore,afterStep){const resolve=(source,actorId)=>resolvePublishedReportSource({store,project,source,actorId});const reports=new ReportManager({store,reportStore,assets:{reportRows(){throw Error('GLOBAL_LATEST_FORBIDDEN');}},project,resolvePublishedSource:resolve});return{reports,workflow:createPublishedReportWorkflow({store,project,reports,resolveSource:resolve,afterStep})};}
function setup(t,{manual=false,contextId='holdings-t1',persistent=false}={}){
 const dir=persistent?mkdtempSync(join(tmpdir(),'shuduo-report-resume-')):undefined,store=new MetadataStore(dir?join(dir,'meta.sqlite'):':memory:'),data=new ReportDataStore(dir?join(dir,'reports.sqlite'):':memory:');
 const f=seedLocalServiceSource({store,project,contextId});if(manual)store.update('revision',f.revision.id,project,{source:'MANUAL',author:actor,manualProvenance:{actorId:actor,kind:'ENGINEER_EDIT',agentIndependentE2E:false}});
 const source={kind:manual?'MANUAL':'AGENT',...(manual?{}:{taskId:f.agent.id}),releaseId:f.release.id,packageDigest:f.bundle.digest,revisionId:f.revision.id,runId:f.codeRun.id,batchId:f.batches[0].id};
 t.after(()=>{try{data.close();}catch{}try{store.close();}catch{}});return{...f,store,data,source,dir,...managers(store,data)};
}
const count=(s,k)=>s.list(k,project).length;
test('creates a pinned actual snapshot and aggregates both semantic families, with replay and actor isolation',t=>{
 for(const [contextId,manual]of[['holdings-t1',true],['stock-cash-t1',false]]){
  const f=setup(t,{contextId,manual}),requestId=randomUUID(),body={name:'虚构财富顾问资产报告',source:f.source};
  const job=f.workflow.submit(body,actor,requestId);assert.equal(job.status,'SUCCEEDED');assert.equal(job.widgetCount,5);assert.equal(job.source.batchId,f.batches[0].id);
  const report=f.reports.reportDetail(job.reportId),run=report.runs.find(r=>r.id===job.reportRunId);assert.equal(run.datasetSnapshotId,job.snapshotId);assert.equal(run.widgets.find(w=>w.id==='total_assets').value,manual?'2750.00':'2250.00');if(!manual)assert.equal(run.widgets.find(w=>w.id==='total_assets').title,'股票持仓＋现金合计（元）');
  assert.equal(f.reports.datasetDetail(job.datasetId).publishedSource.batchId,f.source.batchId);
  assert.deepEqual(f.workflow.submit(body,actor,requestId),job);assert.deepEqual(f.workflow.lookup(requestId,actor),job);assert.deepEqual(f.workflow.advance(job.id,actor),job);
  for(const k of ['report_dataset','report_snapshot','report','report_run','published_report_creation'])assert.equal(count(f.store,k),1);
  assert.throws(()=>f.workflow.submit({...body,name:'更改原请求'},actor,requestId),{status:409});
  assert.throws(()=>f.workflow.lookup(requestId,'other-engineer'),{status:404});assert.throws(()=>f.workflow.advance(job.id,'other-engineer'),{status:404});
  assert.throws(()=>f.workflow.submit(body,'other-engineer',randomUUID()),{status:403});
 }
});
test('fixed source cannot become global latest on refresh and changed release evidence cannot start a report',t=>{
 const f=setup(t,{manual:true}),job=f.workflow.submit({name:'虚构固定批次报告',source:f.source},actor,randomUUID());
 seedLocalServiceSource({store:f.store,project,contextId:'stock-cash-t1'});
 const refreshed=f.reports.refreshDataset(job.datasetId);assert.equal(refreshed.currentSnapshot.assetVersionId,f.source.batchId);assert.equal(refreshed.currentSnapshot.assetEvidenceHash,job.sourceEvidenceHash);
 f.store.update('release_run',f.source.batchId,project,{schedulerTriggered:false});
 assert.throws(()=>f.workflow.submit({name:'错误来源报告',source:f.source},actor,randomUUID()),{code:'REPORT_SOURCE_UNPROVEN'});assert.equal(count(f.store,'published_report_creation'),1);
 assert.throws(()=>f.reports.refreshDataset(job.datasetId),{code:'REPORT_SOURCE_UNPROVEN'});
 assert.equal(f.workflow.lookup(job.requestId,actor).reportRunId,job.reportRunId);
});
test('snapshot written before metadata rollback is reused after both stores reopen',t=>{
 const f=setup(t,{manual:true,persistent:true}),requestId=randomUUID(),body={name:'虚构中断恢复报表',source:f.source};let once=true;
 f.data.setMutationListener(()=>{if(once){once=false;throw Error('SYNTHETIC_CRASH_AFTER_SNAPSHOT_INSERT');}});
 const partial=f.workflow.submit(body,actor,requestId);assert.equal(partial.status,'PARTIAL');assert.equal(count(f.store,'report_dataset'),1);assert.equal(count(f.store,'report_snapshot'),0);assert.equal(f.data.db.prepare('SELECT count(*) n FROM report_snapshots').get().n,1);
 f.data.close();f.store.close();const store=new MetadataStore(join(f.dir,'meta.sqlite')),data=new ReportDataStore(join(f.dir,'reports.sqlite'));t.after(()=>{data.close();store.close();});
 const next=managers(store,data),done=next.workflow.submit(body,actor,requestId);assert.equal(done.id,partial.id);assert.equal(done.status,'SUCCEEDED');
 for(const k of ['report_dataset','report_snapshot','report','report_version','report_run','published_report_creation'])assert.equal(count(store,k),1);assert.equal(data.db.prepare('SELECT count(*) n FROM report_snapshots').get().n,1);
});
test('lost checkpoint after a committed stage resumes original records without new aggregation',t=>{
 const f=setup(t,{manual:true});let interrupted=true;
 const w=managers(f.store,f.data,name=>{if(name==='reportRun'&&interrupted){interrupted=false;throw Error('SYNTHETIC_CHECKPOINT_LOSS');}}).workflow;
 const requestId=randomUUID(),partial=w.submit({name:'虚构已运行回执恢复',source:f.source},actor,requestId);assert.equal(partial.status,'PARTIAL');assert.equal(count(f.store,'report_run'),1);
 const done=w.advance(partial.id,actor);assert.equal(done.status,'SUCCEEDED');assert.equal(count(f.store,'report_run'),1);assert.equal(w.lookup(requestId,actor).reportRunId,done.reportRunId);
});
