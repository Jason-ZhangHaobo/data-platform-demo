import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getContext } from "./context.mjs";
import { equalValidationNumber } from "./validation-number.mjs";

export const syncSqlContextId = "holdings-t1";
export const syncSqlContractId = "securities-synced-holdings-t1-v1";
export const syncSqlOutputColumns = Object.freeze([
  { name: "client_id", type: "string" },
  { name: "holding_market_value", type: "decimal(18,2)" },
  { name: "available_cash", type: "decimal(18,2)" },
  { name: "total_assets", type: "decimal(18,2)" },
  { name: "security_count", type: "bigint" },
].map(Object.freeze));
export const syncSqlOutputSchemaCode = "SYNC_SQL_OUTPUT_SCHEMA_MISMATCH";
export const syncSqlOutputSchemaMessage =
  "冻结持仓输出列或类型不符合约定。按顺序返回客户编号 STRING、持仓市值、可用现金和总资产 DECIMAL(18,2)、证券数量 BIGINT。";
const targetTable = "raw_positions";
const kind = "sync_sql_input";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (status, message, code = "SYNC_SQL_INPUT_INVALID") => Object.assign(Error(message), { status, code });

export function parseSyncSqlSelection(selection) {
  if (!selection || typeof selection !== "object" || Object.keys(selection).length !== 3 ||
      selection.targetTable !== targetTable || typeof selection.runId !== "string" || !uuid.test(selection.runId) ||
      typeof selection.targetHash !== "string" || !digest.test(selection.targetHash))
    throw fail(422, "请选择已核对的持仓同步批次和落地摘要");
  return { targetTable, runId: selection.runId, targetHash: selection.targetHash };
}

function cents(value) {
  if (value === null) return 0n;
  const [whole, fraction = ""] = value.split(".");
  const negative = whole.startsWith("-");
  const amount = BigInt(whole.replace(/^-/, "")) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -amount : amount;
}

function money(value) {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

function buildContext(rows) {
  const context = getContext(syncSqlContextId);
  const positions = context.tables.find(table => table.name === "positions");
  const accounts = context.tables.find(table => table.name === "accounts").rows;
  const cash = context.tables.find(table => table.name === "cash").rows;
  const knownClients = new Set(accounts.map(([client]) => client));
  const classes = new Set(positions.rows.map(row => row[3]));
  const industries = new Set(positions.rows.map(row => row[4]));
  const positionIds = new Set();
  positions.rows = rows.map(row => {
    const { position_id, client_id, security_code, asset_class, industry, market_value, trade_date } = row;
    if (typeof position_id !== "string" || !/^POS-[A-Z0-9-]{1,32}$/.test(position_id) || positionIds.has(position_id) ||
        !knownClients.has(client_id) || typeof security_code !== "string" || !/^SEC-DEMO-[A-Z0-9-]{1,24}$/.test(security_code) ||
        !classes.has(asset_class) || !industries.has(industry) || trade_date !== context.businessDate ||
        !(market_value === "" || market_value === null || typeof market_value === "string" && /^-?\d{1,13}(?:\.\d{1,2})?$/.test(market_value)))
      throw fail(422, "落地持仓须符合登记的虚构客户、证券、交易日及金额结构");
    positionIds.add(position_id);
    return [position_id, client_id, security_code, asset_class, industry, market_value || null, trade_date];
  });
  const totals = new Map(accounts.filter(([, advisor]) => advisor === context.advisorId)
    .map(([client]) => [client, { holdings: 0n, cash: 0n, codes: new Set() }]));
  for (const [, client, code, , , amount] of positions.rows) {
    const total = totals.get(client);
    if (!total) continue;
    total.holdings += cents(amount);
    total.codes.add(code);
  }
  for (const [client, amount, date] of cash) {
    const total = totals.get(client);
    if (total && date === context.businessDate) total.cash += cents(amount);
  }
  context.name = "客户资产 T+1 · 冻结同步持仓";
  context.expected = [...totals].map(([client_id, total]) => ({
    client_id, holding_market_value: money(total.holdings), available_cash: money(total.cash),
    total_assets: money(total.holdings + total.cash), security_count: total.codes.size,
  }));
  return context;
}

export function currentSyncSqlInput({ assets, landingStore, store, project }) {
  const unavailable = () => fail(409, "尚无符合此口径的已核对全量虚构持仓同步批次", "SYNC_SQL_INPUT_UNAVAILABLE");
  let asset;
  try { asset = assets.detail(`landing:${targetTable}`); }
  catch (cause) { if (cause.code === "ASSET_NOT_FOUND") throw unavailable(); throw cause; }
  const source = asset.syncSource;
  const syncTask = source?.taskId && store.get("offline_sync_task", source.taskId, project);
  const columns = getContext(syncSqlContextId).tables.find(table => table.name === "positions").columns;
  if (source?.status !== "VERIFIED" || source.mode !== "FULL" || syncTask?.sourceType !== "LOCAL_CSV" ||
      asset.fields.length !== columns.length || !columns.every(([name]) => asset.fields.some(field => field.name === name)) ||
      !asset.rowCount || asset.rowCount > 500) throw unavailable();
  const snapshot = landingStore.inspectTarget(targetTable, { includeRows: true });
  if (snapshot.runId !== source.runId || snapshot.targetHash !== source.targetHash || snapshot.rowCount !== asset.rowCount)
    throw unavailable();
  return {
    selection: { targetTable, runId: source.runId, targetHash: source.targetHash },
    source: { taskId: source.taskId, sourceRevisionId: source.sourceRevisionId, metadataVersionId: source.metadataVersionId,
      rowCount: snapshot.rowCount },
    context: buildContext(snapshot.rows),
  };
}

export function freezeSyncSqlInput({ store, project, actorId, selection, current }) {
  if (selection.runId !== current.selection.runId || selection.targetHash !== current.selection.targetHash)
    throw fail(409, "所选同步批次已变化，请重新核对后选择", "SYNC_SQL_INPUT_STALE");
  const { context, source } = current;
  const payload = { actorId, selection, source, context };
  const contentHash = hash(payload);
  const record = store.create(kind, project, { payload, contentHash });
  return { ...selection, ...source, snapshotId: record.id, snapshotHash: contentHash };
}

export function readSyncSqlInput({ store, project, actorId, binding }) {
  const record = typeof binding?.snapshotId === "string" && uuid.test(binding.snapshotId)
    ? store.get(kind, binding.snapshotId, project) : undefined;
  const payload = record?.payload;
  if (payload?.actorId !== actorId || !payload || payload.context?.id !== syncSqlContextId ||
      hash(payload) !== record.contentHash || record.contentHash !== binding.snapshotHash ||
      hash(binding) !== hash({ ...payload.selection, ...payload.source, snapshotId: record.id, snapshotHash: record.contentHash }))
    throw fail(409, "同步冻结输入缺失或已变化，未执行计算", "SYNC_SQL_INPUT_CHANGED");
  return payload.context;
}

export function syncSqlDeliverySource({ agent, run, revision }) {
  const binding = revision?.syncInput;
  const manual = revision?.source === "MANUAL";
  const attempt = agent?.attempts?.at(-1);
  if (!binding || !isDeepStrictEqual(run?.syncInput, binding) || !isDeepStrictEqual(agent?.syncInput, binding) ||
      agent.submittedBy !== revision.author || agent.projectId !== revision.projectId ||
      agent.contextId !== syncSqlContextId || revision.contextId !== syncSqlContextId || run.contextId !== syncSqlContextId ||
      run.validationContractId !== syncSqlContractId || run.mainSqlExecuted !== true || run.testDouble === true ||
      !Number.isFinite(Date.parse(run.finishedAt)) ||
      run.remoteSubmission !== undefined || ![undefined, "LOCAL_PROCESS"].includes(run.isolation) ||
      (manual ? revision.manualProvenance?.originAgentTaskId !== agent.id || run.agentTaskId !== undefined ||
        revision.manualProvenance?.kind !== "ENGINEER_EDIT" || revision.manualProvenance?.actorId !== revision.author ||
        revision.manualProvenance?.agentIndependentE2E !== false :
        !["LIVE_MODEL", "SYNTHETIC_MODEL"].includes(revision.source) || agent.mode !== revision.source ||
        agent.status !== "SUCCEEDED" || agent.runId !== run.id || agent.revisionId !== revision.id ||
        run.agentTaskId !== agent.id || attempt?.runId !== run.id || attempt.revisionId !== revision.id || attempt.status !== "SUCCEEDED"))
    throw fail(409, "交付须绑定原同步快照、确切代码及真实本机运行");
  return { ...binding, actorId: revision.author, agentTaskId: agent.id, developmentMode: revision.source };
}

export function validateSyncSqlDeliveryContext(binding, context) {
  const invalid = () => fail(422, "交付输入、同步快照摘要或独立预期不一致");
  if (!binding || typeof binding !== "object" || Object.keys(binding).length !== 12) throw invalid();
  const { targetTable: target, runId, targetHash, taskId, sourceRevisionId, metadataVersionId, rowCount, snapshotId,
    snapshotHash, actorId, agentTaskId, developmentMode } = binding;
  const selection = parseSyncSqlSelection({ targetTable: target, runId, targetHash });
  if (![taskId, sourceRevisionId, metadataVersionId, snapshotId, agentTaskId].every(id => typeof id === "string" && uuid.test(id)) ||
      typeof snapshotHash !== "string" || !digest.test(snapshotHash) ||
      typeof actorId !== "string" || !(actorId === "local-engineer" || uuid.test(actorId)) ||
      !["LIVE_MODEL", "SYNTHETIC_MODEL", "MANUAL"].includes(developmentMode) ||
      !Number.isInteger(rowCount) || rowCount < 1 || rowCount > 500) throw invalid();
  const positions = Array.isArray(context?.tables) && context.tables.find(table => table?.name === "positions");
  const columns = getContext(syncSqlContextId).tables.find(table => table.name === "positions").columns;
  if (!Array.isArray(positions?.rows) || positions.rows.length !== rowCount ||
      positions.rows.some(row => !Array.isArray(row) || row.length !== columns.length)) throw invalid();
  const reconstructed = buildContext(positions.rows.map(row => Object.fromEntries(columns.map(([name], index) => [name, row[index]]))));
  const source = { taskId, sourceRevisionId, metadataVersionId, rowCount };
  if (!isDeepStrictEqual(reconstructed, context) || hash({ actorId, selection, source, context }) !== snapshotHash)
    throw invalid();
}

export function syncSqlRowsMatch(rows, context) {
  return Array.isArray(rows) && rows.length === context.expected.length && context.expected.every(expected => {
    const matches = rows.filter(row => row?.client_id === expected.client_id);
    return matches.length === 1 && Object.keys(matches[0]).length === Object.keys(expected).length &&
      Object.keys(expected).every(field => field === "client_id" || equalValidationNumber(matches[0][field], expected[field]));
  });
}

export function syncSqlColumnsMatch(columns) {
  return Array.isArray(columns) && columns.length === syncSqlOutputColumns.length &&
    syncSqlOutputColumns.every(({ name, type }, index) => columns[index]?.name === name && columns[index]?.type === type);
}

export function assertSyncSqlOutputSchema(columns) {
  if (!syncSqlColumnsMatch(columns))
    throw fail(409, syncSqlOutputSchemaMessage, syncSqlOutputSchemaCode);
}

export function syncSqlOutputSchemaDetails(run, revision) {
  if (!["SUCCEEDED", "VALIDATION_FAILED"].includes(run?.status) ||
      run.engine !== "Apache Spark" || run.mainSqlExecuted !== true || !run.syncInput ||
      run.contextId !== syncSqlContextId || run.validationContractId !== syncSqlContractId ||
      !revision || revision.projectId !== run.projectId || revision.contextId !== run.contextId ||
      revision.id !== run.revisionId || revision.hash !== run.revisionHash ||
      typeof revision.sql !== "string" || createHash("sha256").update(revision.sql).digest("hex") !== revision.hash ||
      !isDeepStrictEqual(run.syncInput, revision.syncInput) || !digest.test(run.syncInput.snapshotHash ?? ""))
    return undefined;
  const source = { runId: run.id, revisionId: revision.id, revisionHash: revision.hash, snapshotHash: run.syncInput.snapshotHash };
  const report = { protocol: "shuduo-sync-sql-output-schema/v1", source, readOnly: true };
  const columns = run.columns;
  if (!Array.isArray(columns) || columns.length === 0 || columns.length > 25 ||
      columns.some(column => typeof column?.name !== "string" || typeof column?.type !== "string"))
    return { ...report, status: "UNAVAILABLE", differences: [] };
  const differences = [], used = new Set();
  const identifier = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
  const sparkType = /^(?:string|boolean|tinyint|smallint|int|bigint|float|double|binary|date|timestamp|timestamp_ntz|void|decimal\(\d{1,2},\d{1,2}\))$/;
  const observed = (column, index) => ({
    name: identifier.test(column.name) ? column.name : null,
    type: sparkType.test(column.type) ? column.type : null,
    position: index + 1,
  });
  syncSqlOutputColumns.forEach((column, index) => {
    const expected = { ...column, position: index + 1 };
    const at = columns.findIndex(item => item.name === column.name);
    if (at < 0) {
      differences.push({ expected, actual: null, issues: ["MISSING"] });
      return;
    }
    used.add(at);
    const issues = [];
    if (columns[at].type !== column.type) issues.push("TYPE");
    if (at !== index) issues.push("ORDER");
    if (issues.length) differences.push({ expected, actual: observed(columns[at], at), issues });
  });
  columns.forEach((column, index) => {
    if (used.has(index)) return;
    const original = syncSqlOutputColumns.findIndex(item => item.name === column.name);
    const expected = original < 0 ? null : { ...syncSqlOutputColumns[original], position: original + 1 };
    differences.push({ expected, actual: observed(column, index), issues: [expected ? "DUPLICATE" : "EXTRA"] });
  });
  return { ...report, status: differences.length ? "MISMATCH" : "MATCHED", differences };
}
