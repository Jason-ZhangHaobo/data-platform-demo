import {createHash} from 'node:crypto';import {isDeepStrictEqual as same} from 'node:util';
import {certifiedDistributionSource} from './distribution-service-source.mjs';
import {normalizedDistributionRows} from './distribution-services.mjs';
import {distributionMetadataById} from './output-contract-metadata.mjs';
import {distributionReportTemplate} from './distribution-report-contract.mjs';
import {getContext} from './context.mjs';import {verifyOutputRows} from './output-contracts.mjs';
const fail=()=>Object.assign(Error('分布报表的确切来源、快照或分类结果未确认'),{status:409,code:'DISTRIBUTION_REPORT_UNPROVEN'});
export function resolveDistributionReportSource({store,project,source,actorId,hash}){
 const get=(k,id)=>store.get(k,id,project),release=get('release',source.releaseId),bundle=get('delivery_package',release?.packageId),batch=get('release_run',source.batchId),agent=get('agent',source.taskId);
 if(source.kind!=='AGENT'||!agent||agent.submittedBy!==actorId&&!(actorId==='local-engineer'&&agent.submittedBy===undefined))throw Object.assign(Error('分布报表须属于原任务发起人'),{status:403,code:'REPORT_SOURCE_OWNER'});
 const proof=certifiedDistributionSource({store,project,run:batch});
 if(!proof||proof.sourceEvidence.sourceTaskId!==source.taskId||proof.sourceEvidence.releaseId!==source.releaseId||proof.sourceEvidence.packageDigest!==source.packageDigest||proof.sourceEvidence.sourceRevisionId!==source.revisionId||proof.sourceEvidence.sourceRunId!==source.runId||bundle?.digest!==source.packageDigest)throw fail();
 const c=proof.outputContract,rows=normalizedDistributionRows(batch.rows,c.id),context=getContext(bundle.manifest.source.contextId);
 return {asset:{id:'dataset:'+c.id,versionId:batch.id,evidenceHash:hash(rows),fields:c.fields,outputContractId:c.id},rows,context:{id:context.id,name:context.name,definition:context.definition},source,sourceEvidence:proof.sourceEvidence};
}
export function normalizeDistributionReportWidgets(widgets,contractId){
 const template=distributionReportTemplate(contractId);if(!template||!Array.isArray(widgets)||!widgets.length||widgets.length>3||new Set(widgets.map(w=>w.id)).size!==widgets.length)throw fail();
 return widgets.map(w=>{const expected=template.widgets.find(v=>v.id===w.id);if(!expected||!same(expected,w))throw fail();return structuredClone(expected);});
}
export function executeDistributionReport({version,snapshot,metadata,hash}){
 const c=distributionMetadataById(version.outputContractId),context=getContext(metadata.contextId);
 if(!c||metadata.outputContractId!==c.id||metadata.contentHash!==snapshot.contentHash||hash(snapshot.rows)!==snapshot.contentHash||snapshot.rowCount!==snapshot.rows.length||metadata.rowCount!==snapshot.rows.length||metadata.sourceEvidence?.agentIndependentE2E!==false||metadata.sourceEvidence.scope!=='LOCAL_TEST_ONLY'||metadata.sourceEvidence.outputContractId!==c.id||metadata.sourceEvidence.sourceReleaseRunId!==metadata.assetVersionId||!verifyOutputRows(snapshot.rows,context))throw fail();
 const definitions=normalizeDistributionReportWidgets(version.widgets,c.id),rows=normalizedDistributionRows(snapshot.rows,c.id);
 const widgets=definitions.map(w=>({...w,evaluatedCount:rows.length,series:rows.map(r=>({group:r[c.dimension],value:String(r[w.field]),partitionKey:createHash('sha256').update(JSON.stringify([r.client_id,r.trade_date])).digest('hex'),clientLabel:r.client_id.slice(0,3)+'***'+r.client_id.slice(-3),tradeDate:r.trade_date,zeroDenominator:rows.filter(v=>v.client_id===r.client_id&&v.trade_date===r.trade_date).every(v=>v.holding_market_value==='0.00')}))}));
 // Independently match every value to the registered case, not to another chart.
 for(const widget of widgets){const expected=context.expected;
  if(widget.series.length!==expected.length||widget.series.some(item=>!expected.some(r=>item.partitionKey===createHash('sha256').update(JSON.stringify([r.client_id,r.trade_date])).digest('hex')&&item.tradeDate===r.trade_date&&item.zeroDenominator===expected.filter(v=>v.client_id===r.client_id&&v.trade_date===r.trade_date).every(v=>/^0(?:\.0+)?$/.test(String(v.holding_market_value)))&&item.clientLabel===r.client_id.slice(0,3)+'***'+r.client_id.slice(-3)&&item.group===r[c.dimension]&&item.value===String(r[widget.field]))))throw fail();
 }
 return {widgets,distributionValidation:{passed:true,outputContractId:c.id,scope:'LOCAL_TEST_ONLY',agentIndependentE2E:false},sourceEvidence:metadata.sourceEvidence};
}
