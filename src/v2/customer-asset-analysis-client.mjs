import { inputEvidenceCanonical } from './input-evidence-contract.mjs';
import { publishedReportSource, reportRequestId } from './published-report-request.mjs';

const uuid = value => typeof value==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash = value => typeof value==='string' && /^[a-f0-9]{64}$/.test(value);
const exact = (obj, keys) => obj && typeof obj==='object' && !Array.isArray(obj) &&
  Object.keys(obj).length===keys.length && keys.every(key=>Object.hasOwn(obj,key));
const invalid = () => { throw Error('客户资产分析的报表、原批次或金额未能核对，请重读原报表。'); };

function cents(value) {
  if (typeof value!=='string' || !/^-?(?:0|[1-9]\d{0,37})\.\d{2}$/.test(value) || value==='-0.00') invalid();
  return BigInt(value.replace('.',''));
}

function checkDistribution(entries, denominator, count) {
  if (!Array.isArray(entries) || entries.length<1 || entries.length>500) invalid();
  const labels=new Set();
  let sum=0n;
  for (const entry of entries) {
    if (!exact(entry,['label','marketValue','ratio']) || typeof entry.label!=='string' || !entry.label.trim() ||
        entry.label!==entry.label.trim() || entry.label.length>100 || labels.has(entry.label) ||
        typeof entry.ratio!=='string' || !/^[01]\.\d{6}$/.test(entry.ratio)) invalid();
    labels.add(entry.label);
    const amount=cents(entry.marketValue);
    if (amount<0n || amount>denominator) invalid();
    const ratio=denominator===0n ? 0n : (2_000_000n*amount+denominator)/(2n*denominator);
    if (BigInt(entry.ratio.replace('.',''))!==ratio) invalid();
    sum+=amount;
  }
  if (sum!==denominator || (count===0 && (denominator!==0n || entries.length!==1 || !labels.has('未持仓'))) ||
      (count>0 && labels.has('未持仓'))) invalid();
}

export async function checkedCustomerAssetAnalysis(value, expected) {
  if (!exact(value,['protocol','scope','readOnly','report','source','customers','digest']) ||
      value.protocol!=='shuduo-customer-asset-analysis/v1' || value.scope!=='LOCAL_TEST_ONLY' ||
      value.readOnly!==true || !hash(value.digest)) invalid();
  const {report,source,customers}=value;
  if (!exact(report,['requestId','reportId','versionId','runId','reportSnapshotId','resultHash']) ||
      ![report.requestId,report.reportId,report.versionId,report.runId,report.reportSnapshotId].every(uuid) ||
      !hash(report.resultHash) || report.requestId!==expected.requestId) invalid();
  for (const [field,actual] of Object.entries({reportId:report.reportId,versionId:report.versionId,reportRunId:report.runId,
    reportSnapshotId:report.reportSnapshotId,resultHash:report.resultHash})) {
    if (expected[field]!==undefined && expected[field]!==actual) invalid();
  }
  if (!exact(source,['taskId','releaseId','batchId','sequence','packageDigest','revisionId','developmentRunId',
      'sourceType','syncTaskId','syncRunId','sourceRevisionId','metadataVersionId','landingReceiptHash',
      'landingSnapshotHash','snapshotHash','businessDate','advisorId']) || source.sourceType!=='SERVER_MYSQL' ||
      ![source.taskId,source.releaseId,source.batchId,source.revisionId,source.developmentRunId,source.syncTaskId,
        source.syncRunId,source.sourceRevisionId,source.metadataVersionId].every(uuid) ||
      ![source.packageDigest,source.landingReceiptHash,source.landingSnapshotHash,source.snapshotHash].every(hash) ||
      ![1,2].includes(source.sequence) || typeof source.businessDate!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.businessDate) ||
      typeof source.advisorId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(source.advisorId)) invalid();
  if (expected.source) {
    const pinned=publishedReportSource(expected.source);
    if (pinned.kind!=='AGENT' || pinned.runId!==source.developmentRunId ||
        ['taskId','releaseId','batchId','revisionId','packageDigest'].some(key=>pinned[key]!==source[key])) invalid();
  }
  if (!Array.isArray(customers) || !customers.length || customers.length>500) invalid();
  const keys=new Set();
  for (const customer of customers) {
    if (!exact(customer,['customerKey','clientLabel','totalAssets','holdingMarketValue','availableCash','securityCount',
        'nullMarketValueCount','assetClasses','industries']) || !hash(customer.customerKey) || keys.has(customer.customerKey) ||
        typeof customer.clientLabel!=='string' || !/^[A-Za-z0-9_-]{3}\*{3}[A-Za-z0-9_-]{3}$/.test(customer.clientLabel) ||
        ![customer.securityCount,customer.nullMarketValueCount].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=500)) invalid();
    keys.add(customer.customerKey);
    const holding=cents(customer.holdingMarketValue);
    if (holding<0n || cents(customer.totalAssets)!==holding+cents(customer.availableCash)) invalid();
    checkDistribution(customer.assetClasses,holding,customer.securityCount);
    checkDistribution(customer.industries,holding,customer.securityCount);
  }
  const {digest,...body}=value;
  const bytes=new TextEncoder().encode(inputEvidenceCanonical(body));
  const observed=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  if (Array.from(observed,n=>n.toString(16).padStart(2,'0')).join('')!==digest) invalid();
  return value;
}

export async function readCustomerAssetAnalysis(client, expected) {
  const id=reportRequestId(expected.requestId);
  if (expected.source) publishedReportSource(expected.source);
  return checkedCustomerAssetAnalysis(await client.request('/reports/published/requests/'+id+'/customer-analysis'),expected);
}
