import {parseSyncSqlSelection} from './sync-sql-selection.mjs';
const identifier = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const token = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const type = /^(?:[a-z_]{1,24}|decimal\(\d{1,2},\d{1,2}\))$/;
const statuses = ["MATCHED", "MISMATCH", "UNAVAILABLE"];
const issueCodes = ["MISSING", "TYPE", "ORDER", "DUPLICATE", "EXTRA"];
const invalid = () => new Error("输出结构与原运行、代码或快照未核对一致");
const record = value => value && typeof value === "object" && !Array.isArray(value);
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
const column = (value, limit, nullable) => record(value) &&
  (nullable && value.name === null || matches(token, value.name)) &&
  (nullable && value.type === null || matches(type, value.type)) &&
  Number.isInteger(value.position) && value.position >= 1 && value.position <= limit;

// The comparison is oriented from the input used by Spark to the latest collected
// source version. Uncollected revisions have no comparison.
function metadataDifferences(frozen, current) {
  const fields = new Set([...frozen.columns, ...current.columns].map(field => field.name));
  return [...fields].flatMap(name => {
    const before = frozen.columns.find(field => field.name === name) ?? null;
    const after = current.columns.find(field => field.name === name) ?? null;
    if (before && after && before.type === after.type && before.nullable === after.nullable && before.position === after.position) return [];
    return [{ name, before, after }];
  });
}

export function checkedSyncSqlInputMetadata(value, expected = {}) {
  const checkedVersion = item => {
    if (!record(item) || !matches(identifier, item.metadataVersionId) || !matches(identifier, item.sourceRevisionId) ||
        !matches(digest, item.schemaHash) || !Array.isArray(item.columns) || item.columns.length < 1 || item.columns.length > 50 ||
        new Set(item.columns.map(field => field?.name)).size !== item.columns.length ||
        !item.columns.every((field, index) => column(field, 50, false) && field.position === index + 1 &&
          typeof field.nullable === "boolean")) throw invalid();
    return { metadataVersionId:item.metadataVersionId, sourceRevisionId:item.sourceRevisionId, schemaHash:item.schemaHash,
      columns:item.columns.map(({ name, type, position, nullable }) => ({ name, type, position, nullable })) };
  };
  if (!record(value) || !matches(identifier, value.syncRunId) ||
      (expected.syncRunId !== undefined && value.syncRunId !== expected.syncRunId)) throw invalid();
  const frozen = checkedVersion(value.frozen), current = value.current === null ? null : checkedVersion(value.current);
  if (["metadataVersionId", "sourceRevisionId"].some(key => expected[key] !== undefined && frozen[key] !== expected[key]) ||
      current && current.metadataVersionId === frozen.metadataVersionId && JSON.stringify(current) !== JSON.stringify(frozen)) throw invalid();
  return { syncRunId: value.syncRunId, frozen, current, differences: current === null ? [] : metadataDifferences(frozen, current) };
}

function checkedSchema(value, expected, protocol) {
  const source = value?.source, differences = value?.differences;
  if (value?.protocol !== protocol || value.readOnly !== true ||
      !record(source) || !matches(identifier, source.runId) || !matches(identifier, source.revisionId) ||
      !matches(digest, source.revisionHash) || !matches(digest, source.snapshotHash) ||
      source.runId !== expected.runId ||
      ["revisionId", "revisionHash", "snapshotHash"].some(key => expected[key] !== undefined && expected[key] !== source[key]) ||
      !statuses.includes(value.status) || !Array.isArray(differences) || differences.length > 30 ||
      (value.status === "MISMATCH") !== (differences.length > 0)) throw invalid();
  for (const change of differences) {
    if (!record(change) || change.expected !== null && !column(change.expected, 5, false) ||
        change.actual !== null && !column(change.actual, 25, true) || !Array.isArray(change.issues) ||
        change.issues.length === 0 || new Set(change.issues).size !== change.issues.length ||
        change.issues.some(issue => !issueCodes.includes(issue)) ||
        (change.expected === null) !== change.issues.includes("EXTRA") ||
        (change.actual === null) !== change.issues.includes("MISSING")) throw invalid();
  }
  const pick = item => item && { name:item.name, type:item.type, position:item.position };
  return {
    protocol: value.protocol, readOnly: true, status: value.status,
    source: { runId:source.runId, revisionId:source.revisionId, revisionHash:source.revisionHash, snapshotHash:source.snapshotHash },
    differences: differences.map(change => ({
      expected:pick(change.expected), actual:pick(change.actual), issues:[...change.issues],
    })),
  };
}

export function checkedSyncSqlOutputSchema(value, expected) {
  const checked = checkedSchema(value, expected, "shuduo-sync-sql-output-schema/v1");
  if (value.inputMetadata === undefined) return checked;
  const inputMetadata = value.inputMetadata === null ? null : checkedSyncSqlInputMetadata(value.inputMetadata, expected);
  return { ...checked, inputMetadata };
}

function checkedPackageSchema(value, expected, protocol) {
  const checked = checkedSchema(value, expected, protocol);
  const { packageId, packageDigest } = value.source;
  if (!matches(identifier, packageId) || packageId !== expected.packageId ||
      !matches(digest, packageDigest) || packageDigest !== expected.packageDigest) throw invalid();
  return { ...checked, source: { ...checked.source, packageId, packageDigest } };
}

export function checkedSyncSqlRehearsalSchema(value, expected) {
  const checked = checkedPackageSchema(value, expected, "shuduo-sync-sql-rehearsal-schema/v1");
  const { verificationId } = value.source;
  if (!matches(identifier, verificationId) || verificationId !== expected.verificationId) throw invalid();
  return { ...checked, source:{ ...checked.source, verificationId } };
}

export function checkedSyncSqlScheduledSchema(value, expected) {
  const checked = checkedPackageSchema(value, expected, "shuduo-sync-sql-scheduled-schema/v1");
  const { batchId, releaseId } = value.source;
  if (!matches(identifier, batchId) || batchId !== expected.batchId ||
      !matches(identifier, releaseId) || releaseId !== expected.releaseId) throw invalid();
  return { ...checked, source:{ ...checked.source, batchId, releaseId } };
}

export async function readSyncSqlOutputSchema(client, { runId }) {
  if (!matches(identifier, runId)) throw invalid();
  return checkedSyncSqlOutputSchema(await client.request("/runs/" + runId + "/output-schema"), { runId });
}

export async function readSyncedPositions(client) {
  const value = await client.request("/development/synced-positions");
  return checkedSyncedPositions(value);
}
function checkedSyncedPositions(value) {
  const selection = parseSyncSqlSelection(value?.selection);
  if (value?.contextId !== "holdings-t1" || selection?.targetTable !== "raw_positions" ||
      ![selection.runId, value.taskId, value.sourceRevisionId, value.metadataVersionId].every(id => matches(identifier,id)) ||
      !matches(digest,selection.targetHash) || !Number.isInteger(value.rowCount) || value.rowCount < 1 || value.rowCount > 500 ||
      value.verifiedCurrency !== undefined && value.verifiedCurrency !== "CNY")
    throw Error("持仓同步批次、元数据或币种证据未确认。");
  if(selection.kind&&selection.taskId!==value.taskId)throw Error('原持仓批次与任务未核对一致');
  return { contextId:value.contextId, selection,
    taskId:value.taskId,sourceRevisionId:value.sourceRevisionId,metadataVersionId:value.metadataVersionId,rowCount:value.rowCount,
    ...(value.verifiedCurrency === "CNY" ? {verifiedCurrency:"CNY"} : {}) };
}

export async function readSyncSqlArchives(client) {
  const value=await client.request('/development/synced-positions/archives');
  if(value?.protocol!=='shuduo-sync-sql-archives/v1'||value.readOnly!==true||!Array.isArray(value.candidates)||value.candidates.length>100)
    throw Error('原同步批次目录未确认');
  const seen=new Set();
  return value.candidates.map(candidate=>{
    const {taskId,runId,targetHash,landingSnapshotHash,taskName,rowCount,finishedAt,verification}=candidate??{};
    parseSyncSqlSelection({kind:'SYNC_RUN_ARCHIVE_V1',targetTable:'raw_positions',taskId,runId,targetHash,landingSnapshotHash});
    if(seen.has(runId)||typeof taskName!=='string'||taskName.length>100||!taskName.trim()||!Number.isInteger(rowCount)||rowCount<1||rowCount>500||!Number.isFinite(Date.parse(finishedAt))||verification!=='REQUIRES_CHECK')throw Error('原同步批次目录不完整');
    seen.add(runId);return {taskId,runId,targetHash,landingSnapshotHash,taskName,rowCount,finishedAt,verification};
  });
}
export async function readArchivedSyncedPositions(client,expected) {
  if(![expected.taskId,expected.runId].every(value=>matches(identifier,value)&&value.length===36))throw Error('原持仓批次须使用确切任务和运行UUID');
  const offer=checkedSyncedPositions(await client.request(`/development/synced-positions/archives/${expected.taskId}/${expected.runId}`));
  if(offer.selection.kind!=='SYNC_RUN_ARCHIVE_V1'||offer.taskId!==expected.taskId||offer.selection.runId!==expected.runId||
    ['targetHash','landingSnapshotHash'].some(field=>expected[field]!==undefined&&expected[field]!==offer.selection[field]))throw Error('原持仓批次或快照摘要已变化，未自动替换');
  return offer;
}

export async function readSyncReviewEvidence(client, expected) {
  if (!matches(identifier,expected.verificationId)) throw invalid();
  const value = await client.request("/delivery/verifications/"+expected.verificationId+"/review-evidence");
  const source = value?.source, rehearsal = value?.rehearsal, hashes = value?.fileHashes;
  const ids = ["agentTaskId","revisionId","runId","syncRunId","metadataVersionId"];
  const digests = ["revisionHash","snapshotHash","targetHash"];
  const files = ["main.sql","tests.sql","schedule.json","deployment.json","calendar.json","fixtures.json","validation.json","README.md"];
  if (value?.protocol !== "shuduo-sync-review-evidence/v1" || value.scope !== "LOCAL_FILE_REVIEW" || value.readOnly !== true ||
      value.verificationId !== expected.verificationId || !matches(identifier,value.packageId) ||
      !matches(digest,value.packageDigest) || !matches(digest,value.syncRehearsalDigest) ||
      ["packageId","packageDigest","syncRehearsalDigest"].some(key=>expected[key] !== undefined && value[key] !== expected[key]) ||
      !record(source) || source.contextId !== "holdings-t1" || !["LIVE_MODEL","SYNTHETIC_MODEL","MANUAL"].includes(source.developmentMode) ||
      !ids.every(key=>matches(identifier,source[key])) || !digests.every(key=>matches(digest,source[key])) ||
      expected.snapshotHash !== undefined && expected.snapshotHash !== source.snapshotHash ||
      !record(hashes) || Object.keys(hashes).length !== files.length || files.some(name=>!matches(digest,hashes[name])) ||
      !record(rehearsal) || rehearsal.validationContractId !== "securities-synced-holdings-t1-v1" ||
      !matches(/^\d{4}-\d{2}-\d{2}$/,rehearsal.businessDate) ||
      !matches(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/,rehearsal.scheduledFor) ||
      !matches(/^\d+\.\d+\.\d+$/,rehearsal.engineVersion) || rehearsal.regressionCount !== 5 ||
      !Number.isInteger(rehearsal.selectedRowCount) || rehearsal.selectedRowCount < 1 || rehearsal.selectedRowCount > 500 ||
      !Array.isArray(rehearsal.steps) || rehearsal.steps.length !== 3 || rehearsal.steps.some(step=>
        !matches(token,step?.id) || !matches(token,step.kind) || step.status !== "SUCCEEDED"))
    throw Error("审阅证据与所选演练不一致，请重读原回执。");
  return {
    protocol:value.protocol,scope:value.scope,readOnly:true,packageId:value.packageId,packageDigest:value.packageDigest,
    verificationId:value.verificationId,syncRehearsalDigest:value.syncRehearsalDigest,
    source:{contextId:source.contextId,developmentMode:source.developmentMode,
      ...Object.fromEntries([...ids,...digests].map(key=>[key,source[key]]))},
    rehearsal:{businessDate:rehearsal.businessDate,scheduledFor:rehearsal.scheduledFor,engineVersion:rehearsal.engineVersion,
      validationContractId:rehearsal.validationContractId,selectedRowCount:rehearsal.selectedRowCount,regressionCount:rehearsal.regressionCount,
      steps:rehearsal.steps.map(({id,kind,status})=>({id,kind,status}))},
    fileHashes:Object.fromEntries(files.map(name=>[name,hashes[name]])),
  };
}
