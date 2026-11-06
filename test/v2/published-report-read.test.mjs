import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {boundPublishedReports,publishedReportSourceKey,checkedPublishedReportExport} from '../../web/src/published-report-read.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,h='a'.repeat(64),other='b'.repeat(64);
const source={kind:'AGENT',taskId:id(1),releaseId:id(2),packageDigest:h,revisionId:id(3),runId:id(4),batchIds:[id(5)]};
function fixture(){
 const widget={id:'total',type:'KPI',title:'客户总资产合计（元）',aggregation:'SUM',field:'total_assets'};
 return {scope:'LOCAL_AGGREGATED_REPORTING',publicDeployed:false,datasets:[{id:id(6),assetId:'dataset:customer_assets_t1',snapshots:[{id:id(7),datasetId:id(6),assetId:'dataset:customer_assets_t1',assetVersionId:id(5),actualMaterialization:true,status:'READY',contentHash:h,assetEvidenceHash:h,rowCount:2,fields:['total_assets','client_id']}]}],reports:[{id:id(8),name:'虚构客户资产报表',currentVersionId:id(9),lastRunId:id(10),versions:[{id:id(9),reportId:id(8),versionNumber:1,datasetId:id(6),datasetSnapshotId:id(7),configHash:h,description:'虚构证券快照聚合',widgets:[widget]}],runs:[{id:id(10),reportId:id(8),reportVersionId:id(9),datasetId:id(6),datasetSnapshotId:id(7),datasetContentHash:h,reportConfigHash:h,status:'SUCCEEDED',actualExecution:true,publicDeployed:false,fullLifecycleE2E:false,resultHash:h,widgets:[{...widget,value:'2750.00',evaluatedCount:2}]}]}]};
}
test('matches exact published batch and immutable report snapshot while preserving manual attribution',()=>{
 const result=boundPublishedReports(fixture(),source);assert.equal(result.length,1);assert.equal(result[0].sourceBatchId,id(5));assert.equal(result[0].widgets[0].value,'2750.00');assert(result[0].exportable);
 assert.deepEqual(boundPublishedReports(fixture(),{...source,batchIds:[id(77)]}),[]);
 const manual={...source,kind:'MANUAL'};delete manual.taskId;
 assert.match(publishedReportSourceKey(manual),/MANUAL/);assert.equal(boundPublishedReports(fixture(),manual).length,1);
 assert.throws(()=>publishedReportSourceKey({...manual,taskId:id(1)}));
 for(const invalid of [{...source,taskId:undefined},{...source,batchIds:[]},{...source,batchIds:[id(5),id(5)]}])assert.throws(()=>boundPublishedReports(fixture(),invalid));
});
test('new dataset snapshot or global latest batch does not replace a pinned historical report',()=>{
 const v=fixture();v.datasets[0].currentSnapshotId=id(20);v.datasets[0].snapshots.push({...v.datasets[0].snapshots[0],id:id(20),assetVersionId:id(21)});
 const report=v.reports[0];report.currentVersionId=id(22);report.versions.unshift({...report.versions[0],id:id(22),versionNumber:2,datasetSnapshotId:id(20)});
 const found=boundPublishedReports(v,source);assert.equal(found.length,1);assert.equal(found[0].snapshotId,id(7));assert.equal(found[0].versionNumber,1);assert.equal(found[0].exportable,false);
});
test('rejects inconsistent report, version, result and snapshot evidence',()=>{
 const edits=[v=>v.datasets[0].snapshots[0].datasetId=id(77),v=>v.datasets[0].snapshots[0].actualMaterialization=false,v=>v.reports[0].versions[0].reportId=id(77),v=>v.reports[0].runs[0].datasetContentHash=other,v=>v.reports[0].runs[0].reportConfigHash=other,v=>v.reports[0].runs[0].reportVersionId=id(77),v=>v.reports[0].runs[0].widgets[0].field='available_cash',v=>v.reports[0].runs[0].widgets[0].evaluatedCount=9,v=>v.reports[0].runs[0].actualExecution=false,v=>v.reports[0].runs[0].publicDeployed=true,v=>v.scope='UNCONFIRMED'];
 for(const edit of edits){const v=fixture();edit(v);assert.throws(()=>boundPublishedReports(v,source),/尚未确认/);}
 for(const value of [null,{},[],{...fixture(),reports:[null]}])assert.throws(()=>boundPublishedReports(value,source));
});
test('CSV export must match the shown report version, run and content hash',async()=>{
 const result=boundPublishedReports(fixture(),source)[0],content='widget_id,title,group,value\ntotal,资产,ALL,2750.00\n';
 const value={fileName:'fictional_report-00000000.csv',contentType:'text/csv; charset=utf-8',content,contentHash:createHash('sha256').update(content).digest('hex'),reportId:result.reportId,reportVersionId:result.versionId,runId:result.runId};
 assert.equal((await checkedPublishedReportExport(value,result)).content,content);
 for(const changed of [{runId:id(77)},{reportVersionId:id(77)},{content:content+'altered'},{contentHash:other},{fileName:'../wrong.csv'}])await assert.rejects(checkedPublishedReportExport({...value,...changed},result));
 await assert.rejects(checkedPublishedReportExport(value,{...result,exportable:false}));
});
