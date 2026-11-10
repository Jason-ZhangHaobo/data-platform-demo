import {publishedReportInput,reportRequestId,publishedReportMetricIds} from './published-report-request.mjs';
import {publishedReportHash} from './published-report-source.mjs';
import {publishedReportTemplate} from './report-template.mjs';
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
export function createPublishedReportWorkflow({store,project,reports,resolveSource,afterStep=()=>{}}){
 const kind='published_report_creation',keyFor=(actor,id)=>`${project}:published-report:v1:${actor}:${id}`;
 const owned=(id,actor)=>{const r=store.get(kind,id,project);if(!r||r.actorId!==actor)throw fail(404,'REPORT_CREATION_NOT_FOUND','未找到本账号的原报表请求');return r;};
 const view=r=>{
  const result={protocol:'shuduo-published-report-creation/v1',id:r.id,requestId:r.requestId,status:r.status,scope:'LOCAL_TEST_ONLY',source:r.input.source,name:r.input.name,stage:r.stage,error:r.error,
    datasetId:r.datasetId,snapshotId:r.snapshotId,reportId:r.reportId,reportVersionId:r.reportVersionId,reportRunId:r.reportRunId,sourceEvidenceHash:r.sourceEvidenceHash,
    metricIds:r.metricIds??r.input.metricIds??[...publishedReportMetricIds],agentIndependentE2E:false,publicDeployed:false};
  if(r.status==='SUCCEEDED'){
   const report=reports.reportDetail(r.reportId),run=report.runs.find(x=>x.id===r.reportRunId),version=report.versions.find(x=>x.id===r.reportVersionId),snapshot=reports.datasetDetail(r.datasetId).snapshots.find(x=>x.id===r.snapshotId);
   if(!run||!version||!snapshot||run.reportId!==report.id||run.reportVersionId!==version.id||run.datasetSnapshotId!==snapshot.id||version.datasetSnapshotId!==snapshot.id||snapshot.assetVersionId!==r.input.source.batchId||snapshot.assetEvidenceHash!==r.sourceEvidenceHash||run.datasetContentHash!==snapshot.contentHash||run.status!=='SUCCEEDED'||run.actualExecution!==true)throw fail(409,'REPORT_CREATION_RECEIPT_CHANGED','原报表请求与固定产物不一致，未重新计算');
   if(r.outputContractId&&(version.outputContractId!==r.outputContractId||snapshot.outputContractId!==r.outputContractId||run.outputContractId!==r.outputContractId||run.distributionValidation?.passed!==true||run.distributionValidation.agentIndependentE2E!==false))throw fail(409,'DISTRIBUTION_REPORT_RECEIPT_CHANGED','分布报表固定契约或独立结果未确认');
   if(r.outputContractId)result.outputContractId=r.outputContractId;
   result.resultHash=run.resultHash;result.rowCount=snapshot.rowCount;result.widgetCount=run.widgets.length;
  }
  return result;
 };
 function advance(id,actor){
  let r=owned(id,actor);if(r.status==='SUCCEEDED')return view(r);
  try{
   const resolved=resolveSource(r.input.source,actor);
   if(resolved.asset.evidenceHash!==r.sourceEvidenceHash)throw fail(409,'REPORT_SOURCE_CHANGED','原发布内容已变化，停止原请求，未改用其他来源');
   const step=(name,create)=>{
    const d=store.deduplicate(`${keyFor(actor,r.requestId)}:${name}`,publishedReportHash({id:r.id,name,sourceEvidenceHash:r.sourceEvidenceHash}),create);
    afterStep(name,d.id);
    r=store.update(kind,r.id,project,{[`${name}Id`]:d.id,stage:name,status:'PREPARING',error:undefined});
    return d.id;
   };
   const suffix=r.id.replaceAll('-','');
   const datasetId=step('dataset',()=>reports.createDataset({name:r.input.name,code:`agent_ds_${suffix}`,fields:resolved.asset.fields.map(f=>f.name)},{publishedSource:r.input.source,actorId:actor}));
   if(!store.get('report_dataset',datasetId,project))throw fail(409,'REPORT_CREATION_RECORD_MISSING','原数据集记录缺失，未重建');
   const snapshotId=step('snapshot',()=>reports.refreshDataset(datasetId,{fixedSnapshotId:r.id}).currentSnapshot);
   const template=publishedReportTemplate(resolved.asset.fields.map(f=>f.name),resolved.context.id);
   if(r.input.metricIds)template.widgets=template.widgets.filter(w=>r.input.metricIds.includes(w.id));
   const reportId=step('report',()=>reports.createReport({name:r.input.name,code:`agent_report_${suffix}`,datasetId,datasetSnapshotId:snapshotId,
    description:`虚构证券 · ${resolved.context.name}。${resolved.context.definition} 来源为${r.input.source.kind==='MANUAL'?'工程师手工代码':'原Agent代码'}的确切发布批次；只聚合已发布数据，不运行新SQL或模型。`,widgets:template.widgets}));
   const report=reports.reportDetail(reportId),original=report.versions.find(v=>v.versionNumber===1&&v.datasetSnapshotId===snapshotId);
   if(!original)throw fail(409,'REPORT_CREATION_VERSION_CHANGED','原报表版本未确认，未选择新版本');
   r=store.update(kind,r.id,project,{reportVersionId:original.id});
   const reportRunId=step('reportRun',()=>{
    if(reports.reportDetail(reportId).currentVersionId!==original.id)throw fail(409,'REPORT_CREATION_VERSION_CHANGED','报表当前版本已变化，未运行其他版本');
    return reports.runReport(reportId).run;
   });
   r=store.update(kind,r.id,project,{status:'SUCCEEDED',stage:'COMPLETE',datasetId,snapshotId,reportId,reportVersionId:original.id,reportRunId,error:undefined});
  }catch(error){r=store.update(kind,r.id,project,{status:'PARTIAL',error:{code:error.code??'REPORT_CREATION_INTERRUPTED',message:[403,409,422].includes(error.status)?error.message:'原请求已保存；请核对后续接原编号，不新建请求。'}});}
  return view(r);
 }
 return{
  submit(input,actor,requestId){
   if(typeof actor!=='string'||!actor)throw fail(403,'REPORT_CREATION_OWNER','需要已授权工程师身份');
   input=publishedReportInput(input);requestId=reportRequestId(requestId);
   const d=store.deduplicate(keyFor(actor,requestId),publishedReportHash(input),()=>{
    const resolved=resolveSource(input.source,actor),template=publishedReportTemplate(resolved.asset.fields.map(f=>f.name),resolved.context.id);
    if(input.metricIds?.some(id=>!template.widgets.some(w=>w.id===id)))throw fail(422,'INVALID_PUBLISHED_REPORT_METRIC','此发布结果不支持所选指标，请先澄清字段与口径');
    return store.create(kind,project,{actorId:actor,requestId,input,...(resolved.asset.outputContractId?{metricIds:input.metricIds??template.widgets.map(w=>w.id),outputContractId:resolved.asset.outputContractId}:{}),sourceEvidenceHash:resolved.asset.evidenceHash,status:'PREPARING',stage:'SOURCE_CONFIRMED'});
   });
   return advance(d.id,actor);
  },
  lookup(requestId,actor){const id=store.deduplicatedId(keyFor(actor,reportRequestId(requestId)));if(!id)throw fail(404,'REPORT_CREATION_NOT_FOUND','未找到本账号的原报表请求');return view(owned(id,actor));},
  advance(id,actor){return advance(reportRequestId(id),actor);},
 };
}
