import {createHash} from 'node:crypto';import {isDeepStrictEqual as same} from 'node:util';
import {certifiedDistributionSource} from './distribution-service-source.mjs';
import {normalizedDistributionRows} from './distribution-services.mjs';
import {fundContext} from "./fund-lookthrough.mjs";
import {distributionReportTemplate, distributionReportMetadata, fundReportContractId} from "./distribution-report-contract.mjs";
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
export function executeDistributionReport({version,snapshot,metadata,hash}) {
 const contract = distributionReportMetadata(version.outputContractId), source = metadata.sourceEvidence;
 const fund = contract?.id === fundReportContractId;
 const context = fund ? fundContext(metadata.contextId) : getContext(metadata.contextId);
 if (!contract || !context || metadata.outputContractId !== contract.id || metadata.contentHash !== snapshot.contentHash ||
     hash(snapshot.rows) !== snapshot.contentHash || snapshot.rowCount !== snapshot.rows.length ||
     metadata.rowCount !== snapshot.rows.length || source?.agentIndependentE2E !== false || source.scope !== "LOCAL_TEST_ONLY" ||
     source.outputContractId !== contract.id || source.sourceReleaseRunId !== metadata.assetVersionId) throw fail();

 const definitions = normalizeDistributionReportWidgets(version.widgets, contract.id);
 const rows = normalizedDistributionRows(snapshot.rows, contract.id);
 if (fund) {
  if (metadata.contextId !== context.id || source.protocol !== "shuduo-fund-consumption-source/v1" ||
      source.engineClassification !== "LOCAL_SPARK_PROCESS" || source.eligibleForService !== true ||
      source.businessDate !== context.businessDate || source.batchId !== metadata.assetVersionId ||
      source.rowCount !== rows.length || metadata.assetEvidenceHash !== hash(rows) ||
      source.resultDigest !== createHash("sha256").update(JSON.stringify(rows)).digest("hex") ||
      !same(rows, normalizedDistributionRows(context.expected, contract.id))) throw fail();
 } else if (!verifyOutputRows(snapshot.rows, context)) throw fail();

 const entity = fund ? "portfolio_id" : "client_id", amount = fund ? "exposure_amount" : "holding_market_value";
 const partition = row => createHash("sha256").update(JSON.stringify([row[entity],row.trade_date])).digest("hex");
 const masked = value => value.slice(0,3) + "***" + value.slice(-3);
 const zero = (values, row) => values.filter(value => value[entity] === row[entity] && value.trade_date === row.trade_date)
  .every(value => /^0(?:\.0+)?$/.test(String(value[amount])));
 const widgets = definitions.map(definition => ({ ...definition, evaluatedCount: rows.length, series: rows.map(row => ({
  group: row[contract.dimension], value: String(row[definition.field]), partitionKey: partition(row),
  clientLabel: masked(row[entity]), tradeDate: row.trade_date, zeroDenominator: zero(rows, row),
 })) }));
 // Compare each displayed value with its independent, registered source row.
 for (const widget of widgets) {
  if (widget.series.length !== context.expected.length || widget.series.some(item => !context.expected.some(row =>
    item.partitionKey === partition(row) && item.tradeDate === row.trade_date &&
    item.zeroDenominator === zero(context.expected, row) && item.clientLabel === masked(row[entity]) &&
    item.group === row[contract.dimension] && item.value === String(row[widget.field])))) throw fail();
 }
 return { widgets, distributionValidation: { passed: true, outputContractId: contract.id, scope: "LOCAL_TEST_ONLY", agentIndependentE2E: false },
  sourceEvidence: source };
}
