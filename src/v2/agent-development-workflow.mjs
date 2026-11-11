import {verifyOutputRows,outputContractForContext} from './output-contracts.mjs';
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDeliveryPackage, validateDeliveryPackage, resolveDeliverySchedule, validationMatchesFamily } from "./delivery.mjs";
import { getContext, validationContractId, validationFamilyForContext } from "./context.mjs";
import { deliveryArtifactValue } from "./artifact-store.mjs";
import { resolveExplicitSqlRepairSource } from "./sql-repair-source.mjs";
import { validationDetails, equalValidationNumber } from "./validation-details.mjs";
import {assistedSqlDeliverySource} from './assisted-sql-delivery-source.mjs';
import {sameAssistedDevelopmentReference} from './assisted-development-reference.mjs';
import {resolveManualContinuation} from './manual-sql-continuation.mjs';
import {verifiedSqlRequirementForRevision,assertSqlRequirementPackageSource,sqlRequirementBinding} from './sql-requirements.mjs';
import {assertSqlClarificationTask} from './sql-clarification.mjs';
import { liveEvidenceProvenance, nonLiveModelLabel } from "./live-lifecycle-provenance.mjs";

export const durableDeliveryMode = "DURABLE_AGENT_DELIVERY_V1";
export const standaloneManualDeliveryMode='DURABLE_MANUAL_DELIVERY_V1';
const terminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
export function publicDeliveryTask(task) {
  if (!task) return task;
  const { remoteSubmission, submittedBy, ...visible } = task;
  return visible;
}

export function storedFileRehearsal(task, verification) {
  if (!verification || verification.id !== task.verificationId || verification.agentDeliveryTaskId !== task.id ||
      verification.packageId !== task.packageId || verification.packageDigest !== task.packageDigest ||
      !["RUNNING","SUCCEEDED","FAILED","CANCELLED"].includes(verification.status) ||
      !Number.isFinite(verification.reservedDurationMs) || verification.reservedDurationMs <= 0) return;
  return {id:verification.id, status:verification.status, reservedDurationMs:verification.reservedDurationMs,
    ...(Number.isFinite(verification.durationMs) && verification.durationMs >= 0 ? {durationMs:verification.durationMs} : {})};
}

// Read-only evidence selection. A skipped repair may display only the exact
// earlier failed run it references; this is never a delivery/publication source.
export function resolveEvidenceSource(agent, read) {
  const attempt = agent.attempts?.at(-1), code = "AGENT_SQL_UNCHANGED_AFTER_FAILURE";
  const retained = agent.code === code || attempt?.code === code || attempt?.status === "NO_SQL_CHANGE";
  if (!retained) return {
    revision: attempt?.revisionId ? read("revision", attempt.revisionId) : undefined,
    run: attempt?.runId ? read("run", attempt.runId) : undefined,
    retainedFailure: false,
  };
  const invalid = () => Object.assign(fail(409, "原失败证据与当前任务不一致，请核对保留的版本和批次；不会重新执行或准备交付"), {code: "AGENT_RETAINED_FAILURE_SOURCE_INVALID"});
  if (agent.status !== "FAILED" || agent.executionMode !== "DURABLE_SQL_AGENT_V1" || agent.language !== "SPARK_SQL" ||
      agent.code !== code || attempt?.status !== "NO_SQL_CHANGE" || attempt.code !== code || attempt.computationSkipped !== true ||
      attempt.runId !== undefined || attempt.revisionId !== undefined ||
      typeof attempt.sourceRunId !== "string" || attempt.sourceRunId !== agent.runId ||
      typeof attempt.sourceRevisionId !== "string" || attempt.sourceRevisionId !== agent.revisionId) throw invalid();
  if (attempt.sourceKind === "EXPLICIT_FAILED_RUN") {
    if (agent.sourceRunId !== attempt.sourceRunId || agent.attempts.slice(0,-1).some(item=>item.runId!==undefined)) throw invalid();
    let source;
    try { source=resolveExplicitSqlRepairSource({sourceRunId:agent.sourceRunId,actorId:agent.submittedBy,contextId:agent.contextId,currentSql:agent.sql,project:agent.projectId,read}); }
    catch { throw invalid(); }
    if (source.revision.id!==attempt.sourceRevisionId) throw invalid();
    return {...source,retainedFailure:true,sourceKind:"EXPLICIT_FAILED_RUN"};
  }
  if (attempt.sourceKind !== undefined) throw invalid();
  const previous = agent.attempts.slice(0, -1).findLast(item => item.runId === attempt.sourceRunId && item.revisionId === attempt.sourceRevisionId);
  const run = read("run", attempt.sourceRunId), revision = read("revision", attempt.sourceRevisionId);
  if (!previous || !["FAILED", "VALIDATION_FAILED"].includes(previous.status) || previous.computationSkipped === true ||
      run?.status !== previous.status || run.agentTaskId !== agent.id || run.contextId !== agent.contextId ||
      run.revisionId !== revision?.id || revision?.contextId !== agent.contextId || revision.author !== agent.submittedBy ||
      typeof revision.sql !== "string" || revision.sql !== agent.sql || run.revisionHash !== revision.hash || hash(revision.sql) !== revision.hash ||
      run.engine !== "Apache Spark" || run.testDouble === true || run.remoteSubmission?.prepared?.job?.jobId !== run.id ||
      (run.status === "VALIDATION_FAILED" && run.mainSqlExecuted !== true) ||
      typeof agent.validationContractId !== "string" || run.validationContractId !== agent.validationContractId) throw invalid();
  return {revision, run, retainedFailure: true, sourceKind:"TASK_FAILED_RUN"};
}

export function developmentVerificationReport(task, run, revision) {
  const context = getContext(task.contextId), expected = context?.expected ?? [];
  const family = validationFamilyForContext(task.contextId), legacy = family?.id === validationContractId;
  const rows = run?.rows ?? [], fields = ["holding_market_value", "available_cash", "total_assets", "security_count"];
  const numericEqual = equalValidationNumber;
  const distribution=outputContractForContext(task.contextId);
  const resultsMatch = distribution ? verifyOutputRows(rows,context) : rows.length === expected.length && expected.every(want => {
    const matches = rows.filter(row => row.client_id === want.client_id);
    return matches.length === 1 && fields.every(field => numericEqual(matches[0][field], want[field]));
  });
  const checks = [
    { id: "revision", label: "结果对应当前代码版本", passed: Boolean(revision && revision.contextId === task.contextId &&
      (run?.contextId === undefined || run.contextId === task.contextId) && run?.revisionId === revision.id && run.revisionHash === revision.hash && hash(revision.sql) === revision.hash) },
    { id: "execution", label: "Spark 实际执行完成", passed: ["SUCCEEDED", "VALIDATION_FAILED"].includes(run?.status) && run.engine === "Apache Spark" && run.mainSqlExecuted === true && run.testDouble !== true },
    { id: "results", label: distribution?"客户/交易日/分类、市值和占比匹配独立预期":"客户、金额与证券数量匹配独立预期", passed: resultsMatch },
    { id: "regressions", label: distribution?"持仓去重、现金客户、未分类及零分母等五场景通过":legacy ? "重复持仓、现金变化及现金客户等五场景通过" : "股票持仓、现金变化及现金客户等五场景通过", passed:
      (task.validationContractId === undefined || task.validationContractId === family?.id) &&
      (run?.validationContractId === undefined || run.validationContractId === family?.id) &&
      validationMatchesFamily(run?.validation, family, { requireContract: true }) },
  ];
  if((task.requirements!==undefined||distribution)&&revision?.source==='LIVE_MODEL')checks.push({id:'requirement',label:'结构化理解绑定当前需求与代码，结果另行核验',
    passed:verifiedSqlRequirementForRevision(task.requirements,task,revision)});
  const passed = run?.status === "SUCCEEDED" && checks.every(check => check.passed);
  return {
    schema: "shuduo-development-verification/v1", taskId: task.id, revisionId: revision?.id,
    revisionHash: revision?.hash, runId: run?.id, contextId: task.contextId,
    status: passed ? "PASSED" : !run || ![...terminal, "VALIDATION_FAILED"].includes(run.status) ? "PENDING" : "NEEDS_ATTENTION",
    summary: passed ? distribution?"持仓分布的代码、真实执行、复合键与五场景核验通过；占比不含现金，可准备本机交付文件并独立演练。":legacy ? "当前证券业务口径下，代码版本、真实执行、结果和五场景核验均通过，可以准备交付。" : "股票持仓＋可用现金口径的代码、执行、结果和五场景核验均通过；结果不等于客户全资产。" : "尚未形成完整核验结论，请先查看未通过项。",
    definition: context?.definition, checks, rowCount: rows.length, engine: run?.engine, engineVersion: run?.engineVersion,
    validationDetails: validationDetails(run, revision, task.contextId),
    finishedAt: run?.finishedAt, validationContractId: family?.id, validationFamily: family, completionScope: "KNOWN_SECURITIES_CONTRACT",
    notice: "核验仅覆盖所选数据与已登记口径；新增指标需要新的独立预期。",
  };
}

export function verifiedStoredCloudDevelopment(task, revision, run) {
  const attempts = Array.isArray(task.attempts) ? task.attempts : [];
  const attempt = attempts.at(-1), family = validationFamilyForContext(task.contextId);
  if (!family || task.status !== "SUCCEEDED" || attempt?.status !== "SUCCEEDED" ||
      typeof attempt.model !== "string" || !attempt.model || attempt.model.length > 200 || nonLiveModelLabel(attempt.model) ||
      attempts.length > 3 || !Number.isSafeInteger(task.usedTokens) || task.usedTokens < 0 || task.usedTokens > 32000 ||
      revision?.source !== "LIVE_MODEL" || revision.id !== attempt.revisionId || revision.author !== task.submittedBy ||
      typeof revision.sql !== "string" || revision.sql !== task.sql ||
      !run || run.id !== attempt.runId || run.agentTaskId !== task.id || run.contextId !== task.contextId ||
      run.mode !== "DURABLE_REMOTE_SUBMISSION" || run.isolation !== "FUNCTION_PROCESS" || run.engineVersion !== "3.5.9" ||
      run.remoteSubmission?.prepared?.job?.jobId !== run.id ||
      !Array.isArray(run.rows) || run.rows.some(row => !row || typeof row !== "object" || Array.isArray(row)))
    return;
  try {
    if (developmentVerificationReport(task, run, revision).status === "PASSED") return {attempt, attempts, family};
  } catch {
    return;
  }
}

export function manualCloudDeliverySource({store, project, runId, actorId, requireVerified = true}) {
  const run = store.get("run", runId, project), revision = store.get("revision", run?.revisionId ?? "", project),
    provenance = revision?.manualProvenance;
  const assisted=revision?.source==='LIVE_MODEL'?assistedSqlDeliverySource({store,project,run,revision,actorId}):undefined,
    agent=assisted?.agent??store.get("agent",provenance?.originAgentTaskId??"",project);
  if (!assisted&&(!actorId || !agent || agent.executionMode !== "DURABLE_SQL_AGENT_V1" || agent.language !== "SPARK_SQL" ||
      agent.submittedBy !== actorId || revision?.author !== actorId || revision.source !== "MANUAL" ||
      provenance?.kind !== "ENGINEER_EDIT" || provenance.actorId !== actorId || provenance.agentIndependentE2E !== false ||
      revision.contextId !== agent.contextId || run?.contextId !== revision.contextId || run.revisionHash !== revision.hash ||
      hash(revision.sql) !== revision.hash))
    throw fail(403, "人工交付必须属于当前工程师、原任务与同一已保存代码版本");
  const report = {...developmentVerificationReport(agent, run, revision), sourceKind: "MANUAL", agentIndependentE2E: false,
    originAgentStatus: agent.status,...(assisted?{developmentReference:assisted.developmentReference}:{}),
    notice: assisted?'此核验属于人工辅助修正版本；代码仍为模型生成，原参考依据、失败及用量不改写，不计自主完成。':"此核验属于工程师接管版本；原 Agent 的失败、尝试及预算记录保持不变，不计为自主完成。"};
  if (requireVerified && (report.status !== "PASSED" || run.engineVersion !== "3.5.9" || run.isolation !== "FUNCTION_PROCESS" ||
      run.mode !== "DURABLE_REMOTE_SUBMISSION" && run.adapter !== "remote-spark-worker-v1"))
    throw fail(409, "请先完成此人工版本的云端隔离 Spark 执行与五场景独立核验");
  return {agent, revision, run, report,...(assisted?{developmentReference:assisted.developmentReference}:{})};
}

// Each POST crosses one durable boundary; GET only reads a signed Worker receipt.
export function createDurableAgentDelivery({ store, project, runner, artifactStore, persist, assertRunBudget = () => {}, assertExecutionScope = () => {}, reservationSeconds = 30, standaloneManual = false }) {
  const resource=standaloneManual?'manual_delivery_task':'agent_delivery_task',mode=standaloneManual?standaloneManualDeliveryMode:durableDeliveryMode;
  if (!Number.isFinite(reservationSeconds) || reservationSeconds < 1 || reservationSeconds > 300) throw new Error("交付计算预留无效");
  const standaloneSource=(runId,actorId,binding)=>{
    const proof=resolveManualContinuation({store,project,actorId,sourceRunId:runId,binding}),run=store.get('run',proof.binding.runId,project),revision=store.get('revision',proof.binding.revisionId,project);
    return {...proof,run,revision};
  };
  const get = id => {
    const item = store.get(resource, id, project);
    if (!item || item.mode !== mode) throw fail(404, "未找到持久交付任务");
    return item;
  };
  const change = (item, patch) => store.update(resource, item.id, project, patch, { expectedVersion: item.version });
  const source = agent => {
    if(agent.clarification)assertSqlClarificationTask(agent,{store,project});
    if(agent.repairComparison!==undefined||agent.sourceKind==='MANUAL'||agent.sourceAttribution!==undefined)throw fail(409,'人工辅助修正须独立记录来源并重新审阅交付，不能从原生Agent入口继承发布');
    const attempt = agent.attempts?.at(-1), revision = store.get("revision", attempt?.revisionId ?? "", project), run = store.get("run", attempt?.runId ?? "", project);
    if (agent.status !== "SUCCEEDED" || agent.mode !== "LIVE_MODEL" || attempt?.status !== "SUCCEEDED" || !attempt.model || /TEST_DOUBLE|unconfirmed/.test(attempt.model) || developmentVerificationReport(agent, run, revision).status !== "PASSED")
      throw fail(409, "请先完成真实模型、Spark 与独立结果核验");
    return { revision, run };
  };
  const checkPinnedSource = (agent, {revision,run}, expected) => {
    const proof = liveEvidenceProvenance(agent,revision,run);
    const requirement = agent.requirements ? sqlRequirementBinding(agent.requirements) : undefined;
    if (proof.synthetic || proof.nonNative || proof.unconfirmed || agent.sourceRunId !== undefined ||
        agent.derivedFrom !== undefined || revision.id !== expected.revisionId || revision.hash !== expected.revisionHash ||
        run.id !== expected.runId || !isDeepStrictEqual(requirement,expected.requirementBinding) ||
        !verifiedStoredCloudDevelopment(agent,revision,run))
      throw fail(409,"交付准备的代码版本、Spark 批次或需求依据已变化");
  };
  const bundleFor = async task => {
    const item = store.get("delivery_package", task.packageId, project);
    if (!item || item.digest !== task.packageDigest || item.manifest.source.sqlHash !== task.sourceSqlHash)
      throw fail(409, "交付文件与已核验源版本不一致");
    await artifactStore.verify(item.artifact, "delivery-package", item.digest, deliveryArtifactValue(item));
    const plan = validateDeliveryPackage(item, task.packageDigest);
    if (task.sourceKind === "MANUAL" && (plan.source.attribution?.kind !== (standaloneManual?"ENGINEER_AUTHORED":"ENGINEER_ASSISTED") ||
        (!standaloneManual&&plan.source.attribution.originAgentTaskId !== task.sourceAgentTaskId) || plan.source.attribution.actorId !== task.submittedBy ||
        plan.source.attribution.agentIndependentE2E !== false||!sameAssistedDevelopmentReference(plan.source.attribution.developmentReference,task.developmentReference))) throw fail(409, "人工交付来源与不可变清单不一致");
    return { item, plan };
  };
  const assertTaskScope = task => {
    if(standaloneManual){
      const source=standaloneSource(task.sourceRunId,task.submittedBy,task.sourceBinding);
      assertExecutionScope(source.revision);
      if(source.revision.id!==task.sourceRevisionId||source.revision.hash!==task.sourceSqlHash||!sameAssistedDevelopmentReference(source.developmentReference,task.developmentReference))throw fail(409,'手工交付来源已变化');
      return;
    }
    const agent = store.get("agent", task.sourceAgentTaskId, project);
    assertExecutionScope(agent);
    if (task.sourcePinned) {
      if (!agent || agent.submittedBy !== task.submittedBy) throw fail(409,"交付原任务身份已变化");
      checkPinnedSource(agent,source(agent),{revisionId:task.sourceRevisionId,revisionHash:task.sourceSqlHash,
        runId:task.sourceRunId,requirementBinding:task.sourceRequirementBinding});
    }
    if(agent?.clarification)assertSqlClarificationTask(agent,{store,project});
    if (task.sourceKind === "MANUAL") {
      const source = manualCloudDeliverySource({store, project, runId: task.sourceRunId, actorId: task.submittedBy});
      if (source.agent.id !== task.sourceAgentTaskId || source.revision.id !== task.sourceRevisionId || source.revision.hash !== task.sourceSqlHash||
        !sameAssistedDevelopmentReference(source.developmentReference,task.developmentReference))
        throw fail(409, "人工交付来源已变化");
    }
    const revision=store.get('revision',task.sourceRevisionId,project),run=store.get('run',task.sourceRunId,project);
    if(task.sourceRequirementBinding||(revision?.source==='LIVE_MODEL'&&agent?.requirements)||revision?.requirementBinding){
      if(JSON.stringify(task.sourceRequirementBinding)!==JSON.stringify(agent?.requirements?sqlRequirementBinding(agent.requirements):undefined))throw fail(409,'交付恢复的需求依据已变化');
      assertSqlRequirementPackageSource(store.get('delivery_package',task.packageId,project),{agent,run,revision});
    }
  };
  async function persistDeliveryArtifact(task) {
    if (task.stage !== "PACKAGE_PERSISTING") return task;
    const item = store.get("delivery_package", task.packageId, project);
    assertTaskScope(task);
    if (!item || item.digest !== task.packageDigest) throw fail(409, "交付包检查点不完整");
    validateDeliveryPackage(item, task.packageDigest);
    const value = deliveryArtifactValue(item);
    if (item.artifact) await artifactStore.verify(item.artifact,"delivery-package",item.digest,value);
    const artifact = item.artifact ?? await artifactStore.put("delivery-package", item.digest, value);
    task = get(task.id);
    if (task.stage !== "PACKAGE_PERSISTING") return task;
    assertTaskScope(task);
    if (!task.sourcePinned && task.sourceKind !== "MANUAL") {
      const agent = store.get("agent",task.sourceAgentTaskId,project);
      assertSqlRequirementPackageSource(item,{agent,...source(agent)});
    }
    const saved = store.get("delivery_package", item.id, project);
    if (saved?.version !== item.version) throw fail(409,"交付包检查点已变化");
    if (!saved.artifact) store.update("delivery_package", item.id, project, {artifact}, {expectedVersion:item.version});
    task = change(task, {stage: "PACKAGE_READY"}); await persist(); return task;
  }
  async function createManual({runId, actorId, key, sourceBinding}) {
    const source=standaloneManual?standaloneSource(runId,actorId,sourceBinding):manualCloudDeliverySource({store,project,runId,actorId});
    const {agent,revision,run,developmentReference}=source;
    assertExecutionScope(standaloneManual?revision:agent);
    if (typeof key !== "string" || !key || key.length > 100) throw fail(422, "人工交付缺少有效幂等编号");
    const existing = store.list(resource, project).find(t => t.sourceKind === "MANUAL" && (standaloneManual?t.submittedBy===actorId:t.sourceAgentTaskId===agent.id) &&
      t.sourceRunId === run.id && t.sourceRevisionId === revision.id && t.sourceSqlHash === revision.hash && sameAssistedDevelopmentReference(t.developmentReference,developmentReference)&&
      JSON.stringify(t.sourceRequirementBinding)===JSON.stringify(revision.source==='LIVE_MODEL'&&agent?.requirements?sqlRequirementBinding(agent.requirements):undefined)&&["QUEUED", "RUNNING", "SUCCEEDED"].includes(t.status));
    if(existing)assertSqlRequirementPackageSource(store.get('delivery_package',existing.packageId,project),{agent:revision.source==='LIVE_MODEL'?agent:undefined,run,revision});
    const dedup = store.deduplicate(`${project}:${standaloneManual?"standalone-manual-delivery":"manual-cloud-delivery"}:${actorId}:${key}`, hash(JSON.stringify({runId: run.id, revisionHash: revision.hash, ...(standaloneManual?{sourceBinding:source.binding}:{origin:agent.id}),...(developmentReference?{developmentReference}:{}),...(revision.source==='LIVE_MODEL'&&agent?.requirements?{requirement:sqlRequirementBinding(agent.requirements)}:{})})), () => {
      if (existing) return existing;
      const bundle = createDeliveryPackage({run, revision,agent:revision.source==='LIVE_MODEL'?agent:undefined,developmentReference,manualAuthor:standaloneManual, name: standaloneManual?'手工开发 · 已核验证券加工交付':developmentReference?'人工辅助修正 · 已核验证券加工交付':"工程师接管 · 已核验证券加工交付"});
      const task = store.create(resource, project, {mode, sourceKind: "MANUAL",...(standaloneManual?{source:{kind:"MANUAL_RUN",runId:run.id,revisionId:revision.id,revisionHash:revision.hash},sourceBinding:source.binding}:{sourceAgentTaskId:agent.id}),
        sourceRunId: run.id, sourceRevisionId: revision.id, sourceSqlHash: revision.hash,...(standaloneManual?{sourceAttribution:'ENGINEER_AUTHORED',modelRequired:false}:{}), submittedBy: actorId, status: "QUEUED", stage: "PACKAGE_PERSISTING",
        packageDigest: bundle.digest,...(bundle.manifest.source.requirement?{sourceRequirementBinding:bundle.manifest.source.requirement}:{}),...(developmentReference?{developmentReference}:{}), completionScope: standaloneManual?'CLASSIC_MANUAL_DELIVERY_PREPARATION':"MANUAL_DELIVERY_PREPARATION", agentIndependentE2E: false, fullLifecycleE2E: false, publicDeployed: false});
      const item = store.create("delivery_package", project, {...bundle, sourceRunId: run.id, ...(standaloneManual?{manualDeliveryTaskId:task.id}:{agentDeliveryTaskId:task.id}), sourceKind: "MANUAL", agentIndependentE2E: false, stage: "M2A", published: false});
      return change(task, {packageId: item.id});
    });
    await persist(); // Persist the exact package before OSS; an unknown PUT resumes its digest.
    const task = get(dedup.id);
    return publicDeliveryTask(terminal.has(task.status) ? task : await persistDeliveryArtifact(task));
  }
  async function create(agent, key, expected) {
    if(standaloneManual)throw fail(422,'独立手工交付不能接受Agent任务作为来源');
    assertExecutionScope(agent);
    const { run, revision } = source(agent);
    if (expected) checkPinnedSource(agent,{revision,run},expected);
    const requirement = agent.requirements ? sqlRequirementBinding(agent.requirements) : undefined;
    const findExisting = () => store.list(resource, project).find(t => t.mode === durableDeliveryMode && t.sourceAgentTaskId === agent.id &&
      t.sourceRevisionId === revision.id && t.sourceRunId === run.id && t.sourceSqlHash === revision.hash &&
      isDeepStrictEqual(t.sourceRequirementBinding,requirement) && ["QUEUED","RUNNING","SUCCEEDED"].includes(t.status));
    const namespace = `${project}:durable-delivery:${agent.id}:${key}`;
    const signature = hash(JSON.stringify({runId:run.id, revisionHash:revision.hash, ...(requirement ? {requirement} : {})}));
    const existing = findExisting();
    if (existing) assertSqlRequirementPackageSource(store.get("delivery_package", existing.packageId, project), {agent,run,revision});
    let bundle, artifact;
    if (!existing && !store.deduplicatedId(namespace)) {
      const family = validationFamilyForContext(revision.contextId);
      bundle = createDeliveryPackage({run,revision,agent,name:family?.id === validationContractId
        ? "客户资产 T+1 · Agent交付" : "股票持仓＋可用现金（非客户全资产）· Agent交付"});
      if (!expected) {
        artifact = await artifactStore.put("delivery-package",bundle.digest,bundle);
        const freshAgent = store.get("agent",agent.id,project);
        assertSqlRequirementPackageSource(bundle,{agent:freshAgent,...source(freshAgent)});
      }
    }
    const dedup = store.deduplicate(namespace, signature, () => {
      const equivalent = existing ?? findExisting();
      if (equivalent) return equivalent;
      const task = store.create(resource, project, { mode, sourceAgentTaskId: agent.id, sourceRunId: run.id, sourceRevisionId: revision.id, sourceSqlHash: revision.hash, submittedBy: agent.submittedBy, status: "QUEUED",
        stage:artifact?"PACKAGE_READY":"PACKAGE_PERSISTING", packageDigest: bundle.digest,...(requirement?{sourceRequirementBinding:requirement}:{}),...(expected?{sourcePinned:true}:{}), completionScope: "DELIVERY_PREPARATION", fullLifecycleE2E: false, publicDeployed: false });
      const item = store.create("delivery_package", project, { ...bundle, ...(artifact?{artifact}:{}), sourceRunId: run.id, agentDeliveryTaskId:task.id, stage: "M2A", published: false });
      return change(task, { packageId: item.id });
    });
    await persist();
    const task = get(dedup.id);
    return publicDeliveryTask(expected ? await persistDeliveryArtifact(task) : task);
  }
  async function reconcile(id, {passive=false} = {}) {
    let task = get(id);
    if (terminal.has(task.status) || !task.remoteSubmission) return publicDeliveryTask(task);
    const verificationId = task.verificationId, prepared = task.remoteSubmission.prepared;
    if (passive && (prepared?.job?.jobId !== verificationId ||
        !storedFileRehearsal(task,store.get("delivery_verification",verificationId,project))))
      throw fail(409,"演练批次与原交付包不一致");
    const { item, plan } = await bundleFor(task);
    let receipt;
    try { receipt = await runner.read(prepared,passive ? {cancelOnTimeout:false} : undefined); }
    catch (error) { if (passive || error.code !== "REMOTE_SPARK_TIMEOUT") throw error; receipt = { status: "FAILED", error: "交付文件演练超时" }; }
    if (!receipt) return publicDeliveryTask(task);
    task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
    if (passive && (task.verificationId !== verificationId || task.packageId !== item.id || task.packageDigest !== item.digest))
      throw fail(409,"演练批次或交付包已变化");
    const family = { id: plan.source.validationContractId, contextIds: plan.fixtures.validationContexts.map(context => context.id) };
    const passed = receipt.status === "SUCCEEDED" && receipt.engine === "Apache Spark" && receipt.engineVersion === plan.deployment.runtime.version && receipt.mainSqlExecuted === true && receipt.testDouble !== true && receipt.testSqlValidation?.passed === true && receipt.testSqlValidation.sqlHash === hash(item.files["tests.sql"]) && validationMatchesFamily(receipt.validation, family);
    const verification = store.get("delivery_verification", task.verificationId, project);
    // Whitelist receipt fields; a Worker cannot overwrite package/source identifiers.
    const result = Object.fromEntries(["engine", "engineVersion", "mainSqlExecuted", "testSqlValidation", "validation", "rows", "columns", "log", "durationMs", "error", "testDouble"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]]));
    store.update("delivery_verification", verification.id, project, { ...result, status: passed ? "SUCCEEDED" : "FAILED", finishedAt: new Date().toISOString(), mode: "CLOUD_ISOLATED_FILE_REHEARSAL", actualExecution: passed, published: false });
    task = change(task, { status: passed ? "SUCCEEDED" : "FAILED", stage: passed ? "AWAITING_ENGINEER_REVIEW" : "FILE_REHEARSAL_FAILED", actualExecution: passed, finishedAt: new Date().toISOString(), ...(passed ? {} : { error: "演练未通过真实执行、测试SQL或独立回归，请检查演练记录。" }) });
    await persist(); return publicDeliveryTask(task);
  }
  async function advance(id, expectedVersion, expectedRehearsal) {
    let task = get(id);
    if (expectedRehearsal && (task.sourceKind === "MANUAL" || standaloneManual ||
        task.packageId !== expectedRehearsal.packageId || task.packageDigest !== expectedRehearsal.packageDigest ||
        task.verificationId !== expectedRehearsal.verificationId ||
        (expectedRehearsal.verificationId && !task.sourcePinned && !task.rehearsalPinned)))
      throw fail(409,"演练须绑定原交付包和批次");
    if (terminal.has(task.status)) return publicDeliveryTask(task);
    assertTaskScope(task);
    if (expectedVersion !== task.version) throw fail(409, "交付任务已更新，请刷新后继续");
    const protectedRehearsal = Boolean(expectedRehearsal || task.sourcePinned || task.rehearsalPinned);
    if (expectedRehearsal && (task.stage === "PACKAGE_PERSISTING" || expectedRehearsal.verificationId && !task.remoteSubmission))
      throw fail(409,"原交付包或演练批次尚未就绪");
    if (protectedRehearsal && task.remoteSubmission) return reconcile(id,{passive:true});
    if (task.sourceKind === "MANUAL") task = await persistDeliveryArtifact(task);
    else if (task.stage === "PACKAGE_PERSISTING") return publicDeliveryTask(await persistDeliveryArtifact(task));
    if (terminal.has(task.status)) return publicDeliveryTask(task);
    if (task.sourceKind === "MANUAL" && task.remoteSubmission && !task.remoteSubmission.submitted) {
      await reconcile(task.id); task = get(task.id);
      if (terminal.has(task.status)) return publicDeliveryTask(task);
    }
    const { item, plan } = await bundleFor(task);
    const refreshed=get(id);
    if(terminal.has(refreshed.status))return publicDeliveryTask(refreshed);
    if(refreshed.version!==task.version)throw fail(409,'交付任务已更新，请读取原任务后继续');
    task=refreshed;
    if (!task.remoteSubmission) {
      assertTaskScope(task); // Storage reads may outlive the selected source or session.
      assertRunBudget();
      const businessIndex = plan.calendar.tradingDays.indexOf(plan.fixtures.context.businessDate), nextDay = plan.calendar.tradingDays[businessIndex + 1];
      if (!nextDay) throw fail(422, "日历中缺少下一交易日，无法演练");
      const scheduledFor = `${nextDay}T${plan.schedule.at}+08:00`, occurrence = resolveDeliverySchedule(plan, scheduledFor);
      if (!occurrence.eligible || occurrence.businessDate !== plan.fixtures.context.businessDate) throw fail(422, "调度业务日与冻结输入不一致");
      const reserve = () => {
        const verification = store.create("delivery_verification", project, { packageId: item.id, packageDigest: item.digest, ...(standaloneManual?{manualDeliveryTaskId:task.id}:{agentDeliveryTaskId:task.id}), scheduledFor, occurrence, status: "RUNNING", mode, isolation: "FUNCTION_PROCESS", reservedDurationMs: reservationSeconds * 1000, published: false });
        const prepared = runner.prepare({ sql: item.files["main.sql"], testSql: item.files["tests.sql"], context: plan.fixtures.context, validationContexts: plan.fixtures.validationContexts }, verification.id);
        return change(task, { status: "RUNNING", stage: "FILE_REHEARSAL_SUBMITTING", verificationId: verification.id,
          ...(protectedRehearsal ? {rehearsalPinned:true} : {}), remoteSubmission: { prepared, submitted: false } });
      };
      if (protectedRehearsal) {
        if (task.stage !== "PACKAGE_READY" || task.verificationId) throw fail(409,"原演练批次待核对");
        const saved = store.deduplicate(`${project}:delivery-rehearsal:${task.id}`,item.digest,reserve);
        if (saved.replayed) return reconcile(id,{passive:true});
        task = get(saved.id);
      } else {
        task = reserve();
      }
      await persist();
    }
    task=get(id);
    if(terminal.has(task.status))return publicDeliveryTask(task);
    if (!task.remoteSubmission.submitted) {
      assertTaskScope(task); // Recheck after durable persistence, before new computation.
      await runner.submit(task.remoteSubmission.prepared,protectedRehearsal?{retry:false}:undefined);
      task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
      task = change(task, { stage: "FILE_REHEARSAL_RUNNING", remoteSubmission: { ...task.remoteSubmission, submitted: true } });
      await persist();
    }
    return reconcile(id,{passive:protectedRehearsal});
  }
  async function cancel(id) {
    let task = get(id); if (terminal.has(task.status)) return publicDeliveryTask(task);
    if(standaloneManual){const revision=store.get("revision",task.sourceRevisionId,project);assertExecutionScope(revision);}else assertExecutionScope(store.get("agent", task.sourceAgentTaskId, project));
    task = change(task, { status: "CANCELLED", stage: "CANCELLED", finishedAt: new Date().toISOString() });
    if (task.verificationId) store.update("delivery_verification", task.verificationId, project, { status: "CANCELLED", finishedAt: task.finishedAt });
    await persist();
    if (task.remoteSubmission) await runner.cancel(task.remoteSubmission.prepared);
    return publicDeliveryTask(task);
  }
  return { create, createManual, advance, reconcile, cancel, bundleFor };
}

export function createStandaloneManualDelivery(options){
  const engine=createDurableAgentDelivery({...options,standaloneManual:true});
  return {create:engine.createManual,advance:engine.advance,reconcile:engine.reconcile,cancel:engine.cancel,bundleFor:engine.bundleFor};
}
