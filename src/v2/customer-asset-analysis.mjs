import { isDeepStrictEqual as same } from 'node:util';
import { formatCents } from './derived-amounts.mjs';
import { publishedReportHash } from './published-report-source.mjs';
import { archivedSyncSqlInput } from './sync-sql-archive.mjs';
import { readSyncSqlInput } from './sync-sql-input.mjs';
import { archivedSyncInputKind } from './sync-sql-selection.mjs';
import { assertSyncReportWidgets, isSyncReportEvidence } from './sync-sql-report.mjs';
import { equalValidationNumber } from './validation-number.mjs';

const unproven = () => Object.assign(Error('原报表、发布批次与冻结持仓明细未能核对，请重新读取同一报表。'),
  { status:409, code:'CUSTOMER_ANALYSIS_UNPROVEN' });
const unsupported = () => Object.assign(Error('客户资产分析需要来自已核验 MySQL 全量持仓的 Agent 发布报表。'),
  { status:422, code:'CUSTOMER_ANALYSIS_UNSUPPORTED' });

function cents(value) {
  const parsed = typeof value === 'string' && /^(-?)(\d{1,38})(?:\.(\d{1,2}))?$/.exec(value);
  if (!parsed) throw unproven();
  const amount = BigInt(parsed[2]) * 100n + BigInt((parsed[3] ?? '').padEnd(2,'0'));
  return parsed[1] ? -amount : amount;
}

function tableRows(context, tableName, fields) {
  const table = context.tables.find(item=>item.name===tableName);
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) throw unproven();
  const names = table.columns.map(([name])=>name);
  const columns = fields.map(name=>names.indexOf(name));
  if (new Set(names).size!==names.length || columns.includes(-1)) throw unproven();
  return table.rows.map(row=>{
    if (!Array.isArray(row) || row.length!==names.length) throw unproven();
    return columns.map(index=>row[index]);
  });
}

function classifiedLabel(value) {
  if (value===null) return '未分类';
  if (typeof value!=='string') throw unproven();
  return value.trim() || '未分类';
}

function distribution(groups, total) {
  if (!groups.size) return [{label:'未持仓',marketValue:'0.00',ratio:'0.000000'}];
  return [...groups].sort(([left,a],[right,b])=>a===b ? left.localeCompare(right,'zh-CN') : a>b ? -1 : 1)
    .map(([label, amount])=>{
      // Non-negative values, rounded half-up to six decimal places.
      const parts = total===0n ? 0n : (2_000_000n*amount+total)/(2n*total);
      return {label, marketValue:formatCents(amount), ratio:(parts/1_000_000n)+'.'+String(parts%1_000_000n).padStart(6,'0')};
    });
}

// Report summaries and distribution details are independently checked at the
// same client/date grain. Cash is aggregated separately from the position rows.
export function customerAssetMetrics(context, publishedRows) {
  const clients = new Map();
  for (const [id,advisor] of tableRows(context,'accounts',['client_id','advisor_id'])) {
    if (advisor===context.advisorId && !clients.has(id))
      clients.set(id,{holdings:0n,cash:0n,securities:new Set(),positions:new Map(),classes:new Map(),industries:new Map(),nulls:0});
  }
  const fields = ['client_id','trade_date','position_id','security_code','asset_class','industry','market_value'];
  for (const [id,date,position,code,assetClass,industry,value] of tableRows(context,'positions',fields)) {
    const client = clients.get(id);
    if (!client || date!==context.businessDate) continue;
    if (typeof position!=='string' || !position.trim() || typeof code!=='string' || !code.trim()) throw unproven();
    const amount = value===null ? 0n : cents(value);
    if (amount<0n) throw Object.assign(Error('原持仓含负市值，当前类别和行业占比口径仅支持非负持仓。'),
      { status:422, code:'CUSTOMER_ANALYSIS_NEGATIVE_HOLDING' });
    const category = classifiedLabel(assetClass), sector = classifiedLabel(industry);
    const item = {code,category,sector,amount,missing:value===null};
    if (client.positions.has(position)) {
      if (!same(client.positions.get(position),item)) throw unproven();
      continue;
    }
    client.positions.set(position,item);
    client.securities.add(code);
    client.holdings+=amount;
    if (item.missing) client.nulls++;
    client.classes.set(category,(client.classes.get(category)??0n)+amount);
    client.industries.set(sector,(client.industries.get(sector)??0n)+amount);
  }
  for (const [id,date,value] of tableRows(context,'cash',['client_id','trade_date','available_cash'])) {
    if (clients.has(id) && date===context.businessDate)
      clients.get(id).cash+=value===null ? 0n : cents(value);
  }
  const results = new Map(publishedRows.map(row=>[row.client_id,row]));
  if (results.size!==publishedRows.length || results.size!==clients.size) throw unproven();
  return [...clients].sort(([left],[right])=>left.localeCompare(right)).map(([id,client])=>{
    const row = results.get(id);
    const totalAssets = formatCents(client.holdings+client.cash), holdingMarketValue = formatCents(client.holdings);
    const availableCash = formatCents(client.cash), securityCount = client.securities.size;
    if (!row || !equalValidationNumber(row.total_assets,totalAssets) || !equalValidationNumber(row.holding_market_value,holdingMarketValue) ||
        !equalValidationNumber(row.available_cash,availableCash) || !equalValidationNumber(row.security_count,securityCount)) throw unproven();
    return {customerKey:publishedReportHash([id,context.businessDate]),clientLabel:id.slice(0,3)+'***'+id.slice(-3),
      totalAssets,holdingMarketValue,availableCash,securityCount,nullMarketValueCount:client.nulls,
      assetClasses:distribution(client.classes,client.holdings),industries:distribution(client.industries,client.holdings)};
  });
}

export function customerAssetAnalysis({store,project,ingestion,record,artifacts,resolved}) {
  const {report,version,run,snapshot,dataset,data}=artifacts, evidence=resolved.sourceEvidence, src=record.input.source;
  if (src.kind!=='AGENT' || !isSyncReportEvidence(evidence)) throw unsupported();
  const revision = store.get('revision',src.revisionId,project), binding=revision?.syncInput;
  if (binding?.kind!==archivedSyncInputKind) throw unsupported();
  const task=store.get('offline_sync_task',binding.taskId,project);
  if (!task) throw unproven();
  if (task.sourceType!=='SERVER_MYSQL') throw unsupported();
  if (revision.author!==record.actorId || !same(dataset.sourceEvidence,evidence) || !same(snapshot.sourceEvidence,evidence) ||
      !same(run.sourceEvidence,evidence) || !same(resolved.rows,data.rows) || snapshot.assetId!==resolved.asset.id ||
      snapshot.contentHash!==resolved.asset.evidenceHash || snapshot.assetVersionId!==src.batchId) throw unproven();
  assertSyncReportWidgets(run.widgets, resolved.expected);

  const archive=archivedSyncSqlInput({store,project,ingestion},binding.taskId,binding.runId);
  const frozen=readSyncSqlInput({store,project,actorId:record.actorId,binding});
  if (archive.sourceType!=='SERVER_MYSQL' || !same(archive.context,frozen) ||
      !same(binding,{...archive.selection,...archive.source,snapshotId:binding.snapshotId,snapshotHash:binding.snapshotHash}) ||
      evidence.snapshotHash!==binding.snapshotHash || evidence.syncRunId!==binding.runId ||
      evidence.metadataVersionId!==binding.metadataVersionId || evidence.businessDate!==frozen.businessDate) throw unproven();
  const sync=store.get('offline_sync_run',binding.runId,project);
  const batch=store.get('release_run',src.batchId,project);
  const body={protocol:'shuduo-customer-asset-analysis/v1',scope:'LOCAL_TEST_ONLY',readOnly:true,
    report:{requestId:record.requestId,reportId:report.id,versionId:version.id,runId:run.id,
      reportSnapshotId:snapshot.id,resultHash:run.resultHash},
    source:{taskId:src.taskId,releaseId:src.releaseId,batchId:src.batchId,sequence:batch.sequence,packageDigest:src.packageDigest,
      revisionId:src.revisionId,developmentRunId:src.runId,sourceType:'SERVER_MYSQL',syncTaskId:binding.taskId,syncRunId:binding.runId,
      sourceRevisionId:binding.sourceRevisionId,metadataVersionId:binding.metadataVersionId,landingReceiptHash:sync.landingReceiptHash,
      landingSnapshotHash:binding.landingSnapshotHash,snapshotHash:binding.snapshotHash,businessDate:frozen.businessDate,advisorId:frozen.advisorId},
    customers:customerAssetMetrics(frozen,data.rows)};
  return {...body,digest:publishedReportHash(body)};
}
