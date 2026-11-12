import{readReportClarification,deriveReportClarification,assertReportClarificationPlan,reportProposalHash,reportClarificationSignature}from'./report-clarification.mjs';
import {sourceReportInitial,sourceReportMayStart,sourceReportProjection,runSourceReportPlan} from './source-report-execution.mjs';
import {certifiedDistributionSource,distributionServiceSources} from './distribution-service-source.mjs';
import {assertDistributionConsent,assertDistributionRelease,sameLocalPublicationLane,sameDistributionConsent,assertDistributionRollback,activateDistributionRollback,distributionRequestSignature} from './distribution-publication.mjs';
import { createServer } from "node:http";
import {resolveManualContinuation} from './manual-sql-continuation.mjs';
import {resolveAssistedContinuation} from './assisted-sql-delivery-source.mjs';
import {resolveSqlRepairComparison,repairComparisonAttribution,explicitRepairAttribution} from './sql-repair-comparison.mjs';
import {resolveExplicitSqlRepairSource} from './sql-repair-source.mjs';
import {sameSqlIgnoringLayout} from './sql-repair-progress.mjs';
import {buildSqlRepairFeedback} from './sql-repair-feedback.mjs';
import { ingressDenialReasons } from "./fc-ingress.mjs";
import { createRequestLane } from "./request-lane.mjs";
import { createAssetAnnotationRequests } from "./asset-annotation-requests.mjs";
import { serveV2Static } from "./static-response.mjs";
import { publicCapabilityStatus } from "./public-status.mjs";
import { publicDevelopmentConfig, developmentSession, assertDevelopmentMutation, assertDevelopmentTaskCreation, assertDevelopmentRecord, developmentBackgroundWindow, assertDevelopmentExecutionWindow, assertDevelopmentTargetTask, developmentBackgroundBoundary, assertDevelopmentBackgroundScope } from "./public-development-access.mjs";
import { publicPublicationConfig, publicationSession, assertPublicationMutation, assertPublicationTarget, assertPublicationExecutionWindow } from "./public-publication-access.mjs";
import { publicServiceConfig, serviceSession, assertServiceMutation } from "./public-service-access.mjs";
import { readFile, readdir } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { MetadataStore } from "./store.mjs";
import { callPrivateApplication, verifyPrivateApplicationTask,validatePrivateApplicationRequest } from "./private-application.mjs";
import { publicDevelopmentRun, submitDurableDevelopment, reconcileDurableDevelopment } from "./durable-development.mjs";
import { validationWithoutRawComparisons } from "./validation-details.mjs";
import { createDurableSqlAgent, durableSqlAgentMode, publicDurableAgent } from "./durable-agent.mjs";
import {sqlRequirementReport,bindSqlRequirementRevision,sqlRequirementBinding,assertSqlRequirementPackageSource} from './sql-requirements.mjs';
import {readSqlClarificationSource,resolveSqlClarification,assertSqlClarificationTask} from './sql-clarification.mjs';
import {clarificationAttribution} from './sql-clarification-contract.mjs';
import { resolveAgentContextDerivation } from "./agent-context-derivation.mjs";
import { createDurableAgentDelivery, createStandaloneManualDelivery, standaloneManualDeliveryMode, durableDeliveryMode, publicDeliveryTask, developmentVerificationReport, manualCloudDeliverySource, resolveEvidenceSource, storedFileRehearsal } from "./agent-development-workflow.mjs";
import { createCloudPublication, createStandaloneManualPublication, validatePublicationSelector } from "./cloud-publication.mjs";
import { projectCloudReleaseBatchStage } from "./cloud-release-evidence.mjs";
import{standaloneManualPublicationSource}from"./standalone-manual-publication-source.mjs";
import { parseAgentReviewEvidencePath, publicationSelectorFromUrl } from "./publication-request.mjs";
import { localTaskPublication } from "./local-task-publication.mjs";
import { localTaskConsumption } from "./local-task-consumption.mjs";
import { fundAgentTaskConsumption } from "./fund-agent-task-consumption.mjs";
import { localServiceSources } from "./local-service-sources.mjs";
import {servicePlanSourceBinding,servicePlanSourceQuery,resolveServicePlanSource,assertServicePlanVersions,bindServicePlanProposal,servicePlanDraftMatches,publicServicePlan} from './service-plan-source.mjs';
import { saveManualRevision, savedManualRevision } from "./manual-revisions.mjs";
import { assertSyncSqlOutputSchema, currentSyncSqlInput, freezeSyncSqlInput, parseSyncSqlSelection, readSyncSqlInput, syncSqlColumnsMatch, syncSqlContextId, syncSqlContractId, syncSqlDeliverySource, syncSqlOutputColumns, syncSqlOutputSchemaCode, syncSqlOutputSchemaDetails, syncSqlOutputSchemaMessage, syncSqlRowsMatch } from "./sync-sql-input.mjs";
import { isDeepStrictEqual } from "node:util";
import { activateSyncSqlRelease, assertSyncSqlBatch, assertSyncSqlConsent, syncApprovalExpiry, syncSqlReviewDigest, syncSqlScheduledSchemaDetails } from "./sync-sql-publication.mjs";
import { certifiedSyncSqlSource, readSyncSqlCallEvidence, syncServiceProtocol, syncSqlServiceSources } from "./sync-sql-service-source.mjs";
import { isSyncAssetId, isSyncReportEvidence, syncAssetBatchId, syncAssetView, syncReportAsset } from "./sync-sql-report.mjs";
import { createPrivateDataServices } from "./private-data-services.mjs";
import {privateServiceAgentProfile,assertServiceAgentMutation,assertServiceAgentIngress,serviceAgentSession} from './private-service-agent-policy.mjs';
import { privateServiceSourceSelection } from "./private-service-routes.mjs";
import { publishServiceReviewed, activateServiceReviewed } from "./service-version-governance.mjs";
import { privateReleaseConfig, validatePrivateReleaseTimer } from "./private-release-timer.mjs";
import { createAgentDispatcher } from "./agent-dispatcher.mjs";
import {createServiceAgentEvents} from './service-agent-events.mjs';
import { createAgentEventDriver, agentEventConfigFromEnvironment } from "./agent-event-driver.mjs";
import { createAgentWakeOssTransport } from "./agent-wake-oss-transport.mjs";
import { ossConfigFromEnvironment } from "./oss-client.mjs";
import { queueConfigFromEnvironment } from "./remote-spark-queue.mjs";
import { privateAgentRecovery } from "./private-agent-recovery.mjs";
import {
  getContext,
  publicContext,
  contextIds,
  allContextIds,
  classicContextIds,
  validationFamilyForContext,
  referenceSql,
  validationContractId,
} from "./context.mjs";
import { fundRehearsalAt, isFundContext } from "./fund-contexts.mjs";
import { bindFundSignedDelivery } from "./fund-signed-delivery.mjs";
import { createFundSignedReceipts } from "./fund-signed-receipts.mjs";
import { createFundRehearsalRecovery } from "./fund-rehearsal-recovery.mjs";
import { fundRehearsalRecheckResult, readFundRehearsalRecheck } from "./fund-rehearsal-recheck.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "./fund-preparation.mjs";
import { parseFundExecutionPreflightPath } from "./fund-preparation-request.mjs";
import { fundExecutionPreflight } from "./fund-execution-preflight.mjs";
import { fundAgentAttributionKind, fundAgentDeliveryAttribution, verifiedFundRun } from "./fund-delivery.mjs";
import { fundAgentServiceSources, fundConsumptionSelection, resolveFundConsumptionSource } from "./fund-consumption-source.mjs";
import { assertFundAgentMonitoring, assertFundBatch, assertFundConsent, assertFundRehearsal, assertFundRelease, fundAgentPublicationPreflight, fundSignedRehearsalDigest } from "./fund-publication.mjs";
import { runSpark, runtimeConfig } from "./spark.mjs";
import {
  pythonRuntimeConfig,
  runRestrictedPython,
} from "./python.mjs";
import {
  generateSql,
  generatePython,
  generateDataServicePlan,
  generateIngestionPlan,
  generateRealtimePlan,
  generateAssetInsight,
  generateQualityPlan,
  generateSecurityPlan,
  generateReportPlan,
  generateOpsDiagnosis,
  generateAgentIntent,
  modelSettings,
  ModelUnavailable,
} from "./model.mjs";
import { capabilities } from "./capabilities.mjs";
import { saveLocalModelKey } from "./model-credentials.mjs";
import { safeModelDiagnostic } from "./model-diagnostics.mjs";
import {
  createDeliveryPackage,
  validateDeliveryPackage,
  resolveDeliverySchedule,
  unpackDeliveryPackage,
} from "./delivery.mjs";
import { assertSyncSqlRehearsal, boundSyncSqlFileColumns, checkedSyncSqlFileRehearsal, syncSqlRehearsalSchemaDetails, verifyDeliveryDirectory } from "./delivery-runner.mjs";
import {
  createPythonDeliveryPackage,
  unpackPythonDeliveryPackage,
  validatePythonDeliveryPackage,
  verifyPythonDeliveryDirectory,
} from "./python-delivery.mjs";
import {
  DurableReleaseScheduler,
  LocalReleaseScheduler,
  localReleaseUnknownResultCode,
  localScheduleSpec,
  plannedLocalRuns,
  publicRelease,
} from "./release-scheduler.mjs";
import {
  schedulerTickConfigFromEnvironment,
  verifySchedulerTick,
} from "./scheduler-tick.mjs";
import {
  BusinessQueryStore,
  DataServiceManager,
  verifiedPrivateServiceSource,
} from "./data-services.mjs";
import {
  IngestionManager,
  LandingStore,
} from "./ingestion.mjs";
import { createServerMysqlSourceAdapter } from "./server-mysql-source.mjs";
import {
  RealtimeManager,
  StreamStateStore,
} from "./realtime.mjs";
import { AssetCatalogManager } from "./assets.mjs";
import { QualityManager } from "./quality.mjs";
import { fundReportQuality } from "./fund-report-quality.mjs";
import { readWealthReportConsumption } from "./wealth-report-consumption.mjs";
import { SecurityManager } from "./security.mjs";
import { ReportDataStore, ReportManager } from "./reports.mjs";
import { privateBatchReportQuery, privateBatchReportRoute } from "./private-batch-report-request.mjs";
import { readPrivateBatchReport } from "./private-batch-report.mjs";
import { archiveSha, batchArchiveRoute } from "./private-batch-archive-client.mjs";
import { createPrivateBatchArchive } from "./private-batch-archive.mjs";
import {resolvePublishedReportSource} from './published-report-source.mjs';
import {createPublishedReportWorkflow} from './published-report-workflow.mjs';
import {createReportProvenance,reviewedReportBasis} from './report-provenance.mjs';
import {publishedReportSource,reportRequestId as publishedReportSourceBatchId} from './published-report-request.mjs';
import {publishedReportHash} from './published-report-source.mjs';
import {publishedReportPlanningContext,validatePublishedReportPlan,publishedReportPlanHash,samePublishedReportSource} from './published-report-plan.mjs';
import { OperationsManager } from "./operations.mjs";
import { AuthManager } from "./auth.mjs";
import { DataContractManager } from "./contracts.mjs";
import {createServiceContractGates} from './service-contract-gates.mjs';
import{compareSqlRuns}from'./run-comparison.mjs';
import { agentEvidenceJourney } from "./agent-journey.mjs";
import { storedAgentReviewEvidence } from "./agent-review-evidence.mjs";
import { storedAgentExecutionEvidence } from "./agent-execution-evidence.mjs";
import { readDeliveryAdvance, readDeliveryPreparationSource } from "./delivery-preparation-request.mjs";
import {
  LocalArtifactStore,
  deliveryArtifactValue,
} from "./artifact-store.mjs";
import {
  BudgetManager,
  budgetAgentCreationPaths,
} from "./budget.mjs";
import { verifyLifecycleReport } from "./lifecycle-evaluation.mjs";
import {liveLifecycleOverview} from "./live-lifecycle-overview.mjs";
import {liveExecutionSnapshot} from "./live-lifecycle-execution.mjs";
import {createDeliveryEvidenceAccess} from "./delivery-evidence-access.mjs";
import {
  evaluateCloudPreflight,
  publicCloudReadiness,
} from "./cloud-preflight.mjs";
import {
  publicAgentIntentDestinations,
  publicAgentToolCatalog,
  agentSpecialistKinds,
  validateAgentToolInput,
  validateAgentApprovalMode,
  validateAgentIntentMessage,
  validateAgentIntentRoute,
} from "./agent-router.mjs";

export const PROJECT = "project-securities-lab";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
export function assertV2RequestScope(req, { env, local }) {
  const origin = req.headers.origin;
  let localOriginAllowed = false;
  if (local && typeof origin === "string") {
    try {
      const parsedOrigin = new URL(origin),
        localPort = String(req.socket.localPort ?? env.V2_PORT ?? 3100);
      localOriginAllowed =
        origin === parsedOrigin.origin &&
        parsedOrigin.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname) &&
        [localPort, "5173"].includes(parsedOrigin.port);
    } catch {
      localOriginAllowed = false;
    }
  }
  if (
    origin &&
    !(
      localOriginAllowed ||
      (!local &&
        typeof env.V2_PUBLIC_ORIGIN === "string" &&
        origin === env.V2_PUBLIC_ORIGIN)
    )
  )
    throw fail(403, "请求来源不允许");
  if (
    req.headers["x-project-id"] &&
    req.headers["x-project-id"] !== PROJECT
  )
    throw fail(403, "无权访问此项目");
}
export const publicV2Contexts = () => allContextIds.map(publicContext);
const validationFamily = contextId => {
  const family=validationFamilyForContext(contextId);
  if(!family)throw fail(409,"代码或运行绑定的业务口径版本不存在");
  return family;
};
const validationContextsFor = contextId => validationFamily(contextId).contextIds.map(getContext);
const text = (value, min = 1, max = 20000) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, "提交内容长度不符合要求");
  return value.trim();
};
function isLoopbackRequest(req) {
  const host = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/i;
  return host.test(req.headers.host ?? "") && ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
}
const contextsPath = "/api/v2/contexts";
const isPublicContextRead = (req, channel) =>
  channel === "HTTP" && req.method === "GET" && req.url.split("?", 1)[0] === contextsPath;
const json = async (res, status, data, headers = {}) => {
  let responseStatus = status,
    responseData = data,
    responseHeaders = headers;
  try {
    await res.metadataFlush?.();
  } catch (error) {
    responseStatus = error.status ?? 503;
    responseData = {
      message: error.status
        ? error.message
        : "云端元数据保存失败，请刷新确认后重试",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    };
    // Never issue a login/session cookie when the session itself did not reach
    // durable storage.
    responseHeaders = {};
  }
  res.writeHead(responseStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...responseHeaders,
  });
  res.end(JSON.stringify(responseData));
};
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "VALIDATION_FAILED",
  "INTERRUPTED",
]);
export function createV2Server(options = {}) {
  const env = options.env ?? process.env,
    root = options.root ?? process.cwd();
  if (env.V2_FC_PUBLIC_WRITE_SCOPE === "SERVICE_CONSUMPTION_ONLY" &&
      (env.V2_LOCAL_DEVELOPMENT !== "false" || env.V2_PROVISIONING_ONLY !== "true" ||
       env.V2_PRIVATE_SMOKE_ENABLED !== "true" || env.V2_PRIVATE_DATA_SERVICES_ENABLED !== "true"))
    throw new Error("PUBLIC_SERVICE_BACKEND_REQUIRED");
  const store =
    options.store ?? new MetadataStore(join(root, ".data/v2-platform.sqlite"));
  const ownsBusinessStore = !options.businessStore,
    businessStore =
      options.businessStore ??
      new BusinessQueryStore(
        options.store ? ":memory:" : join(root, ".data/v2-business-services.sqlite"),
      );
  const ownsLandingStore = !options.landingStore,
    landingStore =
      options.landingStore ??
      new LandingStore(
        options.store ? ":memory:" : join(root, ".data/v2-landing.sqlite"),
      );
  const ownsStreamStateStore = !options.streamStateStore,
    streamStateStore =
      options.streamStateStore ??
      new StreamStateStore(
        options.store ? ":memory:" : join(root, ".data/v2-stream-state.sqlite"),
      );
  const ownsReportStore = !options.reportStore,
    reportStore =
      options.reportStore ??
      new ReportDataStore(
        options.store ? ":memory:" : join(root, ".data/v2-reports.sqlite"),
      );
  const persistence = options.stateCoordinator ?? store;
  const artifactStore =
    options.artifactStore ??
    new LocalArtifactStore(join(root, ".v2-artifacts", "object-store"));
  const host = env.V2_HOST ?? "127.0.0.1",
    local = env.V2_LOCAL_DEVELOPMENT !== "false",
    privateSmokeEnabled =
      !local &&
      env.V2_PROVISIONING_ONLY === "true" &&
      env.V2_PRIVATE_SMOKE_ENABLED === "true",
    releaseSchedulerMode =
      options.releaseSchedulerMode ??
      env.V2_RELEASE_SCHEDULER_MODE ??
      (local ? "LOCAL_TIMER" : "DISABLED"),
    insecurePublicCookies =
      env.V2_ALLOW_INSECURE_PUBLIC_COOKIES === "true";
  if (!new Set(["LOCAL_TIMER", "DURABLE_TICK", "DISABLED"]).has(releaseSchedulerMode))
    throw new Error("发布调度模式不受支持");
  if (local && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("本地开发会话只能绑定回环地址");
  if (
    !local &&
    insecurePublicCookies &&
    !["127.0.0.1", "localhost", "::1"].includes(host)
  )
    throw new Error("非安全公网Cookie仅允许回环地址测试");
  if (
    env.V2_META_DRIVER &&
    !["sqlite", "mysql-project-snapshot-cas"].includes(env.V2_META_DRIVER)
  )
    throw new Error("平台元数据库驱动不受支持");
  if (
    env.V2_META_DRIVER === "mysql-project-snapshot-cas" &&
    typeof store.replicationStatus !== "function"
  )
    throw new Error("已要求云端MySQL元数据库，但当前存储没有复制能力");
  const auth = new AuthManager({
    store,
    project: PROJECT,
    now: options.now,
    env,
  }),
    budget = new BudgetManager({
      store,
      project: PROJECT,
      env,
      now: options.now,
    });
  const runtime = runtimeConfig(env, root);
  const pythonRuntime = pythonRuntimeConfig(env, root);
  const runnerDescriptor = options.runnerDescriptor ?? options.runner?.descriptor ?? {
    engine: "Apache Spark",
    isolation: "LOCAL_PROCESS",
    endpointConfigured: false,
    publicWriteEnabled: false,
  },
    rawRunner = options.runner ?? ((input) => runSpark(input, runtime)),
    runner = async (input) => {
      if (runnerDescriptor.isolation === "REMOTE_FUNCTION")
        budget.assertCanStartRemoteSpark();
      return rawRunner(input);
    };
  runner.descriptor = runnerDescriptor;
  const publicationAccess = publicPublicationConfig(env);
  const serviceAccess = publicServiceConfig(env);
  const serviceAgentAccess=privateServiceAgentProfile(env);
  assertServiceAgentIngress(serviceAgentAccess,options.ingress);
  const developmentAccess = publicDevelopmentConfig(env);
  const developmentNow = () => options.now?.() ?? Date.now();
  const assertTargetTask = task => assertDevelopmentTargetTask(developmentAccess, task,
    store.get('auth_user', task?.submittedBy ?? '', PROJECT), PROJECT, developmentNow());
  const assertScopedRecord = (session, item) => assertDevelopmentRecord(developmentAccess, session, item, {
    task: developmentAccess?.taskId ? store.get('agent', developmentAccess.taskId, PROJECT) : undefined, now: developmentNow(),
  });
  const targetDenied = () => Object.assign(fail(403, '当前窗口只允许指定任务及其已关联的代码和交付文件。'), {code:'PUBLIC_DEVELOPMENT_TARGET_ONLY'});
  const assertTargetRun = (id, input) => {
    if (!developmentAccess?.taskId) return;
    const task = store.get('agent', developmentAccess.taskId, PROJECT);
    assertTargetTask(task);
    const run = store.get('run', id, PROJECT);
    if (run) {
      const revision = store.get('revision', run.revisionId, PROJECT), owner = store.get('auth_user', task.submittedBy, PROJECT);
      assertScopedRecord({user:owner,role:'ADMIN'},revision);
      if (run.revisionHash !== revision.hash || run.agentTaskId && run.agentTaskId !== task.id ||
          input && (input.sql !== revision.sql || input.context?.id !== revision.contextId)) throw targetDenied();
      return;
    }
    const verification = store.get('delivery_verification', id, PROJECT),
      delivery = store.get('agent_delivery_task', verification?.agentDeliveryTaskId ?? '', PROJECT),
      bundle = store.get('delivery_package', delivery?.packageId ?? '', PROJECT);
    if (!verification || delivery?.sourceAgentTaskId !== task.id || delivery.submittedBy !== task.submittedBy ||
        verification.packageId !== bundle?.id || verification.packageDigest !== bundle?.digest || delivery.packageDigest !== bundle?.digest ||
        input && (input.sql !== bundle?.files?.['main.sql'] || input.testSql !== bundle?.files?.['tests.sql'])) throw targetDenied();
  };
  const assertDevelopmentExecution = () => {
    if(serviceAgentAccess)throw Object.assign(fail(403,'当前仅允许指定来源的服务模型规划，不执行SQL或Spark'),{code:'PRIVATE_SERVICE_AGENT_SCOPE_DENIED'});
    if (serviceAccess) throw Object.assign(fail(403, "本次仅开放既有发布结果的接口交付，不启动模型或 Spark。"), { code: "PUBLIC_SERVICE_SCOPE_DENIED" });
    if (publicationAccess) throw Object.assign(fail(403, "本次仅允许审阅发布既有交付包，不启动模型或新的开发计算。"), { code: "PUBLIC_PUBLICATION_SCOPE_DENIED" });
    assertDevelopmentExecutionWindow(developmentAccess, options.now?.() ?? Date.now());
  };
  const durableDevelopment = !rawRunner.durable || (!developmentAccess && !publicationAccess && !serviceAccess && !serviceAgentAccess) ? rawRunner.durable : {
    prepare: (input, id) => { assertDevelopmentExecution(); assertTargetRun(id, input); return rawRunner.durable.prepare(input, id); },
    submit: (prepared, options) => { assertDevelopmentExecution(); assertTargetRun(prepared?.job?.jobId); return rawRunner.durable.submit(prepared,options); },
    read: (...args) => rawRunner.durable.read(...args),
    cancel: (...args) => rawRunner.durable.cancel(...args),
  },
    persistDevelopment = async () => { if (typeof persistence.flush === "function") await persistence.flush(); },
    reconcileDevelopment = async run => {
      const family = validationFamilyForRun(run);
      return durableDevelopment
        ? reconcileDurableDevelopment(run, { runner: durableDevelopment, store, project: PROJECT, persist: persistDevelopment,
          contextIds: family.contextIds, contractId: family.id, allowSubmit: false })
        : run;
    };
  const pythonRunner =
    options.pythonRunner ?? ((input) => runRestrictedPython(input, pythonRuntime));
  const localClassicSpark = local && !durableDevelopment && runnerDescriptor.isolation === "LOCAL_PROCESS";
  const syncSqlLocal = localClassicSpark && !options.ingress && env.V2_DURABLE_SQL_AGENT_ENABLED !== "true";
  const requireSyncSqlLocal = req => {
    if (!syncSqlLocal || !isLoopbackRequest(req)) throw fail(403, "同步批次开发仅在本机 Spark 工作台开放");
  };
  const assertClassicSqlContext = context => {
    if (localClassicSpark || !context?.outputContractId) return;
    if (isFundContext(context.id)) throw fail(422, "基金组合穿透仅支持本机经典 Spark SQL");
    throw fail(422, "分布契约尚未启用云端执行");
  };
  let modelVerifiedAt = null;
  const rawGenerator =
    options.generator ??
    (async (input) => {
      budget.assertCanStartModel(input.modelBudgetReservation);
      const keyAtRequest = env.DASHSCOPE_API_KEY;
      const result = await generateSql(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const generator = async input => {
    assertDevelopmentExecution();
    if (developmentAccess?.taskId) assertTargetTask(store.get('agent', input?.modelBudgetReservation?.taskId ?? '', PROJECT));
    return rawGenerator(input);
  };
  const pythonGenerator =
    options.pythonGenerator ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY;
      const result = await generatePython(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const intentPlanner =
    options.intentPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateAgentIntent(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const controls = new Map();
  let queue = Promise.resolve();
  store.interruptPending(PROJECT, {
    preserveDurableReleaseRuns: releaseSchedulerMode === "DURABLE_TICK" || env.V2_EXECUTION_UNAVAILABLE === "true",
  });
  const get = (kind, id) => {
    const item = store.get(kind, id, PROJECT);
    if (!item) throw fail(404, "未找到当前项目的记录");
    return item;
  };
  const exposeDevelopmentRun = run => publicDevelopmentRun(run, store.get("revision", run?.revisionId ?? "", PROJECT));
  function validationFamilyForRun(run) {
    // Older persisted runs only carry the context on their immutable revision.
    // Missing duplicate metadata may be read, but conflicting metadata must not
    // silently select another family's independent assertions.
    const revision = get("revision", run.revisionId);
    if (run.contextId !== undefined && run.contextId !== revision.contextId)
      throw fail(409, "运行批次与代码绑定的业务口径不一致");
    const family = validationFamily(revision.contextId);
    return revision.syncInput ? { ...family, id: syncSqlContractId } : family;
  }
  const durableAgent = env.V2_DURABLE_SQL_AGENT_ENABLED === "true"
    ? createDurableSqlAgent({ store, project: PROJECT, runner: durableDevelopment, generator,
      persist: persistDevelopment, getContext, contextIds, contractId: validationContractId, resolveValidationFamily:validationFamilyForContext,
      assertModelBudget: () => budget.assertCanStartModel(), assertRunBudget: () => budget.assertCanStartRemoteSpark(),
      assertExecutionScope: assertTargetTask,
      tokenBudget: Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000), now: options.now ?? Date.now })
    : undefined;
  const mayReadDurableAgent = (task, session) => task?.syncInput
    ? syncSqlLocal && task.submittedBy === (session?.user.id ?? "local-engineer")
    : task?.fundPreparation
    ? localClassicSpark && !options.ingress && task.submittedBy === (session?.user.id ?? "local-engineer")
    : local || session?.role === "ADMIN" || Boolean(session && task?.submittedBy === session.user.id);
  const mayReadRevision = (item, session) =>
    (!isFundContext(item?.contextId) || localClassicSpark) &&
    (!item?.syncInput || syncSqlLocal && item.author === (session?.user.id ?? "local-engineer")) &&
    (!item?.fundPreparation || !options.ingress && item.author === (session?.user.id ?? "local-engineer")) &&
    (local || session?.role === "ADMIN" || Boolean(session && item?.author === session.user.id));
  const mayReadRun = (item, session, kind = "revision") =>
    (!isFundContext(item?.contextId) || localClassicSpark) &&
    (!item?.syncInput || mayReadRevision(store.get(kind, item.revisionId, PROJECT), session) &&
      syncSqlLocal && (item.agentTaskId === undefined || mayReadDurableAgent(store.get("agent", item.agentTaskId, PROJECT), session))) &&
    (!item?.fundPreparation || mayReadDurableAgent(store.get("agent", item.agentTaskId, PROJECT), session) &&
      mayReadRevision(store.get("revision", item.revisionId, PROJECT), session)) &&
    ((local || session?.role === "ADMIN") || Boolean(session && mayReadRevision(store.get(kind, item.revisionId, PROJECT), session) &&
      (!item.agentTaskId || mayReadDurableAgent(store.get("agent", item.agentTaskId, PROJECT), session))));
  const requireDevelopmentOwner = (kind, item, req) => {
    const session = auth.sessionFromHeaders(req.headers);
    if (item?.syncInput) requireSyncSqlLocal(req);
    if (!(kind === "revision" || kind === "python_revision" ? mayReadRevision(item, session) : mayReadRun(item, session, kind === "python_run" ? "python_revision" : "revision")))
      throw Object.assign(fail(403, "无权读取或操作此开发记录"), { code: "DEVELOPMENT_ACCESS_DENIED" });
  };
  const requireDurableAgentOwner = (task, req) => {
    if (!mayReadDurableAgent(task, auth.sessionFromHeaders(req.headers)) || (task.fundPreparation || task.syncInput) && !isLoopbackRequest(req))
      throw fail(403, "无权操作此 Agent 任务");
  };
  const durableDelivery = durableAgent && durableDevelopment
    ? createDurableAgentDelivery({ store, project: PROJECT, runner: durableDevelopment, artifactStore, persist: persistDevelopment, assertRunBudget: () => budget.assertCanStartRemoteSpark(), assertExecutionScope: assertTargetTask, reservationSeconds: Number(env.V2_REMOTE_SPARK_RESERVATION_SECONDS ?? 30) })
    : undefined;
  const privatePublicationConfig = privateReleaseConfig(env);
  const privateDataServicesEnabled=env.V2_PRIVATE_DATA_SERVICES_ENABLED==="true";
  if(privateDataServicesEnabled && !privateSmokeEnabled)throw new Error("私有数据服务只能在受保护的私有边界启用");
  const standalonePublicationReady=Boolean(rawRunner.durable&&env.V2_DURABLE_MANUAL_DELIVERY_ENABLED==='true'&&publicationAccess?.sourceKind==='MANUAL_DELIVERY');
  if (privatePublicationConfig && (!privateSmokeEnabled || !durableDelivery&&!standalonePublicationReady)) throw new Error("私有发布须使用已启用的私有持久执行边界");
  const cloudPublicationHistory = createCloudPublication({ store, project: PROJECT, runner: publicationAccess ? rawRunner.durable : durableDevelopment, artifactStore, persist: persistDevelopment, enabled: Boolean(privatePublicationConfig && durableDelivery), assertBudget: () => budget.assertCanStartRemoteSpark(), now: options.now ?? Date.now, reservationSeconds: durableDelivery ? Number(env.V2_REMOTE_SPARK_RESERVATION_SECONDS ?? 30) : 30, singleRelease: Boolean(publicationAccess),
    assertPublicationScope: target => assertPublicationTarget(publicationAccess, target, options.now?.() ?? Date.now()),
    assertExecutionScope: release => assertPublicationExecutionWindow(publicationAccess, release, options.now?.() ?? Date.now()) });
  const cloudPublication = durableDelivery ? cloudPublicationHistory : undefined;
  const manualPublisher=(assertScope=()=>{})=>rawRunner.durable?createStandaloneManualPublication({store,project:PROJECT,runner:rawRunner.durable,artifactStore,persist:persistDevelopment,
    enabled:Boolean(privatePublicationConfig&&standalonePublicationReady),singleRelease:true,now:options.now??Date.now,reservationSeconds:Number(env.V2_REMOTE_SPARK_RESERVATION_SECONDS??30),
    assertBudget:()=>budget.assertCanStartRemoteSpark(),assertPublicationScope:target=>{assertPublicationTarget(publicationAccess,target,options.now?.()??Date.now());assertScope();},
    assertExecutionScope:release=>assertPublicationExecutionWindow(publicationAccess,release,options.now?.()??Date.now())}):undefined;
  const standaloneCloudPublication=manualPublisher();
  const agentDriverMode = env.V2_AGENT_DRIVER_MODE ?? "DISABLED";
  if (!["DISABLED", "PRIVATE_TICK", "OSS_EVENTS"].includes(agentDriverMode)) throw new Error("Agent 后台推进模式不受支持");
  if (agentDriverMode !== "DISABLED" && (!privateSmokeEnabled || !durableAgent))
    throw new Error("Agent 后台推进需要私有调用边界与持久执行器");
  const agentDispatcher = agentDriverMode !== "DISABLED"
    ? createAgentDispatcher({ store, project: PROJECT, engine: durableAgent, persist: persistDevelopment, now: options.now ?? Date.now })
    : undefined;
  const agentEventConfig = agentEventConfigFromEnvironment(env);
  const agentWakeTransport = agentEventConfig ? options.agentWakeTransport ?? (()=>{
    const oss=ossConfigFromEnvironment(env);
    return createAgentWakeOssTransport({...oss,credentialsProvider:async()=>ossConfigFromEnvironment(env).credentials,
      wakePrefix:agentEventConfig.wakePrefix,resultPrefix:agentEventConfig.resultPrefix});
  })() : undefined;
  const agentEventDriver = agentEventConfig ? createAgentEventDriver({store,project:PROJECT,dispatcher:agentDispatcher,engine:durableAgent,
    transport:agentWakeTransport,config:agentEventConfig,queueConfig:queueConfigFromEnvironment(env),persist:persistDevelopment,now:options.now ?? Date.now,
    assertExecutionScope:(task,boundary)=>assertDevelopmentBackgroundScope(developmentAccess,task,store.get('auth_user',task?.submittedBy??'',PROJECT),PROJECT,boundary,developmentNow())}) : undefined;
  const exposeDurableTask = task => {
    const background=agentEventDriver&&task.executionMode===durableSqlAgentMode?agentEventDriver.status(task.id):undefined;
    const visible={...publicDurableAgent(task)};
    // Older local SQL tasks retained the final run only inside attempts. Recover
    // its display pointer from the verified existing relationship, never by
    // choosing a newer run or modifying the stored task on a read.
    if(local&&task.executionMode!==durableSqlAgentMode&&task.language!=="PYTHON"&&task.runId===undefined){
      const attempt=task.attempts?.at(-1),revision=attempt?.revisionId?store.get("revision",attempt.revisionId,PROJECT):undefined,
        run=attempt?.runId?store.get("run",attempt.runId,PROJECT):undefined;
      if(run&&revision&&run.agentTaskId===task.id&&run.revisionId===revision.id&&task.revisionId===revision.id&&
        run.revisionHash===revision.hash&&typeof revision.sql==="string"&&hash(revision.sql)===revision.hash&&task.sql===revision.sql)
        visible.runId=run.id;
    }
    return {...visible,...(background&&background.status!=="INACTIVE"?{background}:{})};
  };
  const privateRuntimeBootId = randomUUID();
  const publicAgentIntent = ({ submittedBy, message, ...item }) => item;
  const publicAgentHandoff = ({ submittedBy, ...item }) => item;
  const publicAgentApproval = ({ submittedBy, ...item }) => item;
  const mayReadAgentIntent = (item, session) =>
    local || session?.role === "ADMIN" || item.submittedBy === session?.user.id;
  const agentIntentGraph = (intent) => {
    const steps = intent.route?.steps ?? (intent.route
        ? [
            {
              destinationId: intent.route.destinationId,
              label: intent.route.destination.label,
              risk: intent.route.destination.risk,
              objective: intent.route.summary,
            },
          ]
        : []),
      approvals = store
        .list("agent_intent_approval", PROJECT)
        .filter((item) => item.intentId === intent.id),
      handoffs = store
        .list("agent_intent_handoff", PROJECT)
        .filter((item) => item.intentId === intent.id),
      invocations = store
        .list("agent_tool_invocation", PROJECT)
        .filter((item) => item.intentId === intent.id),
      graphSteps = steps.map((step, index) => {
        const approval = approvals
            .filter((item) => item.destinationId === step.destinationId)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .at(-1),
          handoff = handoffs
            .filter((item) => item.destinationId === step.destinationId)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .at(-1),
          invocation = invocations
            .filter((item) => item.destinationId === step.destinationId)
            .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
            .at(-1),
          invocationIsNewer =
            invocation &&
            (!handoff ||
              String(invocation.createdAt).localeCompare(
                String(handoff.createdAt),
              ) > 0),
          specialistTaskId =
            (invocationIsNewer ? invocation?.specialistTaskId : undefined) ??
            handoff?.specialistTaskId,
          specialistTaskKind =
            (invocationIsNewer ? invocation?.specialistTaskKind : undefined) ??
            handoff?.specialistTaskKind,
          specialist = specialistTaskId && specialistTaskKind
            ? store.get(specialistTaskKind, specialistTaskId, PROJECT)
            : undefined,
          status =
            specialist?.status ??
            handoff?.status ??
            invocation?.status ??
            approval?.status ??
            "PLANNED",
          invocationRecovery =
            invocation?.status === "TASK_CREATED"
              ? "RETRY_BINDING"
              : ["INTERRUPTED", "FAILED", "CANCELLED"].includes(
                    invocation?.status,
                  )
                ? "RETRY_REQUIRED"
                : invocation?.status === "CLAIMED"
                  ? "WAIT"
                  : "NONE";
        return {
          sequence: index + 1,
          destinationId: step.destinationId,
          label: step.label,
          risk: step.risk,
          objectiveHash: hash(step.objective),
          status,
          ...(approval
            ? { approvalId: approval.id, approvalStatus: approval.status }
            : {}),
          ...(handoff?.specialistTaskId
            ? {
                handoffId: handoff.id,
                specialistTaskId: handoff.specialistTaskId,
                specialistTaskKind: handoff.specialistTaskKind,
                specialistStatus: specialist?.status ?? "MISSING",
              }
            : specialistTaskId
              ? {
                  specialistTaskId,
                  specialistTaskKind,
                  specialistStatus: specialist?.status ?? "MISSING",
                }
            : {}),
          ...(invocation
            ? {
                invocationId: invocation.id,
                invocationStatus: invocation.status,
                invocationAttempt: invocation.attempt ?? 1,
                invocationRecovery,
              }
            : {}),
          executionEvidence: !invocationIsNewer && handoff?.specialistTaskId
            ? "SPECIALIST_TASK_LINKED"
            : specialist
              ? "SPECIALIST_TASK_AWAITING_LINK"
              : invocation
                ? "TOOL_INVOCATION_RECORDED"
                : "NO_SPECIALIST_EXECUTION",
        };
      }),
      completedStatuses = new Set(["SUCCEEDED", "APPLIED"]);
    return {
      intentId: intent.id,
      status: intent.status,
      approvalMode: intent.approvalMode,
      completionScope: "AGENT_ORCHESTRATION_GRAPH",
      steps: graphSteps,
      completedCount: graphSteps.filter(
        (step) =>
          step.executionEvidence === "SPECIALIST_TASK_LINKED" &&
          completedStatuses.has(step.specialistStatus),
      ).length,
      totalCount: graphSteps.length,
      agentIndependentE2E: false,
      fullLifecycleE2E: false,
      publicDeployed: false,
    };
  };
  const cloudReadiness = async () => {
    let report;
    try {
      if (options.cloudReadinessEvidence) report = options.cloudReadinessEvidence;
      else {
        const evidenceDirectory = join(root, "docs", "evidence"),
          source =
            options.cloudReadinessEvidencePath ??
            join(
              evidenceDirectory,
              (
                await readdir(evidenceDirectory)
              )
                .filter((name) => /^aliyun-readonly-audit-\d{4}-\d{2}-\d{2}\.json$/.test(name))
                .sort()
                .at(-1) ?? "aliyun-readonly-audit-missing.json",
            );
        report = JSON.parse(await readFile(source, "utf8"));
      }
    } catch {
      const result = evaluateCloudPreflight(undefined, Date.now(), {});
      return publicCloudReadiness(undefined, result, false);
    }
    const result = evaluateCloudPreflight(report, Date.now(), {
      functionName: env.V2_FUNCTION_NAME,
      publicUrl: env.V2_PUBLIC_URL,
    });
    return publicCloudReadiness(report, result, true);
  };
  const releaseTimeUnitMs = Number(options.releaseTimeUnitMs ?? 1000);
  if (!Number.isSafeInteger(releaseTimeUnitMs) || releaseTimeUnitMs < 1)
    throw new Error("本机发布调度时间单位不合法");
  const fundPreparations = createFundPreparations({ store, project: PROJECT });
  const packageRequirementSource=(run,revision)=>({run,revision,agent:(revision?.source==='LIVE_MODEL'||revision?.fundPreparation||revision?.syncInput)&&run?.agentTaskId?store.get('agent',run.agentTaskId,PROJECT):undefined});
  const syncDeliveryInputs = (run, revision) => {
    if (!revision?.syncInput && !run?.syncInput) return {};
    if (!syncSqlLocal) throw fail(403, "同步持仓文件仅在本机 Spark 工作台开放");
    if (!run || !revision) throw fail(409, "原开发运行或代码版本缺失");
    const agent = get("agent", run.agentTaskId ?? revision.manualProvenance?.originAgentTaskId ?? "");
    const syncContext = readSyncSqlInput({ store, project: PROJECT, actorId: revision.author, binding: revision.syncInput });
    return { agent, syncContext };
  };
  const assertPreparedFundSource = (selected) => {
    if (!localClassicSpark || options.ingress) throw fail(403, "基金 Agent 文件仅支持本机 Spark");
    const attribution = fundAgentDeliveryAttribution(selected), { requestId, basisDigest } = attribution.preparation;
    const { contextId, message, submittedBy } = selected.agent;
    const original = fundPreparations.bindExecution({ requestId, basisDigest, confirm: true }, submittedBy,
      { contextId, message, requestKey: requestId });
    if (Object.keys(original).some(key => original[key] !== attribution.preparation[key]))
      throw fail(409, "基金交付与原准备回执不一致");
    return attribution;
  };
  const assertRequirementSource=item=>{
    const source=item.manifest?.source,run=store.get('run',source?.runId??'',PROJECT),revision=store.get('revision',source?.revisionId??'',PROJECT);
    const selected=packageRequirementSource(run,revision);if(selected.agent?.clarification)assertSqlClarificationTask(selected.agent,{store,project:PROJECT});
    if (source?.syncInput || run?.syncInput || revision?.syncInput) {
      const inputs = syncDeliveryInputs(run, revision);
      if (!inputs.syncContext || !isDeepStrictEqual(source.syncInput, syncSqlDeliverySource({ run, revision, agent: inputs.agent })) ||
          source.sqlHash !== revision.hash || run.revisionId !== revision.id || run.revisionHash !== revision.hash ||
          run.status !== "SUCCEEDED" || run.validation?.selectedPassed !== true ||
          !syncSqlRowsMatch(run.rows, inputs.syncContext))
        throw fail(409, "交付包与原同步批次、代码或开发结果不一致");
      assertSyncSqlOutputSchema(run.columns);
    }
    if (source?.attribution?.kind === fundAgentAttributionKind || revision?.fundPreparation) {
      const current = assertPreparedFundSource(selected);
      if (hash(JSON.stringify(current)) !== hash(JSON.stringify(source.attribution))) throw fail(409, "基金交付的 Agent 来源已变化");
    }
    return assertSqlRequirementPackageSource(item,selected);
  };
  const isPythonDelivery = (item) =>
      item?.manifest?.format === "shuduo-python-delivery/v1",
    validateAnyDeliveryPackage = (item) => {
      if (isFundContext(item?.manifest?.source?.contextId) && !localClassicSpark) throw fail(422, "基金交付仅支持本机文件演练");
      if(item?.manifest?.source?.outputContract&&!local)throw fail(422,"分布交付当前仅支持本机文件演练");
      const plan=(isPythonDelivery(item)
        ? validatePythonDeliveryPackage
        : validateDeliveryPackage)(item, item.digest);
      if(!isPythonDelivery(item))assertRequirementSource(item);
      return plan;
    },
    unpackAnyDeliveryPackage = (item, directory) =>
      (isPythonDelivery(item)
        ? unpackPythonDeliveryPackage
        : unpackDeliveryPackage)(item, directory, item.digest);
  // Raw signing evidence comes from the trusted runtime, never a request body.
  const fundSignedReceipts = localClassicSpark && !options.ingress
    ? createFundSignedReceipts({ store, project: PROJECT, root, env }) : undefined;
  const fundSignedExecutionFor = item => {
    const source = item.manifest?.source;
    if (source?.fundSignedExecution !== undefined)
      return fundSignedReceipts?.read(source.runId) ?? options.fundSignedExecutionFor?.(item.digest);
  };
  const fundRehearsalRecovery = fundSignedReceipts && createFundRehearsalRecovery({
    store, project: PROJECT, root, evidenceFor: fundSignedExecutionFor, assertSource: assertRequirementSource,
  });
  if (fundRehearsalRecovery)
    for (const item of store.list("agent_delivery_task", PROJECT)) fundRehearsalRecovery.recover(item);
  const createAgentBundle = ({ agent, run, revision }) => {
    const evidence = isFundContext(agent.contextId) ? fundSignedReceipts?.read(run.id) : undefined;
    const bundle = createDeliveryPackage({ agent, run, revision, ...syncDeliveryInputs(run, revision),
      ...(evidence ? {} : { name: "客户资产 T+1 · Agent交付准备" }) });
    return evidence ? bindFundSignedDelivery(bundle, bundle.digest, evidence) : bundle;
  };
  const localFileReviewFor = (bundle, verification, actorId) => {
    const reviews = store.list("delivery_review", PROJECT).filter(review =>
      review.packageId === bundle.id && review.packageDigest === bundle.digest &&
      review.verificationId === verification.id && review.reviewer?.id === actorId &&
      review.status === "REVIEWED" && review.scope === "LOCAL_FILE_REVIEW");
    if (!bundle.manifest.source.fundSignedExecution) return reviews[0];
    const digest = hash(JSON.stringify(verification));
    return reviews.find(review => review.fundRehearsalDigest === digest) ?? reviews[0];
  };
  const releaseRunner =
    options.releaseRunner ??
    (async (input) => {
      const manifest = JSON.parse(
        await readFile(join(input.directory, "manifest.json"), "utf8"),
      );
      return manifest.format === "shuduo-python-delivery/v1"
        ? verifyPythonDeliveryDirectory(input, {
            pythonRuntime,
            pythonRunner,
          })
        : verifyDeliveryDirectory(input, { runtime, runner,
            fundSignedExecution: fundSignedExecutionFor({manifest,digest:input.expectedDigest}) });
    });
  const schedulerOptions = {
    store,
    project: PROJECT,
    packageFor: (id) => store.get("delivery_package", id, PROJECT),
    runPackage: releaseRunner,
    fundExecutionEvidenceMode: options.releaseRunner || options.runner ? "TEST_HARNESS" : "LOCAL_SPARK_PROCESS",
    assertRunSource: ({run,release,packageItem})=>{
      if (packageItem.manifest?.source?.syncInput || release.syncInput) {
        packageItem = get("delivery_package", packageItem.id);
        const plan = validateAnyDeliveryPackage(packageItem);
        if (!plan.source.syncInput) throw fail(409, "发布包失去原同步快照");
        const approval = get("release_approval", release.approvalId);
        assertSyncSqlBatch({ bundle: packageItem, plan, approval, release: get("release", release.id),
          run: get("release_run", run.id), batches: store.list("release_run", PROJECT).filter(batch => batch.releaseId === release.id),
          verification: get("delivery_verification", approval.rehearsalId), review: get("delivery_review", approval.reviewId),
          enabled: syncSqlLocal && releaseSchedulerMode === "LOCAL_TIMER", timeUnitMs: releaseTimeUnitMs });
        return;
      }
      if (isFundContext(packageItem.manifest?.source?.contextId)) {
        if (packageItem.manifest.source.fundSignedExecution) {
          const currentRelease = get("release", release.id);
          const currentRun = get("release_run", run.id);
          if (currentRelease.status !== "ACTIVE_LOCAL" || currentRelease.approvalId !== release.approvalId ||
              currentRelease.packageId !== release.packageId || currentRelease.packageDigest !== release.packageDigest ||
              currentRun.status !== "RUNNING" || currentRun.releaseId !== release.id ||
              currentRun.packageId !== run.packageId || currentRun.packageDigest !== run.packageDigest ||
              currentRun.sequence !== run.sequence || currentRun.scheduledTriggerAt !== run.scheduledTriggerAt)
            throw fail(409, "基金签名批次的批准或调度依据已变化");
          release = currentRelease;
          run = currentRun;
          packageItem = get("delivery_package", currentRun.packageId);
          if (packageItem.digest !== currentRun.packageDigest)
            throw fail(409, "基金签名批次的交付摘要已变化");
        }
        if (packageItem.manifest.source.attribution?.kind === fundAgentAttributionKind) validateAnyDeliveryPackage(packageItem);
        const approval = get("release_approval", release.approvalId);
        assertFundBatch({ bundle: packageItem, approval, release, run,
          verification: get("delivery_verification", approval.rehearsalId), review: get("delivery_review", approval.reviewId),
          batches: store.list("release_run", PROJECT).filter(batch => batch.releaseId === release.id),
          localClassicSpark, schedulerMode: releaseSchedulerMode, timeUnitMs: releaseTimeUnitMs,
          fundSignedExecution:fundSignedExecutionFor(packageItem) });
        return;
      }
      if(!packageItem.manifest?.source?.outputContract)return;
      validateAnyDeliveryPackage(packageItem);
      const approval=get('release_approval',release.approvalId);
      assertDistributionRelease({bundle:packageItem,verification:get('delivery_verification',approval.rehearsalId),review:get('delivery_review',approval.reviewId),approval,spec:release.scheduleSpec,local,schedulerMode:releaseSchedulerMode});
      if(!Number.isSafeInteger(run.sequence)||run.sequence<1||run.sequence>2||JSON.stringify(release.outputContract)!==JSON.stringify(packageItem.manifest.source.outputContract))throw fail(409,'分布批次超出已批准的冻结范围');
    },
    assertRunResult: ({packageItem, result, run}) => {
      if (!packageItem.manifest?.source?.syncInput ||
          result.status !== "SUCCEEDED" && result.errorCode !== syncSqlOutputSchemaCode) return;
      const plan = validateAnyDeliveryPackage(packageItem);
      const checked = result.status === "SUCCEEDED" ? checkedSyncSqlFileRehearsal(plan, packageItem, result) : result;
      if (checked.errorCode === syncSqlOutputSchemaCode) {
        const details = boundSyncSqlFileColumns(plan, packageItem, checked, run.businessScheduledFor);
        if (checked.status !== "FAILED" || checked.mode !== "LOCAL_FILE_REHEARSAL" ||
            checked.published !== false || checked.schedulerTriggered !== false || !details || details.status === "MATCHED")
          throw fail(409, "结构失败回执与原调度文件或业务日未核对一致");
      }
      return checked;
    },
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    persist: async () => {
      if (typeof persistence.flush === "function") await persistence.flush();
    },
  };
  const schedulerTickConfig = schedulerTickConfigFromEnvironment({
    ...env,
    V2_RELEASE_SCHEDULER_MODE: releaseSchedulerMode,
  });
  const releaseScheduler =
    releaseSchedulerMode === "LOCAL_TIMER"
      ? new LocalReleaseScheduler(schedulerOptions)
      : new DurableReleaseScheduler({
          ...schedulerOptions,
          refresh: async () => {
            if (typeof persistence.refresh === "function")
              await persistence.refresh();
          },
          leaseMs: schedulerTickConfig?.leaseMs ?? 300_000,
        });
  releaseScheduler.start();
  const expose = (item) => publicRelease(item, root);
  const exposeValidationRecord = item => item && Object.hasOwn(item, "validation")
    ? { ...item, validation: validationWithoutRawComparisons(item.validation) } : item;
  const ensureDeliveryArtifact = async (item) => {
    const value = deliveryArtifactValue(item);
    if (item.artifact) {
      await artifactStore.verify(
        item.artifact,
        "delivery-package",
        item.digest,
        value,
      );
      return item.artifact;
    }
    const artifact = await artifactStore.put(
      "delivery-package",
      item.digest,
      value,
    );
    store.update("delivery_package", item.id, PROJECT, { artifact });
    return artifact;
  };
  const preparePythonAgentDelivery = async (agent, req, res) => {
    const finalAttempt = agent.attempts?.at(-1);
    if (agent.status !== "SUCCEEDED" || finalAttempt?.status !== "SUCCEEDED")
      throw fail(409, "只有Python Agent与独立断言通过后才能准备交付");
    const codeJourney = agentEvidenceJourney({
      store,
      project: PROJECT,
      task: agent,
    });
    if (
      codeJourney.stages.find((item) => item.id === "CODE")?.status !==
        "SUCCEEDED" ||
      codeJourney.stages.find((item) => item.id === "DEBUG")?.status !==
        "SUCCEEDED"
    )
      throw fail(409, "缺少真实模型和CPython独立结果证据，不能准备交付");
    if (!options.pythonDeliveryRunner && !options.pythonRunner && !pythonRuntime.available)
      throw fail(503, "受限Python按文件演练尚未就绪");
    const run = get("python_run", finalAttempt.runId),
      rev = get("python_revision", finalAttempt.revisionId);
    createPythonDeliveryPackage({ run, revision: rev });
    const existing = store
      .list("agent_delivery_task", PROJECT)
      .find(
        (item) =>
          item.sourceAgentTaskId === agent.id &&
          ["QUEUED", "RUNNING", "SUCCEEDED"].includes(item.status),
      );
    if (existing) return json(res, 200, existing);
    const key = text(req.headers["idempotency-key"], 1, 100),
      dedup = store.deduplicate(
        `${PROJECT}:python-agent-delivery:${agent.id}:${key}`,
        hash(
          JSON.stringify({
            agentTaskId: agent.id,
            runId: run.id,
            revisionHash: rev.codeHash,
          }),
        ),
        () =>
          store.create("agent_delivery_task", PROJECT, {
            sourceAgentTaskId: agent.id,
            sourceRunId: run.id,
            sourceRevisionId: rev.id,
            sourceCodeHash: rev.codeHash,
            sourceLanguage: "PYTHON",
            status: "QUEUED",
            stage: "QUEUED",
            mode: "VERIFIED_PYTHON_ARTIFACT_ORCHESTRATION",
            completionScope: "PYTHON_DELIVERY_PREPARATION",
            fullLifecycleE2E: false,
            agentIndependentE2E: false,
            publicDeployed: false,
          }),
      ),
      task = get("agent_delivery_task", dedup.id);
    if (!dedup.replayed)
      schedule("agent_delivery_task", task, async (signal) => {
        if (signal.aborted) throw new Error("Python交付准备已取消");
        const sourceRun = get("python_run", task.sourceRunId),
          sourceRevision = get("python_revision", task.sourceRevisionId);
        let packageItem = store
          .list("delivery_package", PROJECT)
          .find(
            (item) =>
              item.sourceRunId === sourceRun.id &&
              item.manifest?.source?.revisionId === sourceRevision.id &&
              item.manifest?.format === "shuduo-python-delivery/v1" &&
              item.published !== true,
          );
        if (packageItem) {
          await ensureDeliveryArtifact(packageItem);
          packageItem = get("delivery_package", packageItem.id);
          validatePythonDeliveryPackage(packageItem, packageItem.digest);
        } else {
          const bundle = createPythonDeliveryPackage({
              run: sourceRun,
              revision: sourceRevision,
              name: "客户资产 T+1 · Python Agent交付准备",
            }),
            artifact = await artifactStore.put(
              "delivery-package",
              bundle.digest,
              bundle,
            );
          if (signal.aborted) throw new Error("Python交付准备已取消");
          packageItem = store.create("delivery_package", PROJECT, {
            ...bundle,
            artifact,
            sourceRunId: sourceRun.id,
            sourceLanguage: "PYTHON",
            agentDeliveryTaskId: task.id,
            stage: "M2A_PYTHON",
            published: false,
            releaseEligible: true,
            publicReleaseEligible: false,
          });
        }
        store.update("agent_delivery_task", task.id, PROJECT, {
          stage: "PACKAGE_READY",
          packageId: packageItem.id,
          packageDigest: packageItem.digest,
        });
        const plan = validatePythonDeliveryPackage(
            packageItem,
            packageItem.digest,
          ),
          scheduledFor = "2026-09-11T09:00:00+08:00",
          occurrence = resolveDeliverySchedule(plan, scheduledFor);
        if (
          !occurrence.eligible ||
          occurrence.businessDate !== plan.fixtures.context.businessDate
        )
          throw new Error("冻结交易日和Python交付输入不匹配");
        const verification = store.create("delivery_verification", PROJECT, {
          packageId: packageItem.id,
          packageDigest: packageItem.digest,
          scheduledFor,
          agentDeliveryTaskId: task.id,
          status: "RUNNING",
          scope: "M2A_LOCAL_PYTHON_FILE_REHEARSAL",
          published: false,
          publicDeployed: false,
          fullLifecycleE2E: false,
        });
        store.update("agent_delivery_task", task.id, PROJECT, {
          stage: "FILE_REHEARSAL_RUNNING",
          verificationId: verification.id,
        });
        try {
          const parent = join(root, ".v2-artifacts", "agent-deliveries"),
            directory = join(parent, task.id);
          mkdirSync(parent, { recursive: true });
          unpackPythonDeliveryPackage(
            packageItem,
            directory,
            packageItem.digest,
          );
          const executeFiles =
              options.pythonDeliveryRunner ??
              ((input) =>
                verifyPythonDeliveryDirectory(input, {
                  pythonRuntime,
                  pythonRunner,
                })),
            receipt = await executeFiles({
              directory,
              expectedDigest: packageItem.digest,
              scheduledFor,
              signal,
            });
          if (
            signal.aborted ||
            get("agent_delivery_task", task.id).status === "CANCELLED"
          ) {
            store.update("delivery_verification", verification.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            return;
          }
          const actual =
            receipt.status === "SUCCEEDED" &&
            receipt.engine === "CPython" &&
            receipt.engineVersion === plan.deployment.runtime.version &&
            receipt.codeExecuted === true &&
            receipt.codeHash === hash(packageItem.files["main.py"]) &&
            receipt.validation?.passed === true &&
            receipt.testDouble !== true;
          store.update("delivery_verification", verification.id, PROJECT, {
            ...receipt,
            status: actual ? "SUCCEEDED" : "FAILED",
            published: false,
            publicDeployed: false,
            fullLifecycleE2E: false,
            finishedAt: new Date().toISOString(),
          });
          if (!actual)
            throw new Error("按文件演练未形成真实CPython与独立断言证据");
          store.update("agent_delivery_task", task.id, PROJECT, {
            status: "SUCCEEDED",
            stage: "AWAITING_ENGINEER_REVIEW",
            actualExecution: true,
            verificationId: verification.id,
            finishedAt: new Date().toISOString(),
            notice:
              "已生成不可变Python调度/部署文件并完成本机受限CPython演练；云隔离、审批和发布仍待后续阶段。",
          });
        } catch (error) {
          if (
            get("delivery_verification", verification.id).status === "RUNNING"
          )
            store.update("delivery_verification", verification.id, PROJECT, {
              status: signal.aborted ? "CANCELLED" : "FAILED",
              errorCode: error.code ?? "PYTHON_FILE_REHEARSAL_FAILED",
              finishedAt: new Date().toISOString(),
            });
          throw new Error("Python交付文件演练失败，已保存运行编号供检查");
        }
      });
    return json(res, 202, publicAgentIntent(task));
  };
  const fundSourceFor = run => {
    const release = run?.releaseId && store.get("release", run.releaseId, PROJECT);
    const bundle = run?.packageId && store.get("delivery_package", run.packageId, PROJECT);
    if (!release?.fundLookthrough && !isFundContext(bundle?.manifest?.source?.contextId) &&
        !isFundContext(run?.source?.contextId)) return undefined;
    if (!localClassicSpark) throw fail(422, "基金组合穿透只支持本机数据服务");
    return resolveFundConsumptionSource({ store, project: PROJECT, fundSignedExecutionFor,
      selection: { batchId: run.id, releaseId: run.releaseId, packageDigest: run.packageDigest }, timeUnitMs: releaseTimeUnitMs });
  };
  const certifySyncService = run => certifiedSyncSqlSource({ store, project: PROJECT, run, enabled: syncSqlLocal, timeUnitMs: releaseTimeUnitMs });
  const dataServices = new DataServiceManager({
    store,
    businessStore,
    project: PROJECT,
    releaseRunFor: id => typeof id === "string" ? store.get("release_run", id, PROJECT) : undefined,
    syncSourceFor: certifySyncService,
    fundSourceFor,
    distributionSourceFor: run=>{const proof=certifiedDistributionSource({store,project:PROJECT,run});if(proof&&!local)throw fail(422,"分布消费仅本机已核验来源");return proof;},
    now: options.now,
    executeDapi: options.dataServiceExecutor,
  });
  let serviceAgentEvents;
  const savedServiceEvidenceEnabled = privateSmokeEnabled && options.ingress?.status.publicReadOnly === true;
  const privateServiceRoutes = privateDataServicesEnabled || savedServiceEvidenceEnabled ? createPrivateDataServices({ store, businessStore, project: PROJECT, auth, now: options.now, origin: env.V2_PUBLIC_ORIGIN, bootId: privateRuntimeBootId, pilotConfig: serviceAccess, persist: persistDevelopment,
    agentConfig:serviceAgentAccess,planner:input=>servicePlanner(input),assertModelBudget:reservation=>budget.assertCanStartServiceModel(reservation),budgetOverview:()=>budget.overview(),modelLeaseMs:options.serviceAgentModelLeaseMs,
    waitForModel:serviceAgentAccess?start=>statefulRequests.waitForProvider(start):undefined,
    backgroundView:task=>serviceAgentEvents?.status(task.id),
    dispatchPlan:serviceAgentAccess?.driver==='OSS_EVENTS'?(...args)=>serviceAgentEvents.advance(...args):undefined,
    cancelPlan:serviceAgentAccess?.driver==='OSS_EVENTS'?(...args)=>serviceAgentEvents.cancel(...args):undefined }) : undefined;
  const privateServices = privateDataServicesEnabled ? privateServiceRoutes : undefined;
  if(serviceAgentAccess?.driver==='OSS_EVENTS'){
    if(agentEventDriver)throw Error('PRIVATE_SERVICE_AGENT_DRIVER_CONFLICT');
    const eventConfig=agentEventConfigFromEnvironment({...env,V2_AGENT_DRIVER_MODE:'OSS_EVENTS'});
    const transport=options.agentWakeTransport??(()=>{
      const oss=ossConfigFromEnvironment(env);
      return createAgentWakeOssTransport({...oss,credentialsProvider:async()=>ossConfigFromEnvironment(env).credentials,wakePrefix:eventConfig.wakePrefix,resultPrefix:eventConfig.resultPrefix});
    })();
    serviceAgentEvents=createServiceAgentEvents({store,project:PROJECT,engine:privateServices.agentPlanner,profile:serviceAgentAccess,transport,config:eventConfig,persist:persistDevelopment,now:options.now??Date.now});
  }
  const sourceBoundServicePlansEnabled=local&&!privateDataServicesEnabled&&!serviceAccess&&!publicationAccess&&!developmentAccess;
  const servicePlanActor=req=>auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer';
  const boundServiceContext=(binding,actorId)=>{
    if(!sourceBoundServicePlansEnabled)throw Object.assign(fail(403,'此环境未开放同源Agent服务规划'),{code:'SOURCE_BOUND_SERVICE_PLANS_DISABLED'});
    return resolveServicePlanSource({store,project:PROJECT,binding,actorId,services:dataServices.list()});
  };
  const ownedServicePlan=(plan,req)=>{
    if(!plan.sourceBinding)return plan;
    if(!sourceBoundServicePlansEnabled)throw Object.assign(fail(403,'此环境未开放同源Agent服务规划'),{code:'SOURCE_BOUND_SERVICE_PLANS_DISABLED'});
    if(plan.projectId!==PROJECT||plan.scope!=='LOCAL_TEST_ONLY'||plan.submittedBy!==servicePlanActor(req))throw Object.assign(fail(403,'规划任务仅属于原创建者'),{code:'SERVICE_PLAN_ACCESS_DENIED'});
    servicePlanSourceBinding(plan.sourceBinding);
    if(plan.proposal&&hash(JSON.stringify(plan.proposal))!==plan.proposalHash)throw Object.assign(fail(409,'原规划方案摘要不一致'),{code:'SERVICE_PLAN_CHANGED'});
    return plan;
  };
  const checkedServicePlan=(plan,req)=>{
    ownedServicePlan(plan,req);if(!plan.sourceBinding)return plan;
    boundServiceContext(plan.sourceBinding,plan.submittedBy);
    assertServicePlanVersions({store,project:PROJECT,binding:plan.sourceBinding,refs:plan.selectedVersions??plan.resourceVersions});
    return plan;
  };
  const readableServicePlan=(plan,req)=>{
    ownedServicePlan(plan,req);if(!plan.sourceBinding)return publicServicePlan(plan);
    try{checkedServicePlan(plan,req);return publicServicePlan({...plan,sourceCheck:'VERIFIED'});}
    catch(error){if(![403,404,409,422].includes(error.status))throw error;
      return publicServicePlan({...plan,sourceCheck:'UNAVAILABLE',sourceCheckCode:/^[A-Z0-9_]{1,80}$/.test(error.code??'')?error.code:'SERVICE_PLAN_SOURCE_UNAVAILABLE'});}
  };
  const servicePlanner =
    options.servicePlanner ??
    (async (input) => {
      if(input.modelBudgetReservation)budget.assertCanStartServiceModel(input.modelBudgetReservation);else budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateDataServicePlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const serverMysqlAdapter =
    options.serverMysqlAdapter ?? createServerMysqlSourceAdapter(env);
  const ingestion = new IngestionManager({
    store,
    landingStore,
    project: PROJECT,
    fixtureRoot:
      options.fixtureRoot ?? join(process.cwd(), "fixtures", "sources"),
    serverMysqlAdapter,
    now: options.now,
  });
  const ingestionPlanner =
    options.ingestionPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateIngestionPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const realtime = new RealtimeManager({
    store,
    stateStore: streamStateStore,
    project: PROJECT,
    fixtureRoot:
      options.streamFixtureRoot ?? join(process.cwd(), "fixtures", "streams"),
    now: options.now,
    eventDelayMs: options.realtimeEventDelayMs ?? 40,
  });
  const realtimePlanner =
    options.realtimePlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateRealtimePlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const assets = new AssetCatalogManager({
    allowLocalPublishedEvidence:local,
    store,
    landingStore,
    stateStore: streamStateStore,
    dataServices,
    project: PROJECT,
    now: options.now,
  });
  const syncSqlResources = { assets, landingStore, store, project: PROJECT };
  const dataContracts = new DataContractManager({
    store,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const serviceContractGates=createServiceContractGates({store,project:PROJECT,contracts:dataContracts,businessStore,now:options.now});
  dataServices.contractGate=serviceContractGates;
  if(privateServiceRoutes)privateServiceRoutes.manager.contractGate=serviceContractGates;
  const annotationRequests = createAssetAnnotationRequests({ store, assets, project: PROJECT });
  const assetPlanner =
    options.assetPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateAssetInsight(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const quality = new QualityManager({
    store,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const qualityPlanner =
    options.qualityPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateQualityPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const security = new SecurityManager({
    store,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const securityPlanner =
    options.securityPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateSecurityPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const resolveLocalReportSource = (source, actorId) => resolvePublishedReportSource({
    store, project: PROJECT, source, actorId, allowFund: localClassicSpark, allowSync: syncSqlLocal, timeUnitMs: releaseTimeUnitMs, fundSignedExecutionFor,
  });
  const reports = new ReportManager({
    allowLocalPublishedEvidence:local,
    store,
    reportStore,
    assets,
    project: PROJECT,
    resolvePublishedSource: resolveLocalReportSource,
    now: options.now,
  });
  const reportProvenance=createReportProvenance({store,project:PROJECT,reportStore});
  const privateBatchArchives = privateDataServicesEnabled
    ? createPrivateBatchArchive({store, businessStore, project:PROJECT, now:options.now}) : undefined;
  const readSyncCalls = evidence => readSyncSqlCallEvidence({store,project:PROJECT,manager:dataServices,evidence});
  const publishedReports=createPublishedReportWorkflow({store,project:PROJECT,reports,reportStore,provenance:reportProvenance,
    resolveSource:resolveLocalReportSource,fundSignedExecutionFor,readSyncCalls,afterStep:options.publishedReportAfterStep});
  const reportActor=req=>auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer';
  const publishedPlanContext=(source,actor)=>{
    if(!local)throw fail(403,'同源报表规划尚只在本机开发边界开放');
    return publishedReportPlanningContext(resolveLocalReportSource(source,actor));
  };
  const canReadReportPlan = (plan, req) => local
    ? !plan.sourceBinding || plan.submittedBy === reportActor(req)
    : plan.contextScope === "INVITED_PROJECT_REPORTS" && !plan.sourceBinding && plan.submittedBy === reportActor(req);
  const requireReportPlanOwner = (plan, req) => {
    if (!canReadReportPlan(plan, req)) throw fail(404, "未找到本账号的报表方案");
  };
  const publicReportPlan=plan=>{const{submittedBy,executionBootId,...visible}=sourceReportProjection(plan,{bootId:privateRuntimeBootId,active:controls.has(plan.id),now:options.now?.()??Date.now()});if(plan.sourceBinding){try{assertReportClarificationPlan(plan,{store,project:PROJECT,contextFor:publishedPlanContext});visible.requestBasisState='VERIFIED';}catch{visible.requestBasisState='UNCONFIRMED';}}return visible;};
  const sourceReportKey=value=>{const key=text(value,1,100);if(!/^[A-Za-z0-9_-]+$/.test(key))throw fail(422,'原报表规划请求编号不合法');return key;};
  const reportPlanner =
    options.reportPlanner ??
    (async (input) => {
      if(input.sourceReservation)budget.assertCanStartReportModel(input.sourceReservation);else budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateReportPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const operations = new OperationsManager({
    store,
    project: PROJECT,
    now: options.now,
  });
  const opsPlanner =
    options.opsPlanner ??
    (async (input) => {
      budget.assertCanStartModel();
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateOpsDiagnosis(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const revision = (sql, contextId, source, author = "local-engineer", syncInput) =>
    store.create("revision", PROJECT, {
      sql,
      contextId,
      source,
      hash: hash(sql),
      author,
      ...(syncInput ? { syncInput } : {}),
    });
  const pythonRevision = (code, contextId, source, author = "local-engineer") =>
    store.create("python_revision", PROJECT, {
      language: "PYTHON",
      code,
      codeHash: hash(code),
      contextId,
      source,
      author,
      executionScope: "LOCAL_RESTRICTED_PYTHON",
      publicDeployed: false,
    });
  const schedule = (kind, item, work) => {
    const controller = new AbortController();
    controls.set(item.id, controller);
    queue = queue
      .then(async () => {
        const queued=get(kind,item.id);
        if(kind==='report_agent_plan'&&queued.sourceBinding&&!sourceReportMayStart(queued,privateRuntimeBootId)){controls.delete(item.id);return;}
        if (get(kind, item.id).status === "CANCELLED") {
          controls.delete(item.id);
          return;
        }
        store.update(kind, item.id, PROJECT, {
          status: "RUNNING",
          startedAt: new Date().toISOString(),
        },kind==='report_agent_plan'&&queued.sourceBinding?{expectedVersion:queued.version}:undefined);
        try {
          await work(controller.signal);
        } catch (error) {
          const current = get(kind, item.id);
          const sourceReport=kind==='report_agent_plan'&&current.sourceBinding;
          if (current.status !== "CANCELLED"&&(!sourceReport||current.executionBootId===privateRuntimeBootId))
            store.update(kind, item.id, PROJECT, {
              status: controller.signal.aborted ? "CANCELLED" : "FAILED",
              error: error.message,
              finishedAt: new Date().toISOString(),
            },sourceReport?{expectedVersion:current.version}:undefined);
        } finally {
          controls.delete(item.id);
        }
      })
      .catch(() => {
        controls.delete(item.id);
      });
  };
  const scheduleSourceReport=task=>schedule('report_agent_plan',task,signal=>runSourceReportPlan({store,project:PROJECT,id:task.id,bootId:privateRuntimeBootId,signal,contextFor:publishedPlanContext,planner:reportPlanner,budget,hash:publishedReportHash,planHash:publishedReportPlanHash,validate:validatePublishedReportPlan,now:options.now??Date.now,timeoutMs:options.reportPlanningTimeoutMs??60000}));
  const execute = async (run, rev, signal) => {
    const family=validationFamily(rev.contextId);
    const contractId = rev.syncInput ? syncSqlContractId : family.id;
    if(run.validationContractId!==contractId || JSON.stringify(run.syncInput) !== JSON.stringify(rev.syncInput))
      throw fail(409,"运行与代码业务口径验证契约不一致");
    const context = rev.syncInput
      ? readSyncSqlInput({ ...syncSqlResources, actorId: rev.author, binding: rev.syncInput })
      : getContext(rev.contextId);
    const output = await runner({
      sql: rev.sql,
      context,
      validationContexts: validationContextsFor(rev.contextId),
      signal,
      timeoutMs: Number(env.V2_RUN_TIMEOUT_MS ?? 90000),
    });
    const { directory, ...result } = output;
    if (!["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"].includes(result.status))
      throw new Error("执行器返回了无效状态");
    if (
      result.status === "CANCELLED" &&
      !["REMOTE_SPARK_CANCELLED", "REMOTE_SPARK_TIMEOUT"].includes(result.code)
    )
      throw new Error("执行器取消状态缺少可信原因");
    if (result.status === "SUCCEEDED" && !result.validation?.passed)
      throw new Error("缺少独立断言，不能标记成功");
    if (!options.runner && result.status === "SUCCEEDED") {
      const checks = result.validation?.regressions ?? [];
      if (
        checks.length !== family.contextIds.length ||
        !family.contextIds.every((id) =>
          checks.some((c) => c.contextId === id && c.passed),
        )
      )
        throw new Error("缺少完整回归场景证据，不能标记成功");
    }
    if (result.validation)
      result.validation = {
        ...result.validation,
        contractId,
        ...(rev.syncInput ? { scope: "SELECTED_SYNC_SNAPSHOT_AND_REGISTERED_FIXTURES" } : {}),
      };
    if (rev.syncInput && result.status === "SUCCEEDED" && !syncSqlColumnsMatch(result.columns)) {
      result.status = "VALIDATION_FAILED";
      result.code = syncSqlOutputSchemaCode;
      result.error = syncSqlOutputSchemaMessage;
      result.validation.passed = false;
    }
    if (run.fundPreparation && result.status === "SUCCEEDED" && !verifiedFundRun({ ...result, contextId: rev.contextId }, rev.contextId))
      throw fail(409, "基金运行未返回登记交易日及独立断言的完整证据");
    if (signal.aborted)
      return store.update("run", run.id, PROJECT, {
        status: "CANCELLED",
        finishedAt: new Date().toISOString(),
      });
    if (get("run", run.id).status === "CANCELLED") return get("run", run.id);
    return store.update("run", run.id, PROJECT, {
      ...result,
      finishedAt: new Date().toISOString(),
    });
  };
  const readJsonBody = async (req) => {
    if (!String(req.headers["content-type"]).startsWith("application/json"))
      throw fail(415, "使用 JSON 提交");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 100000) throw fail(413, "请求内容过大");
    }
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      throw fail(400, "JSON 格式不合法");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw fail(400, "请求必须是 JSON 对象");
    return { raw: body, parsed };
  };
  const readBody = async (req) => (await readJsonBody(req)).parsed;
  const readPrivateSmokeBody = async (req) => {
    const binaryPayload = String(req.headers["content-type"]).startsWith("application/octet-stream");
    if (!binaryPayload && !((privatePublicationConfig || agentEventDriver || serviceAgentEvents) && String(req.headers["content-type"]).startsWith("application/json")))
      throw fail(415, "私有函数验收仅接受二进制事件载荷");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 100000) throw fail(413, "私有函数验收载荷过大");
    }
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      throw fail(400, "私有函数验收载荷不是JSON");
    }
    if ((agentEventDriver||serviceAgentEvents) && parsed && Array.isArray(parsed.events)) return {operation:"PRIVATE_AGENT_OBJECT_EVENT_V1",event:parsed};
    if (parsed && typeof parsed === "object" && ("triggerName" in parsed || "payload" in parsed))
      return { operation: "PRIVATE_RELEASE_TIMER_V1", ...validatePrivateReleaseTimer(parsed, privatePublicationConfig, options.now?.() ?? Date.now()) };
    if (!binaryPayload) throw fail(415, "普通私有调用只接受二进制载荷");
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !["PRIVATE_STATUS_V1", "PRIVATE_APPLICATION_HTTP_V1", "PRIVATE_APPLICATION_TASK_V1", "PRIVATE_AGENT_TICK_V1", "PRIVATE_AGENT_RECOVERY_V1"].includes(parsed.operation) ||
      (parsed.operation === "PRIVATE_STATUS_V1" && Object.keys(parsed).length !== 1)
    )
      throw fail(422, "私有函数验收操作不受支持");
    return parsed;
  };
  const callAtomicApi = async (req, path, body, idempotencyKey) => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw Object.assign(fail(503, "专业Agent原子接口尚未就绪"), {
        code: "AGENT_ATOMIC_API_UNAVAILABLE",
      });
    const headers = {
      ...options.ingress?.internalHeaders,
      "Content-Type": "application/json",
      "X-Shuduo-Client": req.headers["x-shuduo-client"],
      "Idempotency-Key": idempotencyKey,
      ...(req.headers.cookie ? { Cookie: req.headers.cookie } : {}),
      ...(req.headers["x-csrf-token"]
        ? { "X-CSRF-Token": req.headers["x-csrf-token"] }
        : {}),
      ...(req.headers["x-project-id"]
        ? { "X-Project-Id": req.headers["x-project-id"] }
        : {}),
    };
    let response;
    try {
      response = await fetch(
        `http://127.0.0.1:${address.port}/api/v2${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw Object.assign(fail(503, "专业Agent原子接口暂时不可用"), {
        code: "AGENT_ATOMIC_API_UNAVAILABLE",
      });
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw Object.assign(fail(502, "专业Agent原子接口响应无法解析"), {
        code: "AGENT_ATOMIC_API_INVALID_RESPONSE",
      });
    }
    if (!response.ok)
      throw Object.assign(
        fail(response.status, value?.message ?? "专业Agent原子接口调用失败"),
        ...(typeof value?.code === "string" ? [{ code: value.code }] : []),
      );
    return { status: response.status, body: value };
  };
  const statefulRequests = createRequestLane();
  const fixtureContexts = () =>
    localClassicSpark ? classicContextIds.map(publicContext) : publicV2Contexts();
  const prefetchedPrivateInputs=new WeakMap();
  const handleRequest = async (req, res) => {
    try {
      const ingressChannel = options.ingress?.assertRequest(req);
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname,
        method = req.method,
        publicReadOnly = options.ingress?.status.publicReadOnly === true && ingressChannel === "HTTP",
        isPrivateSmokeInvoke = method === "POST" && path === "/invoke";
      let deliveryAccess;
      const deliveryAccessForRequest = () => deliveryAccess ??= createDeliveryEvidenceAccess({
        store, project:PROJECT, local, session:auth.sessionFromHeaders(req.headers),
      });
      const canReadDelivery = (kind, item) => {
        const release = ["monitor_alert", "monitor_event"].includes(kind) && item?.releaseId
          ? store.get("release", item.releaseId, PROJECT) : undefined;
        const packageId = release?.packageId ?? item?.packageId;
        const pack = kind === "delivery_package" ? item : packageId && store.get("delivery_package", packageId, PROJECT);
        const source = pack?.manifest?.source;
        if (source?.syncInput && (!syncSqlLocal || !isLoopbackRequest(req) ||
            source.syncInput.actorId !== (auth.sessionFromHeaders(req.headers)?.user.id ?? "local-engineer"))) return false;
        if (isFundContext(source?.contextId)) {
          if (!localClassicSpark) return false;
          if (source.attribution?.kind === fundAgentAttributionKind) {
            const actorId = auth.sessionFromHeaders(req.headers)?.user.id ?? "local-engineer";
            if (options.ingress || !isLoopbackRequest(req) || source.attribution.actorId !== actorId) return false;
          }
        }
        return deliveryAccessForRequest().canRead(kind, item);
      };
      const visibleDelivery = kind => store.list(kind, PROJECT).filter(item => canReadDelivery(kind, item));
      const deliveryDenied = () => Object.assign(fail(403, "当前身份无权访问此交付证据"), {code:"DELIVERY_EVIDENCE_ACCESS_DENIED"});
      const requireDeliveryEvidence = (kind, item) => {
        if (!canReadDelivery(kind, item)) throw deliveryDenied();
      };
      const protectedDeliveryPayload = item => {
        if (local || !item) return item;
        const {artifact, remoteSubmission, leaseToken, ...visible} = projectCloudReleaseBatchStage(item,options.now?.()??Date.now());
        return visible;
      };
      const exposeDeliveryVerification = item => {
        const { rehearsalOutputSchema: storedSchema, ...visible } = protectedDeliveryPayload(item);
        const bundle = item.packageId && store.get("delivery_package", item.packageId, PROJECT);
        const rehearsalOutputSchema = syncSqlRehearsalSchemaDetails(bundle, item);
        return { ...exposeValidationRecord(visible), ...(rehearsalOutputSchema ? { rehearsalOutputSchema } : {}) };
      };
      const exposeReleaseRun = item => {
        const { scheduledOutputSchema: storedSchema, ...visible } = protectedDeliveryPayload(item);
        const scheduledOutputSchema = syncSqlScheduledSchemaDetails({ store, project:PROJECT, run:item,
          enabled:syncSqlLocal, timeUnitMs:releaseTimeUnitMs });
        return { ...expose(visible), ...(scheduledOutputSchema ? { scheduledOutputSchema } : {}) };
      };
      const workflowDeliveryEvidence = delivery => {
        const bundle = delivery?.packageId ? get("delivery_package", delivery.packageId) : undefined;
        const verification = delivery?.verificationId ? get("delivery_verification", delivery.verificationId) : undefined;
        if (bundle) {
          requireDeliveryEvidence("delivery_package", bundle);
          if ((!local || bundle.manifest?.source?.syncInput || bundle.manifest?.source?.attribution?.kind === fundAgentAttributionKind) && (delivery.packageDigest !== bundle.digest ||
              delivery.sourceRunId !== bundle.manifest?.source?.runId ||
              delivery.sourceRevisionId !== bundle.manifest?.source?.revisionId)) throw deliveryDenied();
          if (bundle.manifest?.source?.syncInput || bundle.manifest?.source?.attribution?.kind === fundAgentAttributionKind) validateAnyDeliveryPackage(bundle);
        }
        if (verification) {
          requireDeliveryEvidence("delivery_verification", verification);
          if (!local || bundle?.manifest?.source?.syncInput || bundle?.manifest?.source?.attribution?.kind === fundAgentAttributionKind) {
            const attached = bundle && verification.packageId === bundle.id && verification.packageDigest === bundle.digest;
            const archivedFailure = !bundle && ["FAILED","CANCELLED","INTERRUPTED"].includes(verification.status) &&
              verification.packageId === undefined && verification.packageDigest === undefined;
            if (!attached && !archivedFailure) throw deliveryDenied();
            if (attached && verification.status === "SUCCEEDED" && bundle.manifest?.source?.attribution?.kind === fundAgentAttributionKind)
              assertFundRehearsal(bundle, verification);
            if (attached && verification.status === "SUCCEEDED" && bundle.manifest.source.syncInput)
              assertSyncSqlRehearsal(validateAnyDeliveryPackage(bundle), bundle, verification);
          }
        }
        return {bundle, verification};
      };
      const selectFundPublication = (agent, selector) => {
        if (selector?.sourceKind !== "AGENT" || !selector.sourceRunId || !selector.packageDigest)
          throw fail(422, "基金发布须指定原运行、包摘要和文件演练");
        const release = selector.releaseId && store.get("release", selector.releaseId, PROJECT);
        const approval = release?.packageDigest === selector.packageDigest && store.get("release_approval", release.approvalId, PROJECT);
        const verificationId = selector.verificationId ?? approval?.rehearsalId;
        if (!verificationId) throw fail(422, "需提供文件演练或确切发布编号");
        const matches = store.list("agent_delivery_task", PROJECT).filter(delivery =>
          delivery.sourceAgentTaskId === agent.id && delivery.sourceRunId === selector.sourceRunId &&
          delivery.packageDigest === selector.packageDigest && delivery.verificationId === verificationId &&
          delivery.status === "SUCCEEDED");
        if (matches.length !== 1) throw fail(409, "未找到唯一的原基金交付及成功演练");
        const { bundle, verification } = workflowDeliveryEvidence(matches[0]);
        if (!bundle || !verification || bundle.manifest?.source?.attribution?.originAgentTaskId !== agent.id)
          throw fail(409, "基金交付与当前任务不一致");
        return { bundle, verification };
      };
      const assertFundServiceSourceAccess = (batchId) => {
        const run = typeof batchId === "string" && store.get("release_run", batchId, PROJECT);
        const bundle = typeof run?.packageId === "string" && store.get("delivery_package", run.packageId, PROJECT);
        if (bundle?.manifest?.source?.syncInput || bundle?.manifest?.source?.attribution?.kind === fundAgentAttributionKind)
          requireDeliveryEvidence("release_run", run);
      };
      const assertFundServiceInputAccess = (type, body) => {
        if (type === "DAPI") return assertFundServiceSourceAccess(body.sourceReleaseRunId);
        if (Array.isArray(body.steps) && body.steps.length <= 5) for (const step of body.steps) {
          const dapi = typeof step?.dapiId === "string" && store.get("data_service", step.dapiId, PROJECT);
          const versionId = step?.dapiVersionId ?? dapi?.publishedVersionId;
          const child = typeof versionId === "string" && store.get("data_service_version", versionId, PROJECT);
          assertFundServiceSourceAccess(child?.sourceReleaseRunId);
        }
      };
      const assertFundServiceAccess = service => {
        for (const version of [service.currentVersion, service.publishedVersion])
          if (version) assertFundServiceInputAccess(service.serviceType, version);
      };
      const canReadService = service => {
        try { assertFundServiceAccess(service); return true; }
        catch (error) { if (error.status === 403) return false; throw error; }
      };
      const visibleServices = type => dataServices.list(type).filter(canReadService);
      const syncSourcesFor = selection => syncSqlServiceSources({ store, project: PROJECT, selection,
        canRead: run => canReadDelivery("release_run", run), certify: certifySyncService });
      const canReadSyncDataset = dataset => !isSyncAssetId(dataset?.assetId) && !isSyncReportEvidence(dataset?.sourceEvidence) ||
        syncSqlLocal && isLoopbackRequest(req) && dataset.sourceActorId === reportActor(req);
      const requireSyncDataset = dataset => {
        if (!canReadSyncDataset(dataset)) throw fail(404, "未找到本账号的冻结持仓报表");
      };
      const canReadSyncReport = report => canReadSyncDataset(typeof report?.datasetId === "string" && store.get("report_dataset", report.datasetId, PROJECT));
      const deliveryReceipt = item => {
        const {verification} = workflowDeliveryEvidence(item);
        const rehearsal = storedFileRehearsal(item,verification);
        return {...publicDeliveryTask(item),...(rehearsal?{rehearsal}:{})};
      };
      assertV2RequestScope(req, { env, local });
      if (method === "GET" && !path.startsWith("/api/v2"))
        return await serveV2Static(res, root, path, req.headers["accept-encoding"]);
      // This admitted HTTP read serves built-in fixtures independent of project state.
      if (isPublicContextRead(req, ingressChannel)) return json(res, 200, fixtureContexts());
      if (typeof persistence.refresh === "function") await persistence.refresh();
      const includeSession = method === "GET" && path === "/api/v2/status" &&
        url.searchParams.size === 1 && url.searchParams.get("include") === "session";
      const startupActor = includeSession ? auth.sessionFromHeaders(req.headers) : undefined;
      const scopeActor = () => includeSession ? startupActor : auth.sessionFromHeaders(req.headers);
      const developmentSessionView = ingressChannel === "HTTP" && !publicReadOnly
        ? serviceSession(serviceAccess, scopeActor(), options.now?.() ?? Date.now()) ?? publicationSession(publicationAccess, scopeActor(), options.now?.() ?? Date.now()) ?? developmentSession(developmentAccess, scopeActor(), options.now?.() ?? Date.now()) : undefined;
      if (ingressChannel === "HTTP" && !publicReadOnly) {
        assertDevelopmentMutation(developmentAccess, scopeActor(), method, path, options.now?.() ?? Date.now());
      }
      // The rollout scope also constrains trusted internal application forwarding;
      // only the separately authenticated event envelope bypasses this API gate.
      if (!isPrivateSmokeInvoke)
        assertPublicationMutation(publicationAccess, scopeActor(), method, path, options.now?.() ?? Date.now());
      if (!isPrivateSmokeInvoke)
        assertServiceMutation(serviceAccess, scopeActor(), method, path, options.now?.() ?? Date.now());
      if(!isPrivateSmokeInvoke)assertServiceAgentMutation(serviceAgentAccess,scopeActor(),method,path);
      if (ingressChannel === "HTTP" && developmentAccess && method === "POST") {
        const taskPath = path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]{36})\//);
        const deliveryPath = path.match(/^\/api\/v2\/agent\/deliveries\/([a-f0-9-]{36})\//);
        const runPath = path.match(/^\/api\/v2\/runs\/([a-f0-9-]{36})\//);
        const session = auth.sessionFromHeaders(req.headers);
        if (taskPath) assertScopedRecord(session, store.get('agent', taskPath[1], PROJECT));
        if (deliveryPath) { const task = store.get('agent_delivery_task', deliveryPath[1], PROJECT); assertScopedRecord(session, store.get('agent', task?.sourceAgentTaskId ?? '', PROJECT)); }
        if (runPath) { const run = store.get('run', runPath[1], PROJECT); assertScopedRecord(session, store.get('revision', run?.revisionId ?? '', PROJECT)); }
      }
      if (method !== "GET" && !isPrivateSmokeInvoke && typeof persistence.flush === "function")
        res.metadataFlush = () => persistence.flush();
      if (isPrivateSmokeInvoke) {
        if (!privateSmokeEnabled) throw fail(404, "页面不存在");
        const privateInput = prefetchedPrivateInputs.get(req)??await readPrivateSmokeBody(req);prefetchedPrivateInputs.delete(req);
        if(serviceAgentAccess&&!['PRIVATE_STATUS_V1','PRIVATE_APPLICATION_HTTP_V1',...(serviceAgentEvents?['PRIVATE_AGENT_OBJECT_EVENT_V1']:[])].includes(privateInput.operation))throw Object.assign(fail(403,'服务规划窗口不接受计算、调度或其他私有操作'),{code:'PRIVATE_SERVICE_AGENT_SCOPE_DENIED'});
        if ((developmentAccess?.taskId || developmentAccess?.requestDigest) && !['PRIVATE_STATUS_V1','PRIVATE_AGENT_OBJECT_EVENT_V1'].includes(privateInput.operation))
          throw targetDenied();
        if (serviceAccess && !["PRIVATE_STATUS_V1", "PRIVATE_APPLICATION_HTTP_V1"].includes(privateInput.operation))
          throw Object.assign(fail(403, "本次仅开放既有发布结果的接口交付；计算与调度保持关闭。"), { code: "PUBLIC_SERVICE_SCOPE_DENIED" });
        // This rollout permits only the reviewed publication. Legacy private
        // acceptance and Agent drivers can mutate records before API forwarding.
        if (publicationAccess && !["PRIVATE_STATUS_V1", "PRIVATE_RELEASE_TIMER_V1", "PRIVATE_APPLICATION_HTTP_V1"].includes(privateInput.operation))
          throw Object.assign(fail(403, "本次仅允许指定交付包发布、签名调度与状态读取；其他私有任务和验收操作未开放。"), { code: "PUBLIC_PUBLICATION_SCOPE_DENIED" });
        if(privateInput.operation==="PRIVATE_AGENT_OBJECT_EVENT_V1")return json(res,200,await(serviceAgentEvents??agentEventDriver).consume(privateInput.event));
        if (privateInput.operation === "PRIVATE_RELEASE_TIMER_V1") {
          const release=store.get('release',privateInput.releaseId,PROJECT),publisher=release?.manualDeliveryTaskId?standaloneCloudPublication:cloudPublication;
          if (!publisher || !privatePublicationConfig) throw fail(503,"私有发布调度未启用");
          return json(res,200,await publisher.tick(privateInput));
        }
        if (privateInput.operation === "PRIVATE_AGENT_RECOVERY_V1")
          return json(res, 200, await privateAgentRecovery(privateInput, { store, project: PROJECT,
            engine: durableAgent, persist: persistDevelopment, bootId: privateRuntimeBootId }));
        if (privateInput.operation === "PRIVATE_AGENT_TICK_V1") {
          if(agentEventDriver)throw Object.assign(fail(403,"事件模式禁止无任务范围的后台轮询"),{code:"AGENT_UNSCOPED_TICK_DENIED"});
          if (!agentDispatcher) throw Object.assign(fail(503, "Agent 后台推进尚未启用"), { code: "AGENT_DRIVER_DISABLED" });
          if (Object.keys(privateInput).some(k => !["operation", "requestId"].includes(k))) throw fail(422, "Agent 后台推进字段不受支持");
          return json(res, 200, await agentDispatcher.tick({ requestId: privateInput.requestId }));
        }
        if (privateInput.operation !== "PRIVATE_STATUS_V1") {
          const address = server.address(), base = `http://127.0.0.1:${address.port}`;
          const result = privateInput.operation === "PRIVATE_APPLICATION_TASK_V1"
            ? await verifyPrivateApplicationTask(privateInput, { base, store, project: PROJECT, internalHeaders: options.ingress?.internalHeaders })
            : await callPrivateApplication(privateInput, base, undefined, { internalHeaders: options.ingress?.internalHeaders, allowDurableAgent: Boolean(durableAgent), allowDurableAgentRead: privateDataServicesEnabled, allowDataServices: privateDataServicesEnabled,allowServiceAgent:Boolean(serviceAgentAccess),allowStandaloneManualPublication:env.V2_DURABLE_MANUAL_DELIVERY_ENABLED==='true' });
          await persistence.flush?.();
          return json(res, 200, result);
        }
        const metadata =
            typeof store.replicationStatus === "function"
              ? store.replicationStatus()
              : undefined,
          replication =
            typeof options.stateCoordinator?.replicationStatus === "function"
              ? options.stateCoordinator.replicationStatus()
              : undefined;
        return json(res, 200, {
          protocol: "shuduo-v2-private-smoke-v1",
          ...(options.ingress ? { httpHandling: { mode: "SERIAL_STATEFUL_PARALLEL_STATIC_V1" } } : {}),
          mode: "PRIVATE_CONTROL_PLANE",
          ...(options.ingress ? { ingress: options.ingress.status } : {}),
          metadata: {
            driver: metadata?.driver ?? "unavailable",
            healthy: metadata?.healthy === true,
          },
          persistence: {
            mode: replication?.mode ?? "unavailable",
            healthy: replication?.healthy === true,
            dataState: {
              driver: replication?.dataState?.driver ?? "unavailable",
              healthy: replication?.dataState?.healthy === true,
            },
          },
          publicReady: false,
        });
      }
      const isSchedulerTick =
        method === "POST" && path === "/api/v2/internal/scheduler/tick";
      if (isSchedulerTick) {
        if (releaseSchedulerMode !== "DURABLE_TICK" || !schedulerTickConfig)
          throw Object.assign(fail(503, "持久调度入口未配置"), {
            code: "DURABLE_SCHEDULER_NOT_CONFIGURED",
          });
        const { raw, parsed } = await readJsonBody(req),
          timestamp = req.headers["x-shuduo-timestamp"],
          nonce = req.headers["x-shuduo-nonce"],
          signature = req.headers["x-shuduo-signature"],
          nowMs = options.now?.() ?? Date.now();
        if (
          !verifySchedulerTick({
            sharedSecret: schedulerTickConfig.sharedSecret,
            timestamp,
            nonce,
            body: raw,
            signature,
            now: nowMs,
            maxSkewMs: schedulerTickConfig.maxSkewMs,
          })
        )
          throw Object.assign(fail(401, "持久调度签名无效"), {
            code: "SCHEDULER_TICK_SIGNATURE_INVALID",
          });
        const guard = store.list("scheduler_tick_guard", PROJECT)[0],
          recent = (guard?.recent ?? []).filter(
            (item) => Number(item.expiresAt) > nowMs,
          );
        if (recent.some((item) => item.nonce === nonce))
          throw Object.assign(fail(409, "持久调度随机数已使用"), {
            code: "SCHEDULER_TICK_REPLAYED",
          });
        const nextGuard = {
          recent: [
            ...recent,
            { nonce, expiresAt: nowMs + schedulerTickConfig.maxSkewMs },
          ].slice(-100),
        };
        if (guard)
          store.update("scheduler_tick_guard", guard.id, PROJECT, nextGuard);
        else store.create("scheduler_tick_guard", PROJECT, nextGuard);
        if (typeof persistence.flush === "function") await persistence.flush();
        const keys = Object.keys(parsed);
        if (keys.some((key) => key !== "limit"))
          throw fail(400, "持久调度请求字段不受支持");
        return json(
          res,
          200,
          await releaseScheduler.tick({ limit: parsed.limit ?? 1 }),
        );
      }
      if (method !== "GET") {
        if (
          !["workbench", "cli", "mcp"].includes(
            req.headers["x-shuduo-client"],
          )
        )
          throw fail(403, "缺少客户端校验");
        if (local) {
          const hostname = new URL("http://" + req.headers.host).hostname;
          if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
            throw fail(403, "本地开发写入只能使用回环地址");
        } else if (
          ![
            "/api/v2/auth/login",
            "/api/v2/auth/redeem",
          ].includes(path)
        )
          auth.requireMutation(req.headers, path);
      }
      if (method === "POST" && env.V2_EXECUTION_UNAVAILABLE === "true" &&
          (budgetAgentCreationPaths.has(path)&&!(serviceAgentAccess&&path==='/api/v2/data-services/agent/plans') || path === "/api/v2/runs" || path === "/api/v2/python/runs" || path.startsWith("/api/v2/agent/")))
        throw Object.assign(fail(503, "远程执行器尚未就绪；已保存结果仍可读取"), { code: "REMOTE_SPARK_NOT_READY" });
      if (method === "POST" && budgetAgentCreationPaths.has(path)&&!(serviceAgentAccess&&path==='/api/v2/data-services/agent/plans'))
        budget.assertCanStartModel();
      const constrainAuthSession = body => {
        const planningView=serviceAgentSession(serviceAgentAccess,{user:body.user,role:body.role},store,PROJECT,options.now?.()??Date.now());
        if (publicReadOnly) return {...body,...(planningView?{servicePlanningOnly:true,servicePlanning:{enabled:false}}:{}),permissions: ["SESSION"], readOnly: true};
        if(planningView)return {...body,...planningView};
        if (ingressChannel !== "HTTP") return body;
        const identity = {user: body.user, role: body.role}, now = options.now?.() ?? Date.now();
        const constrained = {...body, ...(serviceSession(serviceAccess, identity, now) ?? publicationSession(publicationAccess, identity, now) ?? developmentSession(developmentAccess, identity, now) ?? {})};
        // The scope projection only exposes these identifiers to the selected
        // administrator. Anonymous/other accounts do not get source metadata.
        if (constrained.publicationOnly && constrained.publicationTaskId && body.user?.id) {
          const target = {agentId: constrained.publicationTaskId, packageDigest: constrained.publicationPackageDigest,
            verificationId: constrained.publicationVerificationId, actorId: body.user.id};
          constrained.publicationSource = cloudPublication?.sourceForNavigation(target) ?? {
            status: "UNAVAILABLE", taskId: target.agentId, packageDigest: target.packageDigest, verificationId: target.verificationId,
          };
        }
        if(constrained.manualPublicationOnly&&constrained.manualPublicationTaskId&&body.user?.id){
          const target={manualDeliveryTaskId:constrained.manualPublicationTaskId,packageDigest:constrained.publicationPackageDigest,verificationId:constrained.publicationVerificationId};
          try{const task=store.get('manual_delivery_task',target.manualDeliveryTaskId,PROJECT),resolved=standaloneManualPublicationSource({store,project:PROJECT,...target,sourceRunId:task?.sourceRunId,actorId:body.user.id});constrained.manualPublicationSource={status:'RESOLVED',kind:'MANUAL_RUN',...target,runId:resolved.run.id,revisionId:resolved.revision.id,revisionHash:resolved.revision.hash};}
          catch{constrained.manualPublicationSource={status:'UNAVAILABLE',kind:'MANUAL_RUN',...target};}
        }
        if(constrained.manualConsumptionOnly&&constrained.manualConsumptionTaskId&&body.user?.id){
          try{const plan=constrained.consumptionPlan,run=store.get('release_run',plan.sourceReleaseRunId,PROJECT),release=run&&store.get('release',run.releaseId,PROJECT),bundle=run&&store.get('delivery_package',run.packageId,PROJECT),approval=release&&store.get('release_approval',release.approvalId,PROJECT);
            verifiedPrivateServiceSource({run,release,bundle,approval,delivery:store.get('manual_delivery_task',constrained.manualConsumptionTaskId,PROJECT),verification:release&&store.get('delivery_verification',release.verificationId,PROJECT),review:release&&store.get('delivery_review',release.reviewId,PROJECT),releaseRuns:release?store.list('release_run',PROJECT).filter(r=>r.releaseId===release.id):[]});
            if(release.submittedBy!==body.user.id||release.manualDeliveryTaskId!==constrained.manualConsumptionTaskId||release.packageDigest!==plan.packageDigest)throw Error('Manual source mismatch');const source=bundle.manifest.source;
            constrained.manualConsumptionSource={status:'RESOLVED',binding:{manualDeliveryTaskId:release.manualDeliveryTaskId,packageDigest:bundle.digest,releaseId:release.id,sourceKind:'MANUAL',scope:'PRIVATE_CLOUD_TEST',revisionId:source.revisionId,runId:source.runId,revisionHash:source.sqlHash},sourceReleaseRunId:run.id};
          }catch{constrained.manualConsumptionSource={status:'UNAVAILABLE'};}
        }
        return constrained;
      };
      const sessionView = context => context
        ? constrainAuthSession({
            authenticated: true,
            user: context.user,
            role: context.role,
            permissions: publicReadOnly ? ["SESSION"] : context.permissions,
            ...(publicReadOnly ? { readOnly: true } : developmentSessionView ?? {}),
            expiresAt: context.session.expiresAt,
          })
        : {
            authenticated: false,
            ...(publicReadOnly ? { readOnly: true } : developmentSessionView ?? {}),
            mode: local ? "LOCAL_DEVELOPMENT_BYPASS" : "INVITATION_SESSION",
          };
      if (path === "/api/v2/auth/session" && method === "GET")
        return json(res, 200, sessionView(auth.sessionFromHeaders(req.headers)));
      if (
        ["/api/v2/auth/login", "/api/v2/auth/redeem"].includes(path) &&
        method === "POST"
      ) {
        const body = await readBody(req),
          result = await auth.authenticate(
            path.endsWith("/login") ? "login" : "redeem", body,
            { persist: () => persistence.flush?.() },
          ),
          response = auth.sessionResponse(
            result,
            !local && !insecurePublicCookies,
          );
        return json(res, 200, constrainAuthSession(response.body), {
          "Set-Cookie": response.cookies,
        });
      }
      if (path === "/api/v2/auth/logout" && method === "POST") {
        await readBody(req);
        return json(res, 200, auth.logout(req.headers), {
          "Set-Cookie": auth.clearCookie(
            !local && !insecurePublicCookies,
          ),
        });
      }
      if (path === "/api/v2/auth/password" && method === "POST") {
        const actor = auth.requireMutation(req.headers, path),
          result = auth.changePassword(actor, await readBody(req)),
          changed = auth.sessionResponse(
            result,
            !local && !insecurePublicCookies,
          );
        return json(res, 200, constrainAuthSession(changed.body), {
          "Set-Cookie": changed.cookies,
        });
      }
      if (path === "/api/v2/auth/invitations" && method === "GET") {
        const actor = auth.sessionFromHeaders(req.headers);
        if (!actor) throw fail(401, "请先登录受邀账号");
        return json(res, 200, auth.listInvitations(actor));
      }
      if (path === "/api/v2/auth/invitations" && method === "POST") {
        const actor = auth.sessionFromHeaders(req.headers);
        if (!actor) throw fail(401, "请先登录受邀账号");
        return json(
          res,
          201,
          auth.createInvitation(actor, await readBody(req)),
        );
      }
      if (path === "/api/v2/status" && method === "GET") {
        const actor = local && !includeSession ? undefined : scopeActor();
        const mayReadAdminStatus = local || actor?.role === "ADMIN";
        const cloudReplication =
          typeof options.stateCoordinator?.replicationStatus === "function"
            ? options.stateCoordinator.replicationStatus()
            : undefined;
        const status = {
          projectId: PROJECT,
          mode: local ? "LOCAL_DEVELOPMENT" : "PUBLIC_INVITATION",
          site: {
            registeredName: String(env.V2_SITE_REGISTERED_NAME ?? "").trim().slice(0, 80),
            icpNumber: String(env.V2_SITE_ICP_NUMBER ?? "").trim().slice(0, 80),
            icpUrl: "https://beian.miit.gov.cn/",
          },
          capabilities,
          model: {
            ...modelSettings(env),
            connectionVerified: Boolean(modelVerifiedAt),
            verifiedAt: modelVerifiedAt,
          },
          spark: {
            available: options.runner
              ? runnerDescriptor.publicWriteEnabled !== false
              : runtime.available,
            ...runnerDescriptor,
          },
          python: {
            available: options.pythonRunner ? true : pythonRuntime.available,
            engine: "CPython",
            isolation: "LOCAL_RESTRICTED_PROCESS",
            memoryLimitRequired: pythonRuntime.requireMemoryLimit,
            cloudVerified: false,
            publicWriteEnabled: false,
          },
          metadata:
            typeof store.replicationStatus === "function"
              ? {
                  ...store.replicationStatus(),
                  cloudVerified: store.replicationStatus().healthy,
                }
              : { driver: "sqlite", cloudVerified: false },
          persistence:
            cloudReplication
              ? cloudReplication
              : {
                  mode: "local-sqlite",
                  healthy: true,
                  dataState: { driver: "sqlite", healthy: true },
                },
          publicReady: false,
          agentDevelopment: { durableEnabled: Boolean(durableAgent), durableDeliveryEnabled: Boolean(durableDelivery),
            requestBindingSupported:Boolean(durableAgent),eventBackgroundAvailable:Boolean(agentEventDriver), publishAvailable: Boolean(privatePublicationConfig) || (local && releaseSchedulerMode === "LOCAL_TIMER"), sqlMaxAttempts:3, sqlTokenBudget:Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000) },
          validationContract: {
            id: validationContractId,
            fixtureCount: contextIds.length,
          },
          dataServices: {
            privateEnabled: privateDataServicesEnabled,
            localSourcesEnabled: local,
            sourceBoundAgentPlansEnabled: sourceBoundServicePlansEnabled,
            sourceBoundAgentContextEnabled: privateDataServicesEnabled,
            durableServiceAgentEnabled: Boolean(serviceAgentAccess),
            durableServiceAgentReadEnabled: privateDataServicesEnabled,
            scope: privateDataServicesEnabled ? "PRIVATE_CLOUD_TEST" : "LOCAL_TEST_ONLY",
            ...(mayReadAdminStatus ? {serviceCount:dataServices.list().length} : {}),
            businessDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          ingestion: {
            sourceCount: ingestion.listSources().length,
            offlineTaskCount: ingestion.listTasks().length,
            sourceType: "LOCAL_CSV",
            availableSourceTypes: [
              "LOCAL_CSV",
              ...(serverMysqlAdapter.configured === true ? ["SERVER_MYSQL"] : []),
            ],
            landingDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
            serverMysql: {
              configured: serverMysqlAdapter.configured === true,
              supportsOfflineSync:
                serverMysqlAdapter.supportsOfflineSync === true,
              allowTableCount: Array.isArray(serverMysqlAdapter.allowTables)
                ? serverMysqlAdapter.allowTables.length
                : 0,
              credentialMode: "SERVER_ENV_ONLY",
            },
          },
          realtime: {
            sourceCount: realtime.listSources().length,
            jobCount: realtime.listJobs().length,
            adapter: "local-event-log-v1",
            kafkaConnected: false,
            flinkConnected: false,
            stateDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          assets: {
            assetCount: assets.listAssets().length,
            metricCount: assets.listMetrics().length,
            standardCount: assets.listStandards().length,
            contractCount: dataContracts.list().length,
            lineageDerivation: "VERSION_BINDINGS",
            sqlColumnLineageParsed: false,
            cloudVerified: false,
          },
          quality: {
            ...quality.overview().counts,
            executionScope: "LOCAL_ACTUAL_ROWS",
            cloudVerified: false,
          },
          security: {
            ...security.overview().counts,
            identityMode: local
              ? "LOCAL_SYNTHETIC_HEADER"
              : "INVITATION_SESSION",
            publicAuthentication: !local,
            cloudVerified: Boolean(
              cloudReplication?.metadata.healthy,
            ),
          },
          reports: {
            ...reports.overview().counts,
            sourceBoundPlanningAvailable:local&&Boolean(options.reportPlanner||modelSettings(env).configured),
            executionScope: "LOCAL_AGGREGATED_REPORTING",
            publicDeployed: false,
            snapshotDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          operations: {
            ...operations.overview().counts,
            health: operations.overview().health,
            scope: "LOCAL_CROSS_MODULE_OBSERVABILITY",
            publicDeployed: false,
          },
          authentication: {
            ...(mayReadAdminStatus ? auth.overview() : {}),
            mode: local ? "LOCAL_DEVELOPMENT_BYPASS" : "INVITATION_SESSION",
            publicSessionEnforced: !local,
          },
          artifacts: artifactStore.status(),
          ...(mayReadAdminStatus ? { budget: budget.overview() } : {}),
          scheduler: {
            mode: releaseSchedulerMode,
            durableTickConfigured: Boolean(schedulerTickConfig),
            publicDeployed: false,
          },
        };
        const visibleStatus = mayReadAdminStatus ? status : publicCapabilityStatus(status);
        return json(res, 200, includeSession ? { status: visibleStatus, session: sessionView(actor) } : visibleStatus);
      }
      if (path === "/api/v2/budget" && method === "GET") {
        if (!local) {
          const actor = auth.sessionFromHeaders(req.headers);
          if (!actor) throw Object.assign(fail(401, "请先登录管理员账号查看费用与用量"), { code: "AUTHENTICATION_REQUIRED" });
          if (actor.role !== "ADMIN") throw Object.assign(fail(403, "仅项目管理员可查看费用与用量"), { code: "PROJECT_PERMISSION_DENIED" });
        }
        return json(res, 200, budget.overview());
      }
      if (path === "/api/v2/cloud/readiness" && method === "GET") {
        const session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录管理员账号查看部署前置"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!local && session.role !== "ADMIN")
          throw Object.assign(fail(403, "仅项目管理员可查看部署前置"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        return json(res, 200, await cloudReadiness());
      }
      if (privateSmokeEnabled && (path.startsWith("/api/v2/data-services/") || path.startsWith("/api/v2/open/"))) {
        if (!privateServices && publicReadOnly && method === "GET" && path === "/api/v2/data-services/task-evidence") {
          const proof = await privateServiceRoutes.readTaskEvidence(req, url.searchParams, (taskId, release, owner) => {
            const sourceKind = release.sourceKind ?? "AGENT";
            cloudPublicationHistory.savedDetail(taskId, { sourceKind, packageDigest: release.packageDigest,
              releaseId: release.id, actorId: owner,
              ...(sourceKind === "MANUAL" ? { sourceRunId: release.sourceRunId, verificationId: release.verificationId } : {}) });
          });
          return json(res, 200, proof);
        }
        if(!privateServices)throw fail(503,"私有数据服务尚未启用");
        if(typeof persistence.flush==="function" && (method!=="GET" || path.startsWith("/api/v2/open/")))res.metadataFlush=()=>persistence.flush();
        const result=await privateServices.handle(req,url,readBody);return json(res,result.status,result.body);
      }
      const openService = path.match(
        /^\/api\/v2\/open\/(dapis|xapis)\/([a-z][a-z0-9-]{2,47})$/,
      );
      if (openService && method === "GET") {
        if (new Set(url.searchParams.keys()).size !== url.searchParams.size) throw fail(400, "查询参数不能重复");
        return json(
          res,
          200,
          await dataServices.invoke(
            openService[1] === "dapis" ? "DAPI" : "XAPI",
            openService[2],
            req.headers.authorization,
            Object.fromEntries(url.searchParams),
            { assertAccess: ({version}) => {
              if (version.sourceEvidence?.protocol === syncServiceProtocol) requireSyncSqlLocal(req);
            } },
          ),
        );
      }
      if (!local && method === "GET" && path.startsWith("/api/v2/") && ![contextsPath, "/api/v2/agent/tools"].includes(path) && !auth.sessionFromHeaders(req.headers)) {
        const emptyLists = new Set(["/api/v2/revisions", "/api/v2/runs", "/api/v2/python/revisions", "/api/v2/python/runs", "/api/v2/agent/tasks", "/api/v2/agent/deliveries"]);
        if (emptyLists.has(path)) return json(res, 200, []);
        throw Object.assign(fail(401, "请先登录受邀账号查看项目数据"), { code: "AUTHENTICATION_REQUIRED" });
      }
      if (!local && path.startsWith("/api/v2/data-services/"))
        throw fail(403, "当前受邀环境未启用受治理的数据服务");
      if (path === contextsPath && method === "GET") return json(res, 200, fixtureContexts());
      if (path === "/api/v2/sources" && method === "GET")
        return json(res, 200, ingestion.listSources());
      if (path === "/api/v2/sources" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:source:${key}`,
            hash(JSON.stringify(body)),
            () => ingestion.createSource(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          ingestion.sourceDetail(dedup.id),
        );
      }
      const sourceRecord = path.match(
        /^\/api\/v2\/sources\/([a-f0-9-]+)(?:\/(test|metadata|revisions))?$/,
      );
      if (sourceRecord) {
        const source = ingestion.sourceDetail(sourceRecord[1]),
          action = sourceRecord[2];
        if (method === "GET" && !action) return json(res, 200, source);
        if (method === "POST" && action === "test") {
          await readBody(req);
          return json(
            res,
            200,
            source.sourceType === "SERVER_MYSQL"
              ? await ingestion.testServerMysqlConnection(source.id)
              : ingestion.testConnection(source.id),
          );
        }
        if (method === "POST" && action === "metadata") {
          await readBody(req);
          return json(
            res,
            200,
            source.sourceType === "SERVER_MYSQL"
              ? await ingestion.collectServerMysqlMetadata(source.id)
              : ingestion.collectMetadata(source.id),
          );
        }
        if (method === "POST" && action === "revisions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:source-revision:${source.id}:${key}`,
              hash(JSON.stringify(body)),
              () => ingestion.createSourceRevision(source.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("source_revision", dedup.id),
          );
        }
      }
      if (path === "/api/v2/sync/tasks" && method === "GET")
        return json(res, 200, ingestion.listTasks());
      if (path === "/api/v2/sync/agent/plans" && method === "GET")
        return json(res, 200, store.list("ingestion_agent_plan", PROJECT));
      if (path === "/api/v2/sync/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.ingestionPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:ingestion-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("ingestion_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "OFFLINE_SYNC_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("ingestion_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("ingestion_agent_plan", task, async (signal) => {
            const generated = await ingestionPlanner({
                message,
                sources: ingestion.listSources(),
                signal,
              });
            if (get("ingestion_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = ingestion.validateAgentPlan(generated.plan);
            store.update("ingestion_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const ingestionAgentPlan = path.match(
        /^\/api\/v2\/sync\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (ingestionAgentPlan) {
        const plan = get("ingestion_agent_plan", ingestionAgentPlan[1]),
          action = ingestionAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("ingestion_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("ingestion_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.syncTaskId)
            return json(res, 200, ingestion.taskDetail(plan.syncTaskId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型同步方案验证通过后才能创建草稿");
          const proposal = ingestion.validateAgentPlan(plan.proposal),
            syncTask = ingestion.createTask(proposal);
          store.update("ingestion_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            syncTaskId: syncTask.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, ingestion.taskDetail(syncTask.id));
        }
      }
      if (path === "/api/v2/sync/tasks" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:offline-sync-task:${key}`,
            hash(JSON.stringify(body)),
            () => ingestion.createTask(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          ingestion.taskDetail(dedup.id),
        );
      }
      const syncTaskRecord = path.match(
        /^\/api\/v2\/sync\/tasks\/([a-f0-9-]+)(?:\/(run))?$/,
      );
      if (syncTaskRecord) {
        const task = ingestion.taskDetail(syncTaskRecord[1]),
          action = syncTaskRecord[2];
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "run") {
          await readBody(req);
          const requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                taskId: task.id,
                configHash: task.configHash,
                sourceRevisionId: task.sourceRevisionId,
              }),
            );
          return json(
            res,
            200,
            task.sourceType === "SERVER_MYSQL"
              ? await ingestion.runServerMysqlTask(task.id, {
                  requestKey,
                  requestSignature,
                })
              : ingestion.runTask(task.id, { requestKey, requestSignature }),
          );
        }
      }
      const targetRows = path.match(
        /^\/api\/v2\/sync\/targets\/([a-z][a-z0-9_]{0,62})\/rows$/,
      );
      if (targetRows && method === "GET")
        return json(res, 200, ingestion.previewTarget(targetRows[1]));
      if (path === "/api/v2/streams/monitor" && method === "GET")
        return json(res, 200, realtime.monitor());
      if (path === "/api/v2/streams/agent/plans" && method === "GET")
        return json(res, 200, store.list("realtime_agent_plan", PROJECT));
      if (path === "/api/v2/streams/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.realtimePlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:realtime-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("realtime_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "REALTIME_SYNC_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("realtime_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("realtime_agent_plan", task, async (signal) => {
            const generated = await realtimePlanner({
                message,
                sources: realtime.listSources(),
                signal,
              });
            if (get("realtime_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = realtime.validateAgentPlan(generated.plan);
            store.update("realtime_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const realtimeAgentPlan = path.match(
        /^\/api\/v2\/streams\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (realtimeAgentPlan) {
        const plan = get("realtime_agent_plan", realtimeAgentPlan[1]),
          action = realtimeAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("realtime_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("realtime_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.streamJobId)
            return json(res, 200, realtime.jobDetail(plan.streamJobId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型实时方案验证通过后才能创建草稿");
          const proposal = realtime.validateAgentPlan(plan.proposal),
            streamJob = realtime.createJob(proposal);
          store.update("realtime_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            streamJobId: streamJob.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, realtime.jobDetail(streamJob.id));
        }
      }
      if (path === "/api/v2/streams/sources" && method === "GET")
        return json(res, 200, realtime.listSources());
      if (path === "/api/v2/streams/sources" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:stream-source:${key}`,
            hash(JSON.stringify(body)),
            () => realtime.createSource(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          realtime.sourceDetail(dedup.id),
        );
      }
      const streamSourceRecord = path.match(
        /^\/api\/v2\/streams\/sources\/([a-f0-9-]+)(?:\/(revisions))?$/,
      );
      if (streamSourceRecord) {
        const source = realtime.sourceDetail(streamSourceRecord[1]),
          action = streamSourceRecord[2];
        if (method === "GET" && !action) return json(res, 200, source);
        if (method === "POST" && action === "revisions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:stream-revision:${source.id}:${key}`,
              hash(JSON.stringify(body)),
              () => realtime.createSourceRevision(source.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("stream_source_revision", dedup.id),
          );
        }
      }
      if (path === "/api/v2/streams/jobs" && method === "GET")
        return json(res, 200, realtime.listJobs());
      if (path === "/api/v2/streams/jobs" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:stream-job:${key}`,
            hash(JSON.stringify(body)),
            () => realtime.createJob(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          realtime.jobDetail(dedup.id),
        );
      }
      const streamJobRecord = path.match(
        /^\/api\/v2\/streams\/jobs\/([a-f0-9-]+)(?:\/(start|stop|recover|state|checkpoints))?$/,
      );
      if (streamJobRecord) {
        const job = realtime.jobDetail(streamJobRecord[1]),
          action = streamJobRecord[2];
        if (method === "GET" && !action) return json(res, 200, job);
        if (method === "GET" && action === "state")
          return json(res, 200, job.state);
        if (method === "GET" && action === "checkpoints")
          return json(res, 200, job.checkpoints);
        if (method === "POST" && action === "start") {
          await readBody(req);
          const requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                jobId: job.id,
                sourceRevisionId: job.sourceRevisionId,
                action: "start",
              }),
            );
          return json(
            res,
            202,
            realtime.startJob(job.id, { requestKey, requestSignature }),
          );
        }
        if (method === "POST" && action === "recover") {
          const body = await readBody(req),
            sourceRevisionId = text(body.sourceRevisionId, 1, 80),
            requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                jobId: job.id,
                sourceRevisionId,
                action: "recover",
              }),
            );
          return json(
            res,
            202,
            realtime.recoverJob(
              job.id,
              { sourceRevisionId },
              { requestKey, requestSignature },
            ),
          );
        }
        if (method === "POST" && action === "stop") {
          await readBody(req);
          return json(res, 202, realtime.stopJob(job.id));
        }
      }
      if (path === "/api/v2/assets" && method === "GET") {
        const q = url.searchParams.get("q") ?? "", kind = url.searchParams.get("kind") ?? "";
        const frozen = syncSqlLocal && isLoopbackRequest(req) && (!kind || kind === "PUBLISHED_DATASET")
          ? syncSourcesFor({}).map(source => syncReportAsset(get("release_run",source.id),{sourceEvidence:source.sourceEvidence},publishedReportHash))
            .filter(asset => [asset.name,asset.businessName,asset.description,...asset.tags,...asset.fields.map(field=>field.name)]
              .some(value => value.toLowerCase().includes(q.trim().toLowerCase()))) : [];
        return json(
          res,
          200,
          [...assets.listAssets({q,kind}),...frozen],
        );
      }
      if (path === "/api/v2/assets/agent/tasks" && method === "GET")
        return json(res, 200, store.list("asset_agent_task", PROJECT));
      if (path === "/api/v2/assets/agent/tasks" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.assetPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:asset-agent-task:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("asset_agent_task", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "ASSET_DISCOVERY",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("asset_agent_task", dedup.id);
        if (!dedup.replayed)
          schedule("asset_agent_task", task, async (signal) => {
            const context = assets.agentContext(),
              generated = await assetPlanner({
                message,
                ...context,
                contracts: dataContracts.agentContext(),
                signal,
              });
            if (get("asset_agent_task", task.id).status === "CANCELLED") return;
            const insight = assets.validateAgentInsight(generated.insight, context);
            store.update("asset_agent_task", task.id, PROJECT, {
              status: "SUCCEEDED",
              insight,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const assetAgentTask = path.match(
        /^\/api\/v2\/assets\/agent\/tasks\/([a-f0-9-]+)(?:\/(cancel))?$/,
      );
      if (assetAgentTask) {
        const task = get("asset_agent_task", assetAgentTask[1]),
          action = assetAgentTask[2];
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(task.status)) {
            store.update("asset_agent_task", task.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(task.id)?.abort();
          }
          return json(res, 200, get("asset_agent_task", task.id));
        }
      }
      const annotationRequest = path.match(/^\/api\/v2\/assets\/([^/]+)\/annotation-requests(?:\/([a-f0-9-]+))?$/i);
      if (annotationRequest) {
        const id = decodeURIComponent(annotationRequest[1]), requestId = annotationRequest[2], actorId = local ? "local-engineer" : auth.sessionFromHeaders(req.headers)?.user.id;
        if (method === "GET" && requestId) return json(res, 200, annotationRequests.lookup(id, requestId, actorId));
        if (method === "POST" && !requestId) {
          const value = annotationRequests.submit(id, await readBody(req), actorId, req.headers["idempotency-key"]);
          return json(res, value.replayed ? 200 : 201, value);
        }
        throw fail(405, "标注请求方法不受支持");
      }
      const assetRecord = path.match(
        /^\/api\/v2\/assets\/([^/]+)(?:\/(annotation|lineage|impact))?$/,
      );
      if (assetRecord) {
        const id = decodeURIComponent(assetRecord[1]),
          action = assetRecord[2];
        if (isSyncAssetId(id)) {
          requireSyncSqlLocal(req);
          if (method !== "GET" || action && action !== "lineage") throw fail(405,"冻结发布资产支持读取原字段和血缘");
          const batch = get("release_run", publishedReportSourceBatchId(syncAssetBatchId(id)));
          requireDeliveryEvidence("release_run", batch);
          const proof = certifySyncService(batch);
          if (!proof) throw fail(404, "未找到已核对的原发布资产");
          const detail = syncAssetView({store,project:PROJECT,batch,proof,id,hash:publishedReportHash,
            fixtures:assets.listAssets({kind:"FIXTURE_TABLE"})});
          return json(res,200,action === "lineage" ? detail.lineage : detail);
        }
        if (method === "GET" && !action)
          return json(res, 200, assets.detail(id));
        if (method === "GET" && action === "lineage")
          return json(res, 200, assets.lineage(id));
        if (method === "GET" && action === "impact")
          return json(res, 200, assets.impact(id));
        if (method === "POST" && action === "annotation") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:asset-annotation:${id}:${key}`,
              hash(JSON.stringify(body)),
              () => assets.annotate(id, body).annotation,
            );
          get("asset_annotation", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, assets.detail(id));
        }
      }
      const gateRoute=path.match(/^\/api\/v2\/data-services\/([a-f0-9-]{36})\/contract-gates(?:\/([a-f0-9-]{36})\/(versions))?$/);
      const gateRequest=path.match(/^\/api\/v2\/data-services\/([a-f0-9-]{36})\/contract-gate-requests\/([A-Za-z0-9_-]{1,100})$/);
      if(gateRequest&&method==='GET'){
        if(!local)throw fail(403,'门禁保存请求只在本机开发边界开放');
        return json(res,200,serviceContractGates.lookup(gateRequest[1],auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer',gateRequest[2]));
      }
      if(gateRoute){
        if(!local)throw fail(403,'契约门禁配置目前只在本机开发边界开放');
        const serviceId=gateRoute[1];
        if(method==='GET'&&!gateRoute[2]){
          if([...url.searchParams.keys()].some(k=>k!=='version_id')||url.searchParams.getAll('version_id').length>1)throw fail(422,'门禁读取只接受一个确切版本');
          return json(res,200,serviceContractGates.list(serviceId,{versionId:url.searchParams.get('version_id')??undefined}));
        }
        if(method==='POST'){
          const body=await readBody(req),actor=auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer',key=text(req.headers['idempotency-key'],1,100),allowed=gateRoute[2]?['contractVersionId','freshnessBasis','expectedBindingVersion','changeReason']:['contractId','contractVersionId','freshnessBasis'];
          if(!body||typeof body!=='object'||Array.isArray(body))throw fail(422,'契约门禁请求必须是对象');
          if(Object.keys(body).some(k=>!allowed.includes(k)))throw fail(422,'契约门禁请求包含未声明字段');
          const result=serviceContractGates.submit(serviceId,gateRoute[2],body,actor,key);
          return json(res,result.replayed?200:201,result);
        }
      }
      if (path === "/api/v2/contracts" && method === "GET")
        return json(res, 200, dataContracts.list());
      if (path === "/api/v2/contracts" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:data-contract:${key}`,
            hash(JSON.stringify(body)),
            () => dataContracts.create(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          dataContracts.detail(dedup.id),
        );
      }
      const contractRecord = path.match(
        /^\/api\/v2\/contracts\/([a-f0-9-]+)(?:\/(assess|versions|check))?$/,
      );
      if (contractRecord) {
        const id = contractRecord[1],
          action = contractRecord[2];
        if (method === "GET" && !action)
          return json(res, 200, dataContracts.detail(id));
        if (method === "POST" && action === "assess") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:contract-assessment:${id}:${key}`,
              hash(JSON.stringify(body)),
              () => dataContracts.assess(id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("data_contract_assessment", dedup.id),
          );
        }
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:contract-version:${id}:${key}`,
              hash(JSON.stringify(body)),
              () => dataContracts.createVersion(id, body).currentVersion,
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            dataContracts.detail(id),
          );
        }
        if (method === "POST" && action === "check") {
          await readBody(req);
          const contract = dataContracts.detail(id),
            key = text(req.headers["idempotency-key"], 1, 100),
            signature = hash(
              JSON.stringify({
                contractVersionId: contract.currentVersion.id,
                assetEvidenceHash: assets.detail(contract.assetId).evidenceHash,
              }),
            ),
            dedup = store.deduplicate(
              `${PROJECT}:contract-check:${id}:${key}`,
              signature,
              () => dataContracts.check(id).check,
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("data_contract_check", dedup.id),
          );
        }
      }
      if (path === "/api/v2/metrics" && method === "GET")
        return json(res, 200, assets.listMetrics());
      if (path === "/api/v2/metrics" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:metric:${key}`,
            hash(JSON.stringify(body)),
            () => assets.createMetric(body),
          );
        return json(res, dedup.replayed ? 200 : 201, get("metric_definition", dedup.id));
      }
      const metricRecord = path.match(
        /^\/api\/v2\/metrics\/([a-f0-9-]+)(?:\/(run))?$/,
      );
      if (metricRecord) {
        const metric = assets
            .listMetrics()
            .find((item) => item.id === metricRecord[1]),
          action = metricRecord[2];
        if (!metric) throw fail(404, "未找到指标");
        if (method === "GET" && !action) return json(res, 200, metric);
        if (method === "POST" && action === "run") {
          await readBody(req);
          const key = text(req.headers["idempotency-key"], 1, 100),
            evidenceHash = assets.detail(metric.assetId).evidenceHash,
            dedup = store.deduplicate(
              `${PROJECT}:metric-run:${metric.id}:${key}`,
              hash(JSON.stringify({ metricId: metric.id, evidenceHash })),
              () => assets.runMetric(metric.id),
            );
          return json(res, dedup.replayed ? 200 : 201, get("metric_run", dedup.id));
        }
      }
      if (path === "/api/v2/standards" && method === "GET")
        return json(res, 200, assets.listStandards());
      if (path === "/api/v2/standards" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:standard:${key}`,
            hash(JSON.stringify(body)),
            () => assets.createStandard(body),
          );
        return json(res, dedup.replayed ? 200 : 201, get("data_standard", dedup.id));
      }
      const standardRecord = path.match(
        /^\/api\/v2\/standards\/([a-f0-9-]+)(?:\/(check))?$/,
      );
      if (standardRecord) {
        const standard = assets
            .listStandards()
            .find((item) => item.id === standardRecord[1]),
          action = standardRecord[2];
        if (!standard) throw fail(404, "未找到数据标准");
        if (method === "GET" && !action) return json(res, 200, standard);
        if (method === "POST" && action === "check") {
          await readBody(req);
          const key = text(req.headers["idempotency-key"], 1, 100),
            evidenceHash = assets.detail(standard.assetId).evidenceHash,
            dedup = store.deduplicate(
              `${PROJECT}:standard-check:${standard.id}:${key}`,
              hash(JSON.stringify({ standardId: standard.id, evidenceHash })),
              () => assets.checkStandard(standard.id),
            );
          return json(res, dedup.replayed ? 200 : 201, get("standard_check", dedup.id));
        }
      }
      if (path === "/api/v2/quality/overview" && method === "GET")
        return json(res, 200, quality.overview());
      if (path === "/api/v2/quality/rules" && method === "GET")
        return json(res, 200, quality.listRules());
      if (path === "/api/v2/quality/rules" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:quality-rule:${key}`,
            hash(JSON.stringify(body)),
            () => quality.createRule(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          quality.detail(dedup.id),
        );
      }
      if (path === "/api/v2/quality/agent/plans" && method === "GET")
        return json(res, 200, store.list("quality_agent_plan", PROJECT));
      if (path === "/api/v2/quality/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.qualityPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:quality-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("quality_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "QUALITY_RULE_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("quality_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("quality_agent_plan", task, async (signal) => {
            const context = quality.agentContext(),
              generated = await qualityPlanner({
                message,
                ...context,
                signal,
              });
            if (get("quality_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = quality.validateAgentPlan(generated.plan);
            store.update("quality_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const qualityAgentPlan = path.match(
        /^\/api\/v2\/quality\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (qualityAgentPlan) {
        const plan = get("quality_agent_plan", qualityAgentPlan[1]),
          action = qualityAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("quality_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("quality_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.ruleId)
            return json(res, 200, quality.detail(plan.ruleId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型质量方案验证通过后才能创建规则草稿");
          const proposal = quality.validateAgentPlan(plan.proposal),
            rule = quality.createRule(proposal);
          store.update("quality_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            ruleId: rule.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, rule);
        }
      }
      const qualityRuleRecord = path.match(
        /^\/api\/v2\/quality\/rules\/([a-f0-9-]+)(?:\/(versions|run))?$/,
      );
      if (qualityRuleRecord) {
        const rule = quality.detail(qualityRuleRecord[1]),
          action = qualityRuleRecord[2];
        if (method === "GET" && !action) return json(res, 200, rule);
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:quality-rule-version:${rule.id}:${key}`,
              hash(JSON.stringify(body)),
              () => quality.createVersion(rule.id, body).currentVersion,
            );
          get("quality_rule_version", dedup.id);
          return json(
            res,
            dedup.replayed ? 200 : 201,
            quality.detail(rule.id),
          );
        }
        if (method === "POST" && action === "run") {
          await readBody(req);
          const current = quality.detail(rule.id),
            evidenceHash = assets.detail(rule.assetId).evidenceHash,
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:quality-run:${rule.id}:${key}`,
              hash(
                JSON.stringify({
                  ruleId: rule.id,
                  versionId: current.currentVersionId,
                  configHash: current.currentVersion.configHash,
                  evidenceHash,
                }),
              ),
              () => quality.runRule(rule.id).run,
            );
          get("quality_run", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, quality.detail(rule.id));
        }
      }
      if (path === "/api/v2/security/overview" && method === "GET")
        return json(res, 200, security.overview());
      if (path === "/api/v2/security/personas" && method === "GET")
        return json(res, 200, security.personas());
      if (path === "/api/v2/security/policies" && method === "GET")
        return json(res, 200, security.listPolicies());
      if (path === "/api/v2/security/policies" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-policy:${key}`,
            hash(JSON.stringify(body)),
            () => security.createPolicy(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          security.policyDetail(dedup.id),
        );
      }
      const securityPolicyRecord = path.match(
        /^\/api\/v2\/security\/policies\/([a-f0-9-]+)(?:\/(versions))?$/,
      );
      if (securityPolicyRecord) {
        const policy = security.policyDetail(securityPolicyRecord[1]),
          action = securityPolicyRecord[2];
        if (method === "GET" && !action) return json(res, 200, policy);
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:security-policy-version:${policy.id}:${key}`,
              hash(JSON.stringify(body)),
              () => security.createPolicyVersion(policy.id, body).currentVersion,
            );
          get("security_policy_version", dedup.id);
          return json(
            res,
            dedup.replayed ? 200 : 201,
            security.policyDetail(policy.id),
          );
        }
      }
      const securityQuery = path.match(
        /^\/api\/v2\/security\/query\/([^/]+)$/,
      );
      if (securityQuery && method === "POST") {
        await readBody(req);
        const actorId = text(req.headers["x-actor-id"], 3, 80);
        return json(
          res,
          200,
          security.query(actorId, decodeURIComponent(securityQuery[1])),
        );
      }
      if (path === "/api/v2/security/requests" && method === "GET")
        return json(res, 200, security.listRequests());
      if (path === "/api/v2/security/requests" && method === "POST") {
        const body = await readBody(req),
          actorId = text(req.headers["x-actor-id"], 3, 80),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-request:${actorId}:${key}`,
            hash(JSON.stringify(body)),
            () => security.createRequest(actorId, body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          get("access_request", dedup.id),
        );
      }
      const securityRequestReview = path.match(
        /^\/api\/v2\/security\/requests\/([a-f0-9-]+)\/review$/,
      );
      if (securityRequestReview && method === "POST") {
        const body = await readBody(req),
          actorId = text(req.headers["x-actor-id"], 3, 80),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-review:${securityRequestReview[1]}:${actorId}:${key}`,
            hash(JSON.stringify(body)),
            () =>
              security.reviewRequest(
                actorId,
                securityRequestReview[1],
                body,
              ).request,
          ),
          reviewed = get("access_request", dedup.id),
          grant = reviewed.grantId
            ? get("security_grant", reviewed.grantId)
            : undefined;
        return json(res, dedup.replayed ? 200 : 201, { request: reviewed, grant });
      }
      if (path === "/api/v2/security/audits" && method === "GET")
        return json(res, 200, security.listAudits());
      if (path === "/api/v2/security/agent/plans" && method === "GET")
        return json(res, 200, store.list("security_agent_plan", PROJECT));
      if (path === "/api/v2/security/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.securityPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("security_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "SECURITY_POLICY_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("security_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("security_agent_plan", task, async (signal) => {
            const context = security.agentContext(),
              generated = await securityPlanner({
                message,
                ...context,
                signal,
              });
            if (get("security_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = security.validateAgentPlan(generated.plan);
            store.update("security_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const securityAgentPlan = path.match(
        /^\/api\/v2\/security\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (securityAgentPlan) {
        const plan = get("security_agent_plan", securityAgentPlan[1]),
          action = securityAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("security_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("security_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.policyId)
            return json(res, 200, security.policyDetail(plan.policyId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型安全方案验证通过后才能创建策略草稿");
          const proposal = security.validateAgentPlan(plan.proposal),
            policy = security.createPolicy(proposal);
          store.update("security_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            policyId: policy.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, policy);
        }
      }
      if (path === "/api/v2/reports/overview" && method === "GET") {
        const overview = reports.overview(), datasets = overview.datasets.filter(canReadSyncDataset),
          visible = overview.reports.filter(canReadSyncReport);
        return json(res, 200, {...overview,datasets,reports:visible,counts:{
          datasets:datasets.length,readyDatasets:datasets.filter(item=>item.status==="READY").length,
          reports:visible.length,verifiedReports:visible.filter(item=>item.status==="VERIFIED_LOCAL").length,
          runs:visible.reduce((count,report)=>count+report.runs.length,0),
        }});
      }
      const archivePath = "/api/v2" + batchArchiveRoute;
      if (path === archivePath || path.startsWith(archivePath + "/")) {
        if (!privateBatchArchives) throw fail(404, "此环境未启用私有批次报表归档");
        const session = auth.sessionFromHeaders(req.headers), actorId = session?.user.id;
        const canArchive = env.V2_PRIVATE_BATCH_REPORT_ARCHIVE_ENABLED === "true" &&
          options.ingress?.status.publicReadOnly !== true && !developmentAccess && !publicationAccess && !serviceAccess && !serviceAgentAccess &&
          Boolean(session?.permissions.some(permission => permission === "*" || permission === "REPORTS"));
        if (method === "POST" && path === archivePath) {
          if (!canArchive) throw fail(403, "当前环境只允许读取已保存的报表归档");
          if (url.search) throw fail(422, "归档提交仅接受请求正文");
          const {replayed, receipt} = privateBatchArchives.submit(actorId, req.headers["idempotency-key"], await readBody(req));
          return json(res, replayed ? 200 : 201, receipt);
        }
        if (method === "GET" && path === archivePath) {
          const {source, downloadDigest} = privateBatchReportQuery(url.searchParams);
          if (downloadDigest !== null) throw fail(422, "下载需要确切归档请求编号");
          return json(res, 200, {canArchive, actorId, entries:privateBatchArchives.list(actorId, source)});
        }
        if (method === "GET") {
          const digest = url.searchParams.get("download_digest");
          if (url.searchParams.size !== Number(digest !== null) || (digest !== null && !archiveSha.test(digest)))
            throw fail(422, "归档下载摘要无效");
          const receipt = privateBatchArchives.read(actorId, path.slice(archivePath.length + 1));
          if (digest === null) return json(res, 200, receipt);
          if (digest !== receipt.digest) throw fail(409, "归档摘要已变化，请重新核对");
          return json(res, 200, receipt, {
            "Content-Disposition": `attachment; filename="shuduo-batch-archive-${receipt.review.requestId.slice(0, 8)}.json"`,
          });
        }
        throw fail(404, "未找到报表归档操作");
      }
      if (path === "/api/v2" + privateBatchReportRoute && method === "GET") {
        if (!privateDataServicesEnabled) throw fail(404, "此环境未启用私有发布批次报表");
        const {source, downloadDigest} = privateBatchReportQuery(url.searchParams);
        const actorId = auth.sessionFromHeaders(req.headers)?.user.id;
        const report = readPrivateBatchReport({store, businessStore, project:PROJECT, actorId, source});
        if (downloadDigest === null) return json(res, 200, report);
        if (report.digest !== downloadDigest)
          throw Object.assign(fail(409, "批次报表摘要已变化，请重新核对"), {code:"PRIVATE_BATCH_REPORT_DIGEST_CHANGED"});
        return json(res, 200, report, {
          "Content-Disposition": `attachment; filename="shuduo-batch-report-${source.batchId.slice(0, 8)}.json"`,
        });
      }
      const requireFundAgentReportOwner = source => {
        const release = typeof source?.releaseId === "string" && store.get("release", source.releaseId, PROJECT);
        if (release?.syncInput) {
          requireSyncSqlLocal(req);
          requireDeliveryEvidence("release",release);
        }
        if (source?.kind !== "AGENT" || typeof source.taskId !== "string") return;
        const agent = store.get("agent", source.taskId, PROJECT);
        if (agent?.fundPreparation) requireDurableAgentOwner(agent, req);
      };
      const reportQuality = path.match(/^\/api\/v2\/reports\/published\/requests\/([A-Fa-f0-9-]{36})\/quality$/);
      if (reportQuality && ["GET", "POST"].includes(method)) {
        if (!localClassicSpark || options.ingress || !isLoopbackRequest(req)) throw fail(403, "基金报表质量检测仅支持本机");
        if (url.searchParams.size) throw fail(422, "请使用原报表编号，质量检测不接受切换批次");
        const [, requestId] = reportQuality, actor = reportActor(req);
        const confirmation = method === "POST" ? await readBody(req) : undefined;
        requireFundAgentReportOwner(publishedReports.lookup(requestId, actor).source);
        const { lineage, rows } = publishedReports.qualitySource(requestId, actor, releaseTimeUnitMs);
        return json(res, 200, fundReportQuality({ store, project: PROJECT, actor, quality, lineage, rows, confirmation }));
      }
      const originalReportResult = path.match(/^\/api\/v2\/reports\/published\/requests\/([A-Fa-f0-9-]{36})\/(result|lineage|development|consumption|export)$/);
      if (originalReportResult && method === "GET") {
        if (!local) throw fail(403, "原发布报表结果仅在本机开发边界开放");
        const [ , requestId, view] = originalReportResult;
        const downloadDigest = url.searchParams.get("download_digest");
        if (url.searchParams.size && (view !== "lineage" || url.searchParams.size !== 1 ||
            !/^[a-f0-9]{64}$/.test(downloadDigest ?? ""))) throw fail(422, "按原编号读取结果只接受确切溯源下载摘要");
        const actor = reportActor(req);
        requireFundAgentReportOwner(publishedReports.lookup(requestId, actor).source);
        if (view === "export") {
          const { receipt } = publishedReports.readResult(requestId, actor);
          return json(res, 200, reports.exportReport(receipt.reportId, receipt.reportRunId));
        }
        if (view === "consumption") {
          if (!localClassicSpark || options.ingress || !isLoopbackRequest(req)) throw fail(403, "基金报表消费核验仅支持本机");
          const lineage = await publishedReports.readLineage(requestId, actor, releaseTimeUnitMs);
          if (lineage.protocol !== "shuduo-fund-report-lineage/v1") throw fail(422, "请从冻结持仓的报表溯源查看授权调用");
          const { source, report } = lineage;
          if (source.kind !== "AGENT") throw fail(422, "此核对需要基金 Agent 报表");
          const agent = get("agent", source.taskId);
          requireDurableAgentOwner(agent, req);
          const consumption = lineage.release.activeForConsumption ? await fundAgentTaskConsumption({
            store, project: PROJECT, agent, packageDigest: source.packageDigest, releaseId: source.releaseId,
            batchId: source.batchId, manager: dataServices, timeUnitMs: releaseTimeUnitMs, fundSignedExecutionFor,
          }) : undefined;
          return json(res, 200, { protocol: "shuduo-fund-report-consumption/v1", scope: "LOCAL_TEST_ONLY",
            requestId, source, report, status: consumption?.status ?? "UNAVAILABLE", consumption });
        }
        if (view === "development") return json(res, 200, publishedReports.readDevelopment(requestId, actor, releaseTimeUnitMs));
        if (view === "lineage") {
          const lineage = await publishedReports.readLineage(requestId, actor, releaseTimeUnitMs);
          if (!downloadDigest) return json(res,200,lineage);
          if (lineage.digest !== downloadDigest) throw fail(409, "原溯源摘要已变化，请重新核对");
          return json(res,200,lineage,{"Content-Disposition":`attachment; filename="shuduo-sync-report-${requestId.slice(0,8)}.json"`});
        }
        return json(res, 200, publishedReports.readResult(requestId, actor));
      }
      const reportCreation=path.match(/^\/api\/v2\/reports\/published(?:\/(requests)\/([a-f0-9-]{36})|\/([a-f0-9-]{36})\/(advance))?$/);
      if(reportCreation){
        if(!local)throw fail(403,'确切发布报表创建尚只在本机开发边界开放');
        const actorId=auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer';
        if(method==='POST'&&!reportCreation[1]&&!reportCreation[3]){
          const body=await readBody(req);
          requireFundAgentReportOwner(body.source);
          const result=publishedReports.submit(body,actorId,req.headers['idempotency-key']);
          return json(res,result.status==='SUCCEEDED'?200:202,result);
        }
        if(method==='GET'&&reportCreation[1]){
          const receipt=publishedReports.lookup(reportCreation[2],actorId);requireFundAgentReportOwner(receipt.source);return json(res,200,receipt);
        }
        if(method==='POST'&&reportCreation[4]){
          await readBody(req);requireFundAgentReportOwner(store.get('published_report_creation',reportCreation[3],PROJECT)?.input?.source);
          const result=publishedReports.advance(reportCreation[3],actorId);return json(res,result.status==='SUCCEEDED'?200:202,result);
        }
      }
      if (path === "/api/v2/reports/datasets" && method === "GET")
        return json(res, 200, reports.listDatasets().filter(canReadSyncDataset));
      if (path === "/api/v2/reports/datasets" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100);
        let fixedSource;
        if (isSyncAssetId(body.assetId)) {
          requireSyncSqlLocal(req);
          const batchId = publishedReportSourceBatchId(syncAssetBatchId(body.assetId));
          if (body.assetId !== "dataset:sync-holdings:" + batchId) throw fail(422,"请选择已核验的冻结持仓结果批次");
          const batch = get("release_run",batchId);
          requireDeliveryEvidence("release_run",batch);
          const evidence = certifySyncService(batch)?.sourceEvidence;
          if (!evidence) throw fail(409,"原冻结持仓批次未通过核对");
          const manual = evidence.developmentMode === "MANUAL";
          fixedSource = { publishedSource: {kind:manual?"MANUAL":"AGENT",releaseId:evidence.releaseId,packageDigest:evidence.packageDigest,
            revisionId:evidence.sourceRevisionId,runId:evidence.sourceRunId,batchId,...(!manual?{taskId:evidence.sourceTaskId}:{})},
            actorId:reportActor(req) };
        }
        const dedup = store.deduplicate(
            fixedSource ? `${PROJECT}:report-dataset:sync:${fixedSource.actorId}:${key}` : `${PROJECT}:report-dataset:${key}`,
            hash(JSON.stringify(body)),
            () => reports.createDataset(body,fixedSource),
          );
        const dataset = reports.datasetDetail(dedup.id);
        requireSyncDataset(dataset);
        return json(
          res,
          dedup.replayed ? 200 : 201,
          dataset,
        );
      }
      const reportDatasetRecord = path.match(
        /^\/api\/v2\/reports\/datasets\/([a-f0-9-]+)(?:\/(refresh))?$/,
      );
      if (reportDatasetRecord) {
        const dataset = reports.datasetDetail(reportDatasetRecord[1]),
          action = reportDatasetRecord[2];
        requireSyncDataset(dataset);
        if (method === "GET" && !action) return json(res, 200, dataset);
        if (method === "POST" && action === "refresh") {
          await readBody(req);
          const boundSource=dataset.publishedSource?resolveLocalReportSource(dataset.publishedSource,auth.sessionFromHeaders(req.headers)?.user.id??'local-engineer'):undefined;
          const asset = boundSource?.asset??assets.detail(dataset.assetId),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-dataset-refresh:${dataset.id}:${key}`,
              hash(
                JSON.stringify({
                  datasetId: dataset.id,
                  fields: dataset.fields,
                  assetEvidenceHash: asset.evidenceHash,
                }),
              ),
              () => reports.refreshDataset(dataset.id).currentSnapshot,
            );
          get("report_snapshot", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.datasetDetail(dataset.id));
        }
      }
      if (path === "/api/v2/reports" && method === "GET")
        return json(res, 200, reports.listReports().filter(canReadSyncReport));
      if (path === "/api/v2/reports" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100);
        if (typeof body.datasetId === "string") requireSyncDataset(store.get("report_dataset",body.datasetId,PROJECT));
        const dedup = store.deduplicate(
            `${PROJECT}:report:${key}`,
            hash(JSON.stringify(body)),
            () => reports.createReport(body),
          );
        const report = reports.reportDetail(dedup.id);
        if (!canReadSyncReport(report)) throw fail(404, "未找到本账号的冻结持仓报表");
        return json(
          res,
          dedup.replayed ? 200 : 201,
          report,
        );
      }
      if (path === "/api/v2/reports/agent/plans" && method === "GET") {
        const batchId=url.searchParams.has('source_batch_id')?publishedReportSourceBatchId(url.searchParams.get('source_batch_id')):undefined;
        if(batchId&&!local)throw fail(403,'同源报表规划仅供本机读取');
        return json(res,200,store.list('report_agent_plan',PROJECT).filter(p=>canReadReportPlan(p,req)).filter(p=>batchId?p.sourceBinding?.batchId===batchId&&p.submittedBy===reportActor(req):!p.sourceBinding).map(publicReportPlan));
      }
      const sourceReportRequest=path.match(/^\/api\/v2\/reports\/agent\/requests\/([A-Za-z0-9_-]{1,100})$/);
      if(sourceReportRequest&&method==='GET'){
        if(!local)throw fail(403,'同源报表原请求仅供本机读取');
        const id=store.deduplicatedId(`${PROJECT}:source-report-plan:${reportActor(req)}:${sourceReportRequest[1]}`),task=id?store.get('report_agent_plan',id,PROJECT):undefined;
        if(!task)throw fail(404,'未找到本账号的原报表规划请求');requireReportPlanOwner(task,req);return json(res,200,publicReportPlan(task));
      }
      if (path === "/api/v2/reports/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if(Object.keys(body).some(k=>!['message','source'].includes(k)))throw fail(422,'报表规划只接受需求和可选确切发布来源');
        const source=body.source===undefined?undefined:publishedReportSource(body.source),actor=reportActor(req);
        if (source) requireFundAgentReportOwner(source);
        const publication=source?publishedPlanContext(source,actor):undefined;
        if (!options.reportPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = source?sourceReportKey(req.headers["idempotency-key"]):text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            source?`${PROJECT}:source-report-plan:${actor}:${key}`:`${PROJECT}:report-agent-plan:${local?"":actor+":"}${key}`,
            hash(JSON.stringify({ message,...(source?{source}:{}) })),
            () =>
              store.create("report_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "REPORT_DESIGN",
                fullLifecycleE2E: false,
                ...(!local ? {contextScope:"INVITED_PROJECT_REPORTS",submittedBy:actor} : {}),
                ...(source?{...sourceReportInitial(privateRuntimeBootId),sourceBinding:source,submittedBy:actor,requestId:key,planMode:'PUBLISHED_SOURCE_REPORT_V1',sourceEvidenceHash:publication.sourceEvidenceHash,contextHash:publishedReportHash(publication)}:{}),
              }),
          ),
          task = get("report_agent_plan", dedup.id);
        if (!dedup.replayed&&source)scheduleSourceReport(task);
        if (!dedup.replayed&&!source)
          schedule("report_agent_plan", task, async (signal) => {
            const context = source ? {publication:publishedPlanContext(source,actor)} : (() => {
              const all = reports.agentContext();
              return {datasets:all.datasets.filter(dataset=>canReadSyncDataset(store.get("report_dataset",dataset.id,PROJECT))),
                reports:all.reports.filter(canReadSyncReport)};
            })(),
              generated = await reportPlanner({
                message,
                ...context,
                signal,
              });
            if (get("report_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = reports.validateAgentPlan(generated.plan);
            store.update("report_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, publicReportPlan(task));
      }
      const reportAgentPlan = path.match(
        /^\/api\/v2\/reports\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel|resume|clarification|clarify))?$/,
      );
      if (reportAgentPlan) {
        const plan = get("report_agent_plan", reportAgentPlan[1]),
          action = reportAgentPlan[2];
        requireReportPlanOwner(plan,req);
        if (method === "GET" && !action) return json(res, 200, publicReportPlan(plan));
        if(method==='GET'&&action==='clarification'){
          if(!local||!plan.sourceBinding)throw fail(403,'报表澄清仅供本机原所属人使用');
          return json(res,200,readReportClarification({store,project:PROJECT,planId:plan.id,actorId:reportActor(req),contextFor:publishedPlanContext}));
        }
        if(method==='POST'&&action==='clarify'){
          const body=await readBody(req);if(!local||!plan.sourceBinding||Object.keys(body).length!==2||!['evidenceDigest','answer'].every(k=>Object.hasOwn(body,k)))throw fail(422,'回答须绑定原问题摘要');
          const actor=reportActor(req),key=sourceReportKey(req.headers['idempotency-key']),resolved=deriveReportClarification({store,project:PROJECT,planId:plan.id,actorId:actor,contextFor:publishedPlanContext,...body});
          const dedup=store.deduplicate(`${PROJECT}:source-report-plan:${actor}:${key}`,reportClarificationSignature(plan.id,body.evidenceDigest,resolved.answer),()=>{
            if(!options.reportPlanner&&!modelSettings(env).configured)throw new ModelUnavailable();budget.assertCanStartModel();
            return store.create('report_agent_plan',PROJECT,{message:resolved.answer,status:'QUEUED',mode:'LIVE_MODEL',completionScope:'REPORT_DESIGN',fullLifecycleE2E:false,agentIndependentE2E:false,...sourceReportInitial(privateRuntimeBootId),sourceBinding:resolved.parent.sourceBinding,submittedBy:actor,requestId:key,planMode:'PUBLISHED_SOURCE_REPORT_V1',sourceEvidenceHash:resolved.parent.sourceEvidenceHash,contextHash:resolved.parent.contextHash,derivationKind:'REPORT_CLARIFICATION_V1',originPlanId:plan.id,clarification:resolved.frame});
          });
          const child=get('report_agent_plan',dedup.id);if(!dedup.replayed)scheduleSourceReport(child);return json(res,202,publicReportPlan(child));
        }

        if(method==='POST'&&action==='resume'){
          const body=await readBody(req),current=get('report_agent_plan',plan.id);requireReportPlanOwner(current,req);
          if(!local||!current.sourceBinding||Object.keys(body).length||!publicReportPlan(current).recovery?.canResume)throw fail(409,'仅能显式续接模型尚未调用的原报表规划；未知结果不重试');
          if(!options.reportPlanner&&!modelSettings(env).configured)throw new ModelUnavailable();
          assertReportClarificationPlan(current,{store,project:PROJECT,contextFor:publishedPlanContext});
          if(publishedReportHash(publishedPlanContext(current.sourceBinding,reportActor(req)))!==current.contextHash)throw fail(409,'原来源变化，未重新调用模型');
          const resumed=store.update('report_agent_plan',current.id,PROJECT,{...sourceReportInitial(privateRuntimeBootId),status:'QUEUED',resumeCount:(current.resumeCount??0)+1},{expectedVersion:current.version});scheduleSourceReport(resumed);return json(res,202,publicReportPlan(resumed));
        }
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if(plan.sourceBinding){
            if(['APPLIED','APPLYING'].includes(plan.status))throw fail(409,'方案已进入报表生成；取消规划不能撤销已有结果，请查询原方案');
            if(plan.status!=='CANCELLED')store.update('report_agent_plan',plan.id,PROJECT,{status:'CANCELLED',finishedAt:new Date().toISOString()});
            controls.get(plan.id)?.abort();return json(res,200,publicReportPlan(get('report_agent_plan',plan.id)));
          }
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("report_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("report_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          const body=await readBody(req);
          if(plan.sourceBinding){
            if(plan.executionMode==='SOURCE_BOUND_REPORT_AGENT_V1'&&plan.providerPhase!=='RECORDED')throw fail(409,'模型结果尚未确认，不能应用方案');
            if(Object.keys(body).some(k=>k!=='proposalHash')||body.proposalHash!==plan.proposalHash||!['SUCCEEDED','APPLYING','APPLIED'].includes(plan.status)||plan.proposal?.kind!=='PUBLISHED_REPORT'||
              reportProposalHash(plan,plan.proposal)!==plan.proposalHash)throw fail(409,'请先审阅并提交此确切同源报表方案摘要');
            assertReportClarificationPlan(plan,{store,project:PROJECT,contextFor:publishedPlanContext});
            const context=publishedPlanContext(plan.sourceBinding,reportActor(req));if(publishedReportHash(context)!==plan.contextHash)throw fail(409,'来源或指标定义已变化，请重新审阅方案');
            const created=publishedReports.submit({name:plan.proposal.name,source:plan.sourceBinding,metricIds:plan.proposal.metricIds},reportActor(req),plan.id,reviewedReportBasis(plan,reportActor(req),body.proposalHash));
            store.update('report_agent_plan',plan.id,PROJECT,{status:created.status==='SUCCEEDED'?'APPLIED':'APPLYING',reportCreation:created,...(created.reportId?{reportId:created.reportId}:{}),appliedAt:plan.appliedAt??new Date().toISOString()});return json(res,created.status==='SUCCEEDED'?200:202,created);
          }
          if (plan.status === "APPLIED" && plan.reportId)
            return json(res, 200, reports.reportDetail(plan.reportId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型报表方案验证通过后才能创建草稿");
          const proposal = reports.validateAgentPlan(plan.proposal),
            report = reports.createReport(proposal);
          store.update("report_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            reportId: report.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, report);
        }
      }
      const reportRecord = path.match(
        /^\/api\/v2\/reports\/([a-f0-9-]+)(?:\/(versions|run|export|provenance|wealth-consumption))?$/,
      );
      if (reportRecord) {
        if (method === 'GET' && reportRecord[2] === 'wealth-consumption') {
          if (!localClassicSpark || options.ingress || !isLoopbackRequest(req)) throw fail(403, '财富管理报表消费回看仅支持本机');
          if (url.searchParams.size !== 1 || !url.searchParams.has('run_id')) throw fail(422, '消费回看须选择一个确切报表运行');
          const reportId = publishedReportSourceBatchId(reportRecord[1]), runId = publishedReportSourceBatchId(url.searchParams.get('run_id'));
          return json(res, 200, readWealthReportConsumption({ store, reportStore, businessStore, project: PROJECT,
            reportId, runId, actor: reportActor(req), now: options.now?.() ?? Date.now() }));
        }
        const report = reports.reportDetail(reportRecord[1]),
          action = reportRecord[2];
        if (!canReadSyncReport(report)) throw fail(404, "未找到本账号的冻结持仓报表");
        if(method==='GET'&&action==='provenance'){
          if(!local)throw fail(403,'报表需求溯源尚仅在本机所属人边界开放');
          const query = url.searchParams;
          if ([...query.keys()].some(key => !['run_id', 'download_digest'].includes(key)) ||
              query.getAll('run_id').length !== 1 || query.getAll('download_digest').length > 1)
            throw fail(422, '溯源须选择一个确切报表运行');
          const runId = publishedReportSourceBatchId(query.get('run_id'));
          const downloadDigest = query.get('download_digest');
          if (downloadDigest !== null && !/^[a-f0-9]{64}$/.test(downloadDigest))
            throw fail(422, '下载须提供已核对的溯源摘要');
          const evidence = reportProvenance.read(report.id, runId, reportActor(req));
          if (downloadDigest === null) return json(res, 200, evidence);
          if (downloadDigest !== evidence.digest) throw fail(409, '溯源摘要已变化，请重新核对');
          return json(res, 200, evidence, {
            'Content-Disposition': `attachment; filename="shuduo-report-provenance-${runId.slice(0, 8)}.json"`,
          });
        }
        if (method === "GET" && !action) return json(res, 200, report);
        if (method === "GET" && action === "export")
          return json(res, 200, reports.exportReport(report.id));
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-version:${report.id}:${key}`,
              hash(JSON.stringify(body)),
              () => reports.createReportVersion(report.id, body).currentVersion,
            );
          get("report_version", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.reportDetail(report.id));
        }
        if (method === "POST" && action === "run") {
          await readBody(req);
          const current = reports.reportDetail(report.id),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-run:${report.id}:${key}`,
              hash(
                JSON.stringify({
                  reportId: report.id,
                  versionId: current.currentVersionId,
                  configHash: current.currentVersion.configHash,
                  datasetSnapshotId: current.currentVersion.datasetSnapshotId,
                }),
              ),
              () => reports.runReport(report.id).run,
            );
          get("report_run", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.reportDetail(report.id));
        }
      }
      const opsSession = () => auth.sessionFromHeaders(req.headers);
      const canReadOpsSource = (kind, item) => {
        if (kind === "report_run" && !canReadSyncReport(item)) return false;
        if (local) return true;
        if (kind === "release_run") return canReadDelivery(kind, item);
        if (kind === "report_run") return reports.canReadRun(item);
        if (kind === "run") return Boolean(item && mayReadRun(item, opsSession()));
        return true;
      };
      const canReadOpsDiagnosis = task => {
        const session = opsSession();
        return local || session?.role === "ADMIN" || Boolean(session?.permissions.includes("OPS") &&
          task.submittedBy === session.user.id &&
          (!task.diagnosis || operations.canReadIncident(store.get("ops_incident", task.diagnosis.incidentId, PROJECT), canReadOpsSource)));
      };
      if (path === "/api/v2/operations/overview" && method === "GET")
        return json(res, 200, {
          ...operations.overview(canReadOpsSource),
          externalModelContextAllowed: Boolean(
            options.opsPlanner ||
              env.V2_ALLOW_EXTERNAL_OPS_CONTEXT === "true",
          ),
        });
      if (path === "/api/v2/operations/refresh" && method === "POST") {
        await readBody(req);
        return json(res, 200, operations.refresh(canReadOpsSource));
      }
      if (path === "/api/v2/operations/incidents" && method === "GET")
        return json(res, 200, operations.listIncidents(canReadOpsSource));
      const opsIncidentRecord = path.match(
        /^\/api\/v2\/operations\/incidents\/([a-f0-9-]+)(?:\/(acknowledge|resolve))?$/,
      );
      if (opsIncidentRecord) {
        const incident = operations.incidentDetail(opsIncidentRecord[1], canReadOpsSource),
          action = opsIncidentRecord[2];
        if (method === "GET" && !action) return json(res, 200, incident);
        if (method === "POST" && ["acknowledge", "resolve"].includes(action)) {
          const body = await readBody(req);
          if (action === "resolve" && ["run","release_run","report_run"].includes(body.evidenceKind) &&
              !canReadOpsSource(body.evidenceKind, store.get(body.evidenceKind, body.evidenceId, PROJECT)))
            throw fail(403, "当前身份无权读取此恢复证据");
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:ops-incident:${incident.id}:${action}:${key}`,
              hash(JSON.stringify(body)),
              () =>
                action === "acknowledge"
                  ? operations.acknowledge(incident.id, body)
                  : operations.resolve(incident.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            operations.incidentDetail(dedup.id, canReadOpsSource),
          );
        }
      }
      if (path === "/api/v2/operations/agent/diagnoses" && method === "GET")
        return json(res, 200, store.list("ops_agent_diagnosis", PROJECT).filter(canReadOpsDiagnosis));
      if (path === "/api/v2/operations/agent/diagnoses" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!operations.listIncidents(canReadOpsSource).length)
          throw fail(409, "请先刷新并选择有实际证据的事故");
        if (
          !options.opsPlanner &&
          env.V2_ALLOW_EXTERNAL_OPS_CONTEXT !== "true"
        )
          throw fail(
            412,
            "运维摘要默认禁止发送到外部模型；需用户明确授权后设置V2_ALLOW_EXTERNAL_OPS_CONTEXT=true",
          );
        if (!options.opsPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const actorId = local ? undefined : opsSession().user.id;
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:ops-agent-diagnosis:${actorId ? actorId + ":" : ""}${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("ops_agent_diagnosis", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                ...(actorId ? {submittedBy:actorId} : {}),
                completionScope: "OPS_DIAGNOSIS",
                fullLifecycleE2E: false,
                executable: false,
              }),
          ),
          task = get("ops_agent_diagnosis", dedup.id);
        if (!dedup.replayed)
          schedule("ops_agent_diagnosis", task, async (signal) => {
            const context = operations.agentContext(canReadOpsSource),
              generated = await opsPlanner({
                message,
                ...context,
                signal,
              });
            if (get("ops_agent_diagnosis", task.id).status === "CANCELLED") return;
            const diagnosis = operations.validateAgentDiagnosis(
                generated.diagnosis, canReadOpsSource,
              );
            store.update("ops_agent_diagnosis", task.id, PROJECT, {
              status: "SUCCEEDED",
              diagnosis,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const opsAgentDiagnosis = path.match(
        /^\/api\/v2\/operations\/agent\/diagnoses\/([a-f0-9-]+)(?:\/(cancel))?$/,
      );
      if (opsAgentDiagnosis) {
        const task = get("ops_agent_diagnosis", opsAgentDiagnosis[1]),
          action = opsAgentDiagnosis[2];
        if (!canReadOpsDiagnosis(task)) throw fail(403, "当前身份无权查看此诊断");
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(task.status)) {
            store.update("ops_agent_diagnosis", task.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(task.id)?.abort();
          }
          return json(res, 200, get("ops_agent_diagnosis", task.id));
        }
      }
      if (method === "GET" && path === "/api/v2/evaluations/live-lifecycle/overview") {
        if (!local || options.ingress || !isLoopbackRequest(req))
          throw fail(403, "逐例验收记录仅在本机工作台读取");
        const query = url.searchParams;
        if ([...query.keys()].some(key => key !== "run_id") || query.getAll("run_id").length > 1)
          throw fail(422, "只接受一个原评测编号");
        try {
          return json(res, 200, liveLifecycleOverview(root, query.get("run_id") ?? undefined, {
            origin:new URL("http://" + req.headers.host).origin,
            executionFor:(definition, entry, parent, testHarness) => liveExecutionSnapshot(definition, entry, parent, {
              read:(kind, id) => store.get(kind, id, PROJECT), testHarness,
            }),
          }));
        } catch (error) {
          if ([404, 409, 422].includes(error.status)) throw error;
          throw fail(409, "本机评测记录无法核对，请保留原检查点");
        }
      }
      if (
        path === "/api/v2/evaluations/full-lifecycle/latest" &&
        method === "GET"
      ) {
        let report;
        try {
          report = JSON.parse(
            await readFile(
              join(root, ".v2-artifacts", "full-lifecycle", "latest.json"),
              "utf8",
            ),
          );
        } catch {
          throw fail(404, "尚无完整链路评测报告");
        }
        try {
          const evidence = JSON.parse(await readFile(join(root, "fixtures", "e2e", "m1-code-evidence.json"), "utf8"));
          return json(res, 200, verifyLifecycleReport(evidence, report));
        } catch {
          throw fail(409, "评测报告证据缺失、契约过期或汇总不一致，请保留原报告并重新核验");
        }
      }
      if (path === "/api/v2/settings/model-key" && method === "POST") {
        if (!local)
          throw fail(403, "公网模式禁止通过页面写入模型密钥");
        const body = await readBody(req);
        const configured = await saveLocalModelKey(root, env, body.apiKey);
        modelVerifiedAt = null;
        store.create("settings_audit", PROJECT, {
          action: "MODEL_KEY_SET",
          actor: "local-engineer",
        });
        return json(res, 200, configured);
      }
      if (path === "/api/v2/revisions" && method === "GET")
        return json(res, 200, store.list("revision", PROJECT).filter(item => mayReadRevision(item, auth.sessionFromHeaders(req.headers))));
      if (path === "/api/v2/runs" && method === "GET")
        return json(res, 200, await Promise.all(store.list("run", PROJECT).filter(item => mayReadRun(item, auth.sessionFromHeaders(req.headers))).map(async run => exposeDevelopmentRun(await reconcileDevelopment(run)))));
      if (path === "/api/v2/python/revisions" && method === "GET")
        return json(res, 200, store.list("python_revision", PROJECT).filter(item => mayReadRevision(item, auth.sessionFromHeaders(req.headers))));
      if (path === "/api/v2/python/revisions" && method === "POST") {
        const body = await readBody(req),
          code = text(body.code, 20, 20_000),
          context = getContext(text(body.contextId, 1, 80));
        if (!context) throw fail(400, "请选择有效Python数据上下文");
        if (isFundContext(context.id)) throw fail(422, "基金组合穿透仅支持本机经典 Spark SQL");
        if(context.outputContractId)throw fail(422,"分布契约当前仅支持本机经典Spark SQL开发");
        const key = text(req.headers["idempotency-key"], 1, 100);
        const existingPythonRevision = store.deduplicatedId(`${PROJECT}:python-revision:${key}`);
        if (existingPythonRevision) requireDevelopmentOwner("python_revision", get("python_revision", existingPythonRevision), req);
        const signature = hash(JSON.stringify({ code, contextId: context.id })),
          dedup = store.deduplicate(
            `${PROJECT}:python-revision:${key}`,
            signature,
            () =>
              store.create("python_revision", PROJECT, {
                author: local ? "local-engineer" : auth.sessionFromHeaders(req.headers).user.id,
                language: "PYTHON",
                code,
                codeHash: hash(code),
                contextId: context.id,
                source: "ENGINEER",
                executionScope: "LOCAL_RESTRICTED_PYTHON",
                publicDeployed: false,
              }),
          );
        const saved = get("python_revision", dedup.id);
        requireDevelopmentOwner("python_revision", saved, req);
        return json(res, dedup.replayed ? 200 : 201, saved);
      }
      if (path === "/api/v2/python/runs" && method === "GET")
        return json(res, 200, store.list("python_run", PROJECT).filter(item => mayReadRun(item, auth.sessionFromHeaders(req.headers), "python_revision")).map(exposeValidationRecord));
      if (path === "/api/v2/python/runs" && method === "POST") {
        if (!options.pythonRunner && !pythonRuntime.available)
          throw fail(503, "Python运行环境尚未就绪");
        const body = await readBody(req),
          revision = get(
            "python_revision",
            text(body.revisionId, 1, 80),
          ),
          context = getContext(revision.contextId);
        requireDevelopmentOwner("python_revision", revision, req);
        if (!context) throw fail(409, "Python版本绑定的数据上下文不存在");
        if (isFundContext(context.id)) throw fail(422, "基金组合穿透仅支持本机经典 Spark SQL");
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(
            JSON.stringify({
              revisionId: revision.id,
              codeHash: revision.codeHash,
              contextId: revision.contextId,
            }),
          ),
          dedup = store.deduplicate(
            `${PROJECT}:python-run:${key}`,
            signature,
            () =>
              store.create("python_run", PROJECT, {
                revisionId: revision.id,
                revisionHash: revision.codeHash,
                contextId: revision.contextId,
                validationContractId:validationFamily(revision.contextId).id,
                status: "QUEUED",
                engine: "CPython",
                executionScope: "LOCAL_RESTRICTED_PYTHON",
                publicDeployed: false,
              }),
          ),
          run = get("python_run", dedup.id);
        if (!dedup.replayed)
          schedule("python_run", run, async (signal) => {
            const result = await pythonRunner({
              code: revision.code,
              context,
              validationContexts: validationContextsFor(context.id),
              signal,
              timeoutMs: Number(env.V2_PYTHON_RUN_TIMEOUT_MS ?? 10_000),
            });
            if (get("python_run", run.id).status === "CANCELLED") return;
            if (
              !["SUCCEEDED", "FAILED", "VALIDATION_FAILED"].includes(
                result.status,
              )
            )
              throw new Error("Python执行器返回了无效状态");
            store.update("python_run", run.id, PROJECT, {
              ...result,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, dedup.replayed ? 200 : 202, exposeValidationRecord(run));
      }
      const pythonRunRoute = path.match(
        /^\/api\/v2\/python\/runs\/([a-f0-9-]+)(?:\/(cancel))?$/,
      );
      if (pythonRunRoute) {
        const run = get("python_run", pythonRunRoute[1]),
          action = pythonRunRoute[2];
        requireDevelopmentOwner("python_run", run, req);
        if (method === "GET" && !action) return json(res, 200, exposeValidationRecord(run));
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(run.status)) {
            store.update("python_run", run.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(run.id)?.abort();
          }
          return json(res, 200, exposeValidationRecord(get("python_run", run.id)));
        }
      }
      const agentRequestLookup=path.match(/^\/api\/v2\/agent\/requests\/([A-Za-z0-9_-]{1,100})(\/execution-evidence)?$/);
      if(agentRequestLookup&&method==="GET"){
        const session=auth.sessionFromHeaders(req.headers);
        if(!local&&!session)throw fail(403,"请先以原任务创建者身份登录");
        const actorId=session?.user.id??"local-engineer",key=agentRequestLookup[1];
        if (agentRequestLookup[2] && (local || url.searchParams.size))
          throw fail(local ? 403 : 422, "云端执行证据只接受原创建请求编号");
        const ids = new Set([
          store.deduplicatedId(`${PROJECT}:durable-agent:${actorId}:${key}`),
          local ? store.deduplicatedId(`${PROJECT}:agent:${key}`) : undefined,
        ].filter(Boolean));
        if (ids.size > 1) throw fail(409, "原创建请求有冲突的任务回执");
        const [id] = ids;
        const task=id?store.get("agent",id,PROJECT):undefined;
        if(!task)throw fail(404,"未找到当前身份的原创建请求");
        requireDurableAgentOwner(task,req);
        if (agentRequestLookup[2]) {
          if (task.submittedBy !== actorId) throw fail(403, "云端执行证据仅原任务创建者可读");
          return json(res,200,storedAgentExecutionEvidence(task,(kind,id)=>store.get(kind,id,PROJECT)));
        }
        return json(res,200,exposeDurableTask(task));
      }
      if (path === "/api/v2/agent/tasks" && method === "GET")
        return json(res, 200, store.list("agent", PROJECT)
          .filter(task => mayReadDurableAgent(task, auth.sessionFromHeaders(req.headers)))
          .map(exposeDurableTask));
      const clarificationSourceRoute=path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/clarification-source$/);
      if(clarificationSourceRoute&&method==='GET'){
        const parent=get('agent',clarificationSourceRoute[1]);requireDurableAgentOwner(parent,req);
        return json(res,200,readSqlClarificationSource({store,project:PROJECT,taskId:parent.id,actorId:auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined)}));
      }
      const backgroundRoute=path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/background(?:\/(cancel|resume))?$/);
      if(backgroundRoute){
        const task=get("agent",backgroundRoute[1]);requireDurableAgentOwner(task,req);
        if(!agentEventDriver)throw Object.assign(fail(503,"云端事件后台未启用"),{code:"AGENT_EVENT_DRIVER_DISABLED"});
        if(method==="GET"&&!backgroundRoute[2])return json(res,200,agentEventDriver.status(task.id));
        if(method==="POST"){
          const body=await readBody(req),actor=auth.sessionFromHeaders(req.headers)?.user.id;
          if(backgroundRoute[2]==="resume"){
            if(Object.keys(body).some(k=>!["expectedVersion","confirmModelRetry"].includes(k)))throw fail(422,"恢复后台请求字段不受支持");
            const window = developmentBackgroundWindow(developmentAccess, developmentNow());
            return json(res,202,await agentEventDriver.resume(task.id,actor,{...body,...window,
              developmentBoundary:developmentBackgroundBoundary(developmentAccess,task.id,developmentNow())}));
          }
          if(backgroundRoute[2]==="cancel"){
            if(Object.keys(body).length)throw fail(422,"停止后台请求不接受额外字段");
            return json(res,200,await agentEventDriver.cancel(task.id,actor,{developmentBoundary:developmentBackgroundBoundary(developmentAccess,task.id,developmentNow())}));
          }
          if(Object.keys(body).some(k=>!["expectedVersion","maxEvents","durationMs"].includes(k)))throw fail(422,"后台请求字段不受支持");
          const window = ingressChannel === 'HTTP' ? developmentBackgroundWindow(developmentAccess, options.now?.() ?? Date.now(), body) : {};
          return json(res,202,await agentEventDriver.enable(task.id,actor,{...body,...window,
            developmentBoundary:developmentBackgroundBoundary(developmentAccess,task.id,developmentNow())}));
        }
      }
      const durableAdvance = path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/advance$/);
      if (durableAdvance && method === "POST") {
        const task = get("agent", durableAdvance[1]);
        requireDurableAgentOwner(task, req);
        if (!durableAgent) throw fail(503, "持久 Agent 推进接口尚未启用");
        if(agentEventDriver?.status(task.id).status==="ACTIVE")throw Object.assign(fail(409,"请先停止云后台推进，再人工接管"),{code:"AGENT_BACKGROUND_TAKEOVER_REQUIRED"});
        const body = await readBody(req);
        if (Object.keys(body).some(k => !["expectedVersion", "confirmModelRetry"].includes(k)) ||
            (body.confirmModelRetry !== undefined && typeof body.confirmModelRetry !== "boolean"))
          throw fail(422, "恢复请求包含无效字段");
        await durableAgent.advance(task.id, body);
        return json(res, 200, exposeDurableTask(get("agent",task.id)));
      }
      if (path === "/api/v2/agent/tools" && method === "GET")
        return json(res, 200, publicAgentToolCatalog());
      const agentToolValidation = path.match(
        /^\/api\/v2\/agent\/tools\/([a-z-]+)\/validate$/,
      );
      if (agentToolValidation && method === "POST") {
        const body = await readBody(req),
          keys = Object.keys(body);
        if (
          keys.some(
            (key) =>
              !["catalogVersion", "contractDigest", "input"].includes(key),
          )
        )
          throw Object.assign(fail(422, "工具校验请求包含未声明字段"), {
            code: "AGENT_TOOL_VALIDATION_REQUEST_INVALID",
          });
        return json(
          res,
          200,
          validateAgentToolInput(agentToolValidation[1], body.input, {
            version: body.catalogVersion,
            contractDigest: body.contractDigest,
          }),
        );
      }
      const agentToolInvocation = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/tools\/([a-z-]+)\/invoke$/,
      );
      if (agentToolInvocation && method === "POST") {
        const intent = get("agent_intent", agentToolInvocation[1]),
          destinationId = agentToolInvocation[2],
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号调用专业Agent"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能调用该专业Agent任务"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        if (intent.status !== "SUCCEEDED" || !intent.route)
          throw Object.assign(fail(409, "只有已完成理解的Agent任务可以调用工具"), {
            code: "AGENT_INTENT_NOT_READY",
          });
        if (intent.approvalMode !== "REQUEST_APPROVAL")
          throw Object.assign(fail(409, "仅规划模式不能调用专业Agent工具"), {
            code: "PLAN_ONLY_EXECUTION_DENIED",
          });
        const body = await readBody(req),
          keys = Object.keys(body);
        if (
          keys.some(
            (key) =>
              ![
                "catalogVersion",
                "contractDigest",
                "approvalId",
                "input",
              ].includes(key),
          )
        )
          throw Object.assign(fail(422, "工具调用请求包含未声明字段"), {
            code: "AGENT_TOOL_INVOCATION_REQUEST_INVALID",
          });
        const catalog = publicAgentToolCatalog(),
          tool = catalog.tools.find((item) => item.id === destinationId),
          steps = intent.route.steps ?? [
            {
              destinationId: intent.route.destinationId,
              objective: intent.route.summary,
              risk: intent.route.destination.risk,
            },
          ],
          step = steps.find((item) => item.destinationId === destinationId),
          approvalId = text(body.approvalId, 1, 80),
          approval = store.get("agent_intent_approval", approvalId, PROJECT),
          boundHandoff = store
            .list("agent_intent_handoff", PROJECT)
            .find(
              (item) =>
                item.intentId === intent.id &&
                item.destinationId === destinationId &&
                item.approvalId === approvalId &&
                item.specialistTaskId &&
                item.specialistTaskKind,
            );
        text(req.headers["idempotency-key"], 1, 100);
        if (!tool || !step)
          throw Object.assign(fail(422, "只能调用当前Agent推荐链路中的专业工具"), {
            code: "AGENT_TOOL_NOT_IN_ROUTE",
          });
        validateAgentToolInput(destinationId, body.input, {
          version: body.catalogVersion,
          contractDigest: body.contractDigest,
        });
        if(destinationId==='reports'&&(intent.reportSource||body.input.source)){
          if(!intent.reportSource||!body.input.source||!samePublishedReportSource(intent.reportSource,body.input.source))throw Object.assign(fail(409,'报表工具来源须与原意图保存的发布上下文一致'),{code:'AGENT_REPORT_SOURCE_MISMATCH'});
          publishedPlanContext(body.input.source,reportActor(req));
        }
        if (
          !approval ||
          approval.intentId !== intent.id ||
          approval.destinationId !== destinationId ||
          approval.objectiveHash !== hash(step.objective) ||
          !(
            approval.status === "APPROVED" ||
            (approval.status === "BOUND" && boundHandoff)
          )
        )
          throw Object.assign(fail(409, "工具调用必须绑定当前步骤的有效批准"), {
            code: "AGENT_STEP_APPROVAL_REQUIRED",
          });
        if (
          ["MESSAGE", "CODE_DEVELOPMENT"].includes(tool.createMode) &&
          body.input.message !== step.objective
        )
          throw Object.assign(fail(409, "工具输入与已批准的步骤目标不一致"), {
            code: "AGENT_TOOL_OBJECTIVE_MISMATCH",
          });
        if (tool.createMode === "DELIVERY_FROM_DEVELOPMENT") {
          const sourceHandoff = store
              .list("agent_intent_handoff", PROJECT)
              .filter(
                (item) =>
                  item.intentId === intent.id &&
                  item.destinationId === tool.requiresDestination &&
                  item.specialistTaskId &&
                  item.specialistTaskKind,
              )
              .sort((a, b) =>
                String(a.createdAt).localeCompare(String(b.createdAt)),
              )
              .at(-1),
            sourceTask = sourceHandoff?.specialistTaskId
              ? store.get(
                  sourceHandoff.specialistTaskKind,
                  sourceHandoff.specialistTaskId,
                  PROJECT,
                )
              : undefined;
          if (
            !sourceHandoff ||
            sourceHandoff.specialistTaskId !== body.input.sourceTaskId ||
            sourceTask?.status !== "SUCCEEDED"
          )
            throw Object.assign(
              fail(409, "交付准备必须引用当前任务图已完成的数据开发任务"),
              { code: "AGENT_TOOL_DEPENDENCY_NOT_READY" },
            );
        }
        const toolInputHash = hash(JSON.stringify(body.input));
        if (approval.status === "BOUND") {
          if (
            boundHandoff.toolCatalogVersion !== catalog.version ||
            boundHandoff.toolContractDigest !== catalog.contractDigest
          )
            throw Object.assign(fail(409, "已绑定工具任务使用旧版工具契约"), {
              code: "AGENT_TOOL_BOUND_CONTRACT_MISMATCH",
            });
          if (boundHandoff.toolInputHash !== toolInputHash)
            throw Object.assign(fail(409, "已绑定工具任务不能改用其他输入重放"), {
              code: "AGENT_TOOL_BOUND_INPUT_MISMATCH",
            });
          const specialist = get(
              boundHandoff.specialistTaskKind,
              boundHandoff.specialistTaskId,
            ),
            completedInvocation = store
              .list("agent_tool_invocation", PROJECT)
              .find((item) => item.handoffId === boundHandoff.id),
            detailPath = tool.detailPath.replace(
              "{id}",
              encodeURIComponent(specialist.id),
            );
          return json(res, 200, {
            catalogVersion: catalog.version,
            contractDigest: catalog.contractDigest,
            toolId: destinationId,
            specialist: {
              id: specialist.id,
              kind: boundHandoff.specialistTaskKind,
              status: specialist.status,
              detailPath,
              completionScope: specialist.completionScope,
              fullLifecycleE2E: false,
              publicDeployed: false,
            },
            handoff: publicAgentHandoff(boundHandoff),
            graph: agentIntentGraph(intent),
            invocation: completedInvocation
              ? {
                  id: completedInvocation.id,
                  status: completedInvocation.status,
                }
              : undefined,
          });
        }
        const invocationKey = `${intent.id}:${destinationId}:${approval.objectiveHash}:${approval.id}`,
          existingInvocation = store
            .list("agent_tool_invocation", PROJECT)
            .find((item) => item.invocationKey === invocationKey);
        if (
          existingInvocation &&
          existingInvocation.toolInputHash !== toolInputHash
        )
          throw Object.assign(fail(409, "同一步骤已有不同输入的工具调用"), {
            code: "AGENT_TOOL_INVOCATION_INPUT_CONFLICT",
          });
        if (
          existingInvocation &&
          (existingInvocation.toolCatalogVersion !== catalog.version ||
            existingInvocation.toolContractDigest !== catalog.contractDigest)
        )
          throw Object.assign(fail(409, "未完成工具调用使用旧版工具契约"), {
            code: "AGENT_TOOL_INVOCATION_CONTRACT_MISMATCH",
          });
        const nowMs = options.now?.() ?? Date.now();
        if (
          existingInvocation?.status === "CLAIMED" &&
          nowMs - Date.parse(existingInvocation.claimedAt) < 30_000
        )
          throw Object.assign(fail(409, "专业Agent工具调用正在处理中"), {
            code: "AGENT_TOOL_INVOCATION_IN_PROGRESS",
          });
        const restarting = ["INTERRUPTED", "FAILED", "CANCELLED"].includes(
            existingInvocation?.status,
          ),
          priorSpecialistIds = existingInvocation?.specialistTaskId
            ? [
                ...(existingInvocation.previousSpecialistTaskIds ?? []),
                existingInvocation.specialistTaskId,
              ]
            : existingInvocation?.previousSpecialistTaskIds ?? [],
          invocation = existingInvocation
          ? store.update(
              "agent_tool_invocation",
              existingInvocation.id,
              PROJECT,
              {
                status:
                  existingInvocation.status === "TASK_CREATED"
                    ? "TASK_CREATED"
                    : "CLAIMED",
                attempt:
                  Number(existingInvocation.attempt ?? 1) +
                  (restarting ? 1 : 0),
                claimedAt: new Date(nowMs).toISOString(),
                ...(restarting
                  ? {
                      specialistTaskId: null,
                      specialistTaskKind: null,
                      previousSpecialistTaskIds: priorSpecialistIds,
                    }
                  : {}),
              },
            )
          : store.create("agent_tool_invocation", PROJECT, {
              invocationKey,
              intentId: intent.id,
              destinationId,
              approvalId: approval.id,
              objectiveHash: approval.objectiveHash,
              toolCatalogVersion: catalog.version,
              toolContractDigest: catalog.contractDigest,
              toolInputHash,
              status: "CLAIMED",
              attempt: 1,
              claimedAt: new Date(nowMs).toISOString(),
            });
        if (typeof persistence.flush === "function")
          await persistence.flush();
        const createPath = tool.createPath.replace(
            "{sourceTaskId}",
            encodeURIComponent(body.input.sourceTaskId ?? ""),
          ),
          createBody =
            tool.createMode === "DELIVERY_FROM_DEVELOPMENT" ? {} : body.input,
          atomicKey = hash(
            invocationKey + ":" + toolInputHash + ":" + invocation.attempt,
          );
        let specialist;
        if (invocation.specialistTaskId) {
          specialist = get(
            invocation.specialistTaskKind,
            invocation.specialistTaskId,
          );
        } else {
          try {
            specialist = (
              await callAtomicApi(
                req,
                createPath,
                createBody,
                `agent-tool-${atomicKey.slice(0, 48)}`,
              )
            ).body;
          } catch (error) {
            store.update("agent_tool_invocation", invocation.id, PROJECT, {
              status: "FAILED",
              failedAt: new Date().toISOString(),
              errorCode:
                typeof error.code === "string"
                  ? error.code
                  : "AGENT_ATOMIC_API_FAILED",
            });
            throw error;
          }
        }
        if (
          !specialist ||
          typeof specialist.id !== "string" ||
          typeof specialist.status !== "string" ||
          specialist.fullLifecycleE2E === true
        )
          throw Object.assign(fail(502, "专业Agent返回了不受支持的资源"), {
            code: "AGENT_TOOL_OUTPUT_INVALID",
          });
        store.update("agent_tool_invocation", invocation.id, PROJECT, {
          status: "TASK_CREATED",
          specialistTaskId: specialist.id,
          specialistTaskKind: agentSpecialistKinds[destinationId],
          taskCreatedAt: new Date().toISOString(),
        });
        if (typeof persistence.flush === "function")
          await persistence.flush();
        const handoffResponse = await callAtomicApi(
            req,
            `/agent/intents/${encodeURIComponent(intent.id)}/handoffs`,
            {
              destinationId,
              specialistTaskId: specialist.id,
              approvalId: approval.id,
            },
            `agent-handoff-${atomicKey.slice(0, 48)}`,
          ),
          recordedHandoff = store.update(
            "agent_intent_handoff",
            handoffResponse.body.id,
            PROJECT,
            {
              toolCatalogVersion: catalog.version,
              toolContractDigest: catalog.contractDigest,
              toolInputHash,
            },
          ),
          completedInvocation = store.update(
            "agent_tool_invocation",
            invocation.id,
            PROJECT,
            {
              status: "BOUND",
              handoffId: recordedHandoff.id,
              boundAt: new Date().toISOString(),
            },
          ),
          detailPath = tool.detailPath.replace(
            "{id}",
            encodeURIComponent(specialist.id),
          );
        return json(
          res,
          handoffResponse.status === 200 ? 200 : 201,
          {
            catalogVersion: catalog.version,
            contractDigest: catalog.contractDigest,
            toolId: destinationId,
            specialist: {
              id: specialist.id,
              kind: agentSpecialistKinds[destinationId],
              status: specialist.status,
              detailPath,
              completionScope: specialist.completionScope,
              fullLifecycleE2E: false,
              publicDeployed: false,
            },
            handoff: publicAgentHandoff(recordedHandoff),
            graph: agentIntentGraph(intent),
            invocation: {
              id: completedInvocation.id,
              status: completedInvocation.status,
            },
          },
        );
      }
      if (path === "/api/v2/agent/intents" && method === "GET") {
        const session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(
            fail(401, "请先登录受邀账号查看Agent任务"),
            { code: "AUTHENTICATION_REQUIRED" },
          );
        const items = store.list("agent_intent", PROJECT);
        return json(
          res,
          200,
          items.filter((item) => mayReadAgentIntent(item, session)).map(publicAgentIntent),
        );
      }
      const agentIntentTrace = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/trace$/,
      );
      if (agentIntentTrace && method === "GET") {
        const intent = get("agent_intent", agentIntentTrace[1]),
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号查看Agent轨迹"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能查看该Agent轨迹"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        return json(
          res,
          200,
          store
            .list("agent_intent_trace", PROJECT)
            .filter((item) => item.intentId === intent.id)
            .sort((a, b) => a.sequence - b.sequence),
        );
      }
      const agentIntentGraphRoute = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/graph$/,
      );
      if (agentIntentGraphRoute && method === "GET") {
        const intent = get("agent_intent", agentIntentGraphRoute[1]),
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号查看Agent任务图"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能查看该Agent任务图"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        return json(res, 200, agentIntentGraph(intent));
      }
      const agentIntentCancelRoute = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/cancel$/,
      );
      if (agentIntentCancelRoute && method === "POST") {
        const intent = get("agent_intent", agentIntentCancelRoute[1]),
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号停止Agent任务"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能停止该Agent任务"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        await readBody(req);
        if (intent.status === "CANCELLED")
          return json(res, 200, publicAgentIntent(intent));
        if (!["QUEUED", "RUNNING", "SUCCEEDED"].includes(intent.status))
          throw Object.assign(fail(409, "当前Agent任务状态不能停止"), {
            code: "AGENT_INTENT_NOT_CANCELLABLE",
          });
        const linked = store
          .list("agent_intent_handoff", PROJECT)
          .filter(
            (item) =>
              item.intentId === intent.id &&
              typeof item.specialistTaskId === "string",
          );
        if (linked.length > 0)
          throw Object.assign(
            fail(409, "已有专业Agent任务，必须按子任务分别检查或取消"),
            { code: "AGENT_CHILD_TASKS_REQUIRE_SEPARATE_CONTROL" },
          );
        for (const approval of store
          .list("agent_intent_approval", PROJECT)
          .filter(
            (item) =>
              item.intentId === intent.id && item.status === "APPROVED",
          ))
          store.update("agent_intent_approval", approval.id, PROJECT, {
            status: "REVOKED",
            revokedAt: new Date().toISOString(),
          });
        const cancelled = store.update("agent_intent", intent.id, PROJECT, {
          status: "CANCELLED",
          cancelledAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        });
        controls.get(intent.id)?.abort();
        const latestTrace = store
          .list("agent_intent_trace", PROJECT)
          .filter((item) => item.intentId === intent.id)
          .sort((a, b) => a.sequence - b.sequence)
          .at(-1);
        store.create("agent_intent_trace", PROJECT, {
          intentId: intent.id,
          sequence: Number(latestTrace?.sequence ?? 0) + 1,
          kind: "INTENT_CANCELLED",
          status: "CANCELLED",
          execution: "NO_EXECUTION",
          observedAt: new Date().toISOString(),
        });
        return json(res, 200, publicAgentIntent(cancelled));
      }
      const agentChildCancelRoute = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/children\/([a-z-]+)\/cancel$/,
      );
      if (agentChildCancelRoute && method === "POST") {
        const intent = get("agent_intent", agentChildCancelRoute[1]),
          destinationId = agentChildCancelRoute[2],
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号取消专业Agent任务"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能取消该专业Agent任务"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        await readBody(req);
        const handoff = store
            .list("agent_intent_handoff", PROJECT)
            .filter(
              (item) =>
                item.intentId === intent.id &&
                item.destinationId === destinationId &&
                item.specialistTaskId &&
                item.specialistTaskKind,
            )
            .sort((a, b) =>
              String(a.createdAt).localeCompare(String(b.createdAt)),
            )
            .at(-1),
          invocation = store
            .list("agent_tool_invocation", PROJECT)
            .filter(
              (item) =>
                item.intentId === intent.id &&
                item.destinationId === destinationId &&
                item.specialistTaskId &&
                item.specialistTaskKind,
            )
            .sort((a, b) =>
              String(a.createdAt).localeCompare(String(b.createdAt)),
            )
            .at(-1),
          invocationIsNewer =
            invocation &&
            (!handoff ||
              String(invocation.createdAt).localeCompare(
                String(handoff.createdAt),
              ) > 0),
          specialistTaskId =
            (invocationIsNewer ? invocation?.specialistTaskId : undefined) ??
            handoff?.specialistTaskId,
          specialistTaskKind =
            (invocationIsNewer ? invocation?.specialistTaskKind : undefined) ??
            handoff?.specialistTaskKind;
        if (!specialistTaskId || !specialistTaskKind)
          throw Object.assign(fail(404, "当前步骤没有可控制的专业Agent任务"), {
            code: "AGENT_CHILD_TASK_NOT_FOUND",
          });
        const child = get(specialistTaskKind, specialistTaskId);
        if (child.status === "CANCELLED")
          return json(res, 200, {
            child: {
              id: child.id,
              kind: specialistTaskKind,
              status: child.status,
            },
            graph: agentIntentGraph(intent),
          });
        const durableChild = specialistTaskKind === "agent" && child.executionMode === durableSqlAgentMode;
        if (!durableChild && !["QUEUED", "RUNNING"].includes(child.status))
          throw Object.assign(fail(409, "当前专业Agent任务已结束，不能取消"), {
            code: "AGENT_CHILD_TASK_NOT_CANCELLABLE",
          });
        if (durableChild) {
          requireDurableAgentOwner(child, req);
          if (!durableAgent) throw fail(503, "持久 Agent 取消接口尚未启用");
          if (!["QUEUED", "RUNNING", "INTERRUPTED"].includes(child.status)) throw fail(409, "任务已结束，不能取消");
          await durableAgent.cancel(child.id);
        } else store.update(specialistTaskKind, child.id, PROJECT, {
          status: "CANCELLED",
          finishedAt: new Date().toISOString(),
        });
        if (invocationIsNewer && invocation)
          store.update("agent_tool_invocation", invocation.id, PROJECT, {
            status: "CANCELLED",
            cancelledAt: new Date().toISOString(),
          });
        controls.get(child.id)?.abort();
        const latestTrace = store
          .list("agent_intent_trace", PROJECT)
          .filter((item) => item.intentId === intent.id)
          .sort((a, b) => a.sequence - b.sequence)
          .at(-1);
        store.create("agent_intent_trace", PROJECT, {
          intentId: intent.id,
          sequence: Number(latestTrace?.sequence ?? 0) + 1,
          kind: "SPECIALIST_CANCELLED",
          status: "CANCELLED",
          output: {
            destinationId,
            specialistTaskId: child.id,
            specialistTaskKind,
          },
          execution: "SPECIALIST_TASK_CANCELLED",
          observedAt: new Date().toISOString(),
        });
        return json(res, 200, {
          child: {
            id: child.id,
            kind: specialistTaskKind,
            status: "CANCELLED",
          },
          graph: agentIntentGraph(intent),
        });
      }
      const agentIntentApprovals = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/approvals$/,
      );
      if (agentIntentApprovals) {
        const intent = get("agent_intent", agentIntentApprovals[1]),
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号查看Agent批准"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能查看或批准该Agent任务"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        if (method === "GET")
          return json(
            res,
            200,
            store
              .list("agent_intent_approval", PROJECT)
              .filter((item) => item.intentId === intent.id)
              .map(publicAgentApproval),
          );
        if (method === "POST") {
          if (intent.status !== "SUCCEEDED" || !intent.route)
            throw fail(409, "只有已完成理解的Agent任务可以批准步骤");
          if (intent.approvalMode !== "REQUEST_APPROVAL")
            throw Object.assign(fail(409, "仅规划模式不能批准或执行专业步骤"), {
              code: "PLAN_ONLY_EXECUTION_DENIED",
            });
          const body = await readBody(req),
            destinationId = text(body.destinationId, 1, 80),
            steps = intent.route.steps ?? [
              {
                destinationId: intent.route.destinationId,
                objective: intent.route.summary,
                risk: intent.route.destination.risk,
              },
            ],
            step = steps.find((item) => item.destinationId === destinationId);
          if (!step)
            throw fail(422, "只能批准当前Agent推荐链路中的专业步骤");
          const objectiveHash = hash(step.objective),
            existing = store
              .list("agent_intent_approval", PROJECT)
              .find(
                (item) =>
                  item.intentId === intent.id &&
                  item.destinationId === destinationId &&
                  item.objectiveHash === objectiveHash &&
                  item.status === "APPROVED",
              );
          if (existing) return json(res, 200, publicAgentApproval(existing));
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:agent-intent-approval:${intent.id}:${key}`,
              hash(JSON.stringify({ destinationId, objectiveHash })),
              () =>
                store.create("agent_intent_approval", PROJECT, {
                  intentId: intent.id,
                  destinationId,
                  objectiveHash,
                  risk: step.risk ?? "HIGH",
                  status: "APPROVED",
                  submittedBy: session?.user.id ?? "local-engineer",
                  approvedAt: new Date().toISOString(),
                  execution: "NO_EXECUTION",
                  fullLifecycleE2E: false,
                  publicDeployed: false,
                }),
            );
          if (!dedup.replayed) {
            const latestTrace = store
              .list("agent_intent_trace", PROJECT)
              .filter((item) => item.intentId === intent.id)
              .sort((a, b) => a.sequence - b.sequence)
              .at(-1);
            store.create("agent_intent_trace", PROJECT, {
              intentId: intent.id,
              sequence: Number(latestTrace?.sequence ?? 0) + 1,
              kind: "STEP_APPROVAL",
              status: "APPROVED",
              output: { destinationId, objectiveHash, risk: step.risk },
              execution: "NO_EXECUTION",
              observedAt: new Date().toISOString(),
            });
          }
          return json(
            res,
            dedup.replayed ? 200 : 201,
            publicAgentApproval(get("agent_intent_approval", dedup.id)),
          );
        }
      }
      const agentIntentHandoff = path.match(
        /^\/api\/v2\/agent\/intents\/([a-f0-9-]+)\/handoffs$/,
      );
      if (agentIntentHandoff) {
        const intent = get("agent_intent", agentIntentHandoff[1]),
          session = auth.sessionFromHeaders(req.headers);
        if (!local && !session)
          throw Object.assign(fail(401, "请先登录受邀账号查看Agent交接"), {
            code: "AUTHENTICATION_REQUIRED",
          });
        if (!mayReadAgentIntent(intent, session))
          throw Object.assign(fail(403, "当前成员不能查看或交接该Agent任务"), {
            code: "PROJECT_PERMISSION_DENIED",
          });
        if (method === "GET")
          return json(
            res,
            200,
            store
              .list("agent_intent_handoff", PROJECT)
              .filter((item) => item.intentId === intent.id)
              .map(publicAgentHandoff),
          );
        if (method === "POST") {
          if (intent.status !== "SUCCEEDED" || !intent.route)
            throw fail(409, "只有已完成理解的Agent任务可以交接");
          const body = await readBody(req),
            destinationId = text(body.destinationId, 1, 80),
            steps = intent.route.steps ?? [
              {
                destinationId: intent.route.destinationId,
                objective: intent.route.summary,
              },
            ],
            step = steps.find((item) => item.destinationId === destinationId);
          if (!step)
            throw fail(422, "只能交接到当前Agent推荐链路中的专业模块");
          const specialistTaskId = body.specialistTaskId === undefined
              ? undefined
              : text(body.specialistTaskId, 1, 80),
            specialistTaskKind = agentSpecialistKinds[destinationId],
            approvalId = body.approvalId === undefined
              ? undefined
              : text(body.approvalId, 1, 80);
          if (!specialistTaskId) {
            const existing = store
              .list("agent_intent_handoff", PROJECT)
              .find(
                (item) =>
                  item.intentId === intent.id &&
                  item.destinationId === destinationId &&
                  !item.specialistTaskId,
              );
            if (existing)
              return json(res, 200, publicAgentHandoff(existing));
          }
          if (specialistTaskId && !specialistTaskKind)
            throw fail(422, "当前专业能力不支持任务关联");
          if (specialistTaskId) {
            const existing = store
              .list("agent_intent_handoff", PROJECT)
              .find(
                (item) =>
                  item.intentId === intent.id &&
                  item.destinationId === destinationId &&
                  item.specialistTaskId === specialistTaskId &&
                  item.approvalId === approvalId,
              );
            if (existing)
              return json(res, 200, publicAgentHandoff(existing));
          }
          if (
            specialistTaskId &&
            !store.get(specialistTaskKind, specialistTaskId, PROJECT)
          )
            throw fail(409, "专业Agent任务不存在或不属于当前项目");
          let approval;
          if (specialistTaskId) {
            if (intent.approvalMode !== "REQUEST_APPROVAL")
              throw Object.assign(fail(409, "仅规划模式不能关联已执行的专业任务"), {
                code: "PLAN_ONLY_EXECUTION_DENIED",
              });
            approval = approvalId
              ? store.get("agent_intent_approval", approvalId, PROJECT)
              : undefined;
            if (
              !approval ||
              approval.intentId !== intent.id ||
              approval.destinationId !== destinationId ||
              approval.objectiveHash !== hash(step.objective) ||
              approval.status !== "APPROVED"
            )
              throw Object.assign(fail(409, "专业Agent任务必须绑定当前步骤的有效批准"), {
                code: "AGENT_STEP_APPROVAL_REQUIRED",
              });
          }
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:agent-intent-handoff:${intent.id}:${key}`,
              hash(JSON.stringify({ destinationId, objective: step.objective, specialistTaskId, approvalId })),
              () =>
            store.create("agent_intent_handoff", PROJECT, {
                  intentId: intent.id,
                  destinationId,
                  objective: step.objective,
                  ...(specialistTaskId
                    ? { specialistTaskId, specialistTaskKind, approvalId }
                    : {}),
                  status: "HANDED_OFF",
                  submittedBy: session?.user.id ?? "local-engineer",
                  scope: "SPECIALIST_AGENT_DRAFT_ONLY",
                  execution: "NO_EXECUTION",
                  fullLifecycleE2E: false,
                  publicDeployed: false,
                  handedOffAt: new Date().toISOString(),
                }),
            );
          if (!dedup.replayed) {
            if (approval)
              store.update("agent_intent_approval", approval.id, PROJECT, {
                status: "BOUND",
                specialistTaskId,
                specialistTaskKind,
                boundAt: new Date().toISOString(),
              });
            const latestTrace = store
              .list("agent_intent_trace", PROJECT)
              .filter((item) => item.intentId === intent.id)
              .sort((a, b) => a.sequence - b.sequence)
              .at(-1);
            store.create("agent_intent_trace", PROJECT, {
              intentId: intent.id,
              sequence: Number(latestTrace?.sequence ?? 0) + 1,
              kind: "SPECIALIST_HANDOFF",
              status: "RECORDED",
              output: {
                destinationId,
                objectiveHash: hash(step.objective),
              },
              execution: "NO_EXECUTION",
              observedAt: new Date().toISOString(),
            });
          }
          return json(
            res,
            dedup.replayed ? 200 : 201,
            publicAgentHandoff(get("agent_intent_handoff", dedup.id)),
          );
        }
      }
      if (path === "/api/v2/delivery/packages" && method === "GET")
        return json(
          res,
          200,
          visibleDelivery("delivery_package").map(protectedDeliveryPayload).map(({ files, ...item }) => ({
            ...item,
            fileNames: Object.keys(files ?? {}),
          })),
        );
      if (path === "/api/v2/delivery/verifications" && method === "GET")
        return json(res, 200, visibleDelivery("delivery_verification").map(exposeDeliveryVerification));
      if (path === "/api/v2/release/approvals" && method === "GET")
        return json(res, 200, visibleDelivery("release_approval"));
      if (path === "/api/v2/releases" && method === "GET")
        return json(
          res,
          200,
          visibleDelivery("release").map(protectedDeliveryPayload).map(expose),
        );
      if (path === "/api/v2/release/runs" && method === "GET")
        return json(
          res,
          200,
          visibleDelivery("release_run").map(exposeReleaseRun),
        );
      if (path === "/api/v2/monitoring/overview" && method === "GET") {
        const releases = visibleDelivery("release"),
          runs = visibleDelivery("release_run"),
          alerts = visibleDelivery("monitor_alert"),
          events = visibleDelivery("monitor_event"),
          activeRelease = releases.find(
            (release) => release.status === "ACTIVE_LOCAL",
          );
        return json(res, 200, {
          scope: "LOCAL_RELEASE_MONITORING",
          publicDeployed: false,
          fullLifecycleE2E: false,
          activeRelease: expose(protectedDeliveryPayload(activeRelease)),
          counts: {
            scheduled: runs.filter((run) => run.status === "SCHEDULED").length,
            running: runs.filter((run) => run.status === "RUNNING").length,
            succeeded: runs.filter((run) => run.status === "SUCCEEDED").length,
            failed: runs.filter((run) =>
              ["FAILED", "VALIDATION_FAILED"].includes(run.status),
            ).length,
            unknown: runs.filter((run) => run.status === "INTERRUPTED" && run.resultUnknown === true).length,
            openAlerts: alerts.filter((alert) => alert.status === "OPEN").length,
          },
          recentRuns: runs.slice(0, 20).map(exposeReleaseRun),
          alerts: alerts.slice(0, 20),
          recentEvents: events.slice(0, 30),
          notice:
            "这里只展示本机发布批次与告警证据，不能作为公网、生产或完整Agent E2E验收。",
        });
      }
      const fundSource = path.match(/^\/api\/v2\/data-services\/fund-sources\/([^/]+)$/);
      if (path === "/api/v2/data-services/fund-sources" && method === "GET") {
        if (!local) throw fail(403, "基金发布来源仅在本机 Spark 环境可读");
        if (url.searchParams.size) throw fail(422, "基金来源目录不接受查询参数");
        if (!localClassicSpark) return json(res, 200, []);
        const sources = [];
        for (const run of store.list("release_run", PROJECT)) {
          if (!isFundContext(run.source?.contextId) || run.status !== "SUCCEEDED" || !canReadDelivery("release_run", run)) continue;
          try {
            const proof = fundSourceFor(run)?.evidence;
            if (proof?.eligibleForService) sources.push({ id: run.id, releaseId: run.releaseId, status: run.status,
              published: true, schedulerTriggered: true, engine: run.engine, engineVersion: run.engineVersion,
              mainSqlExecuted: true, testSqlValidation: { passed: true }, validation: { passed: true },
              packageDigest: proof.packageDigest, outputContractId: proof.contractId, businessDate: proof.businessDate,
              sequence: proof.batchSequence });
          } catch (error) {
            if (![409, 422].includes(error.status)) throw error;
          }
        }
        return json(res, 200, sources);
      }
      if (fundSource && method === "GET") {
        if (!localClassicSpark) throw fail(403, "基金发布来源仅在本机 Spark 环境可读");
        const selection = fundConsumptionSelection(fundSource[1], url.searchParams);
        assertFundServiceSourceAccess(selection.batchId);
        const { evidence } = resolveFundConsumptionSource({ store, project: PROJECT, selection, timeUnitMs: releaseTimeUnitMs, fundSignedExecutionFor });
        return json(res, 200, evidence);
      }
      if (path === "/api/v2/data-services/sources" && method === "GET") {
        if (!local) throw fail(403, "本机发布来源只在本机开发环境可读");
        const selection=privateServiceSourceSelection(url.searchParams);
        if (!selection) throw fail(422, "发布来源选择不完整或不合法");
        if (selection.taskId) {
          const agent=store.get("agent",selection.taskId,PROJECT);
          if (!agent) return json(res,200,[]);
          requireDurableAgentOwner(agent,req);
        }
        return json(res,200,[...localServiceSources({store,project:PROJECT,selection}),...distributionServiceSources({store,project:PROJECT,selection}),
          ...syncSourcesFor(selection),
          ...fundAgentServiceSources({store,project:PROJECT,selection,timeUnitMs:releaseTimeUnitMs,fundSignedExecutionFor})]);
      }
      if (path === "/api/v2/data-services/task-evidence" && method === "GET") {
        if (!local) throw fail(403, "本机消费证据仅在本机开发环境可读");
        const selected = privateServiceSourceSelection(url.searchParams,true);
        if (!selected)
          throw fail(422, "需提供任务编号与确切包摘要");
        const {taskId,packageDigest,releaseId,callIdDigest}=selected;
        const agent = get("agent", taskId); requireDurableAgentOwner(agent, req);
        return json(res, 200, await localTaskConsumption({ store, project: PROJECT, agent, packageDigest, releaseId, callIdDigest, manager: dataServices, timeUnitMs: releaseTimeUnitMs, fundSignedExecutionFor, syncSourcesFor }));
      }
      if (path === "/api/v2/data-services/dapis" && method === "GET")
        return json(res, 200, visibleServices("DAPI"));
      if (path === "/api/v2/data-services/xapis" && method === "GET")
        return json(res, 200, visibleServices("XAPI"));
      if (path === "/api/v2/data-services/applications" && method === "GET")
        return json(res, 200, dataServices.listApplications().filter(app => app.serviceIds.every(id => canReadService(dataServices.detail(id)))));
      if (path === "/api/v2/data-services/calls" && method === "GET") {
        const ids = new Set(visibleServices().map(service => service.id));
        return json(
          res,
          200,
          dataServices.listCalls(url.searchParams.get("service_id") ?? undefined).filter(call => ids.has(call.serviceId)),
        );
      }
      const servicePlanRequest=path.match(/^\/api\/v2\/data-services\/agent\/requests\/([a-f0-9-]+)$/);
      if(servicePlanRequest&&method==='GET'){
        if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(servicePlanRequest[1]))throw fail(422,'原规划请求编号不合法');
        const id=store.deduplicatedId(`${PROJECT}:source-service-agent-plan:${servicePlanActor(req)}:${servicePlanRequest[1]}`);
        if(!id)throw fail(404,'未找到原规划请求，未重新提交');
        return json(res,200,readableServicePlan(get('service_agent_plan',id),req));
      }
      if (path === "/api/v2/data-services/agent/plans" && method === "GET"){
        const binding=servicePlanSourceQuery(url.searchParams),actorId=servicePlanActor(req);
        if(binding)boundServiceContext(binding,actorId);
        const plans=store.list('service_agent_plan',PROJECT).filter(plan=>binding?plan.sourceBinding&&plan.submittedBy===actorId&&
          JSON.stringify(servicePlanSourceBinding(plan.sourceBinding))===JSON.stringify(binding):!plan.sourceBinding);
        return json(res,200,plans.map(plan=>readableServicePlan(plan,req)));
      }
      if (path === "/api/v2/data-services/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000),actorId=servicePlanActor(req);
        if(Object.keys(body).some(key=>!['message','sourceBinding'].includes(key)))throw fail(422,'服务规划只接受需求与可选确切来源');
        const context=Object.hasOwn(body,'sourceBinding')?boundServiceContext(servicePlanSourceBinding(body.sourceBinding),actorId):undefined;
        if (!options.servicePlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100);
        if(context&&!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key))throw fail(422,'同源规划须使用可恢复的UUID请求编号');
        const signature = hash(JSON.stringify({ message,...(context?{sourceBinding:context.binding}:{}) })),
          dedup = store.deduplicate(
            context?`${PROJECT}:source-service-agent-plan:${actorId}:${key}`:`${PROJECT}:service-agent-plan:${key}`,
            signature,
            () =>
              store.create("service_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "DATA_SERVICE_DESIGN",
                fullLifecycleE2E: false,
                ...(context?{sourceBinding:context.binding,sourceContext:context.sourceContext,resourceVersions:context.resourceVersions,resourcesTruncated:context.resourcesTruncated,
                  submittedBy:actorId,requestId:key,scope:'LOCAL_TEST_ONLY',agentIndependentE2E:false,publicDeployed:false}:{}),
              }),
          ),
          task = get("service_agent_plan", dedup.id);
        if(context)checkedServicePlan(task,req);
        if (!dedup.replayed)
          schedule("service_agent_plan", task, async (signal) => {
            let frozenContext;
            if(task.sourceBinding){
              const current=boundServiceContext(task.sourceBinding,task.submittedBy);
              assertServicePlanVersions({store,project:PROJECT,binding:task.sourceBinding,refs:task.resourceVersions,current:true});
              frozenContext={...current,services:current.services.filter(service=>task.resourceVersions.some(ref=>ref.serviceId===service.id)),resourceVersions:task.resourceVersions};
            }
            if(signal.aborted||get('service_agent_plan',task.id).status==='CANCELLED')return;
            const releaseRuns = frozenContext?.releaseRuns??store
                .list("release_run", PROJECT)
                .filter(
                  (run) =>
                    run.status === "SUCCEEDED" &&
                    run.published === true &&
                    run.schedulerTriggered === true &&
                    run.validation?.passed,
                ),
              generated = await servicePlanner({
                message,
                services: frozenContext?.services??visibleServices(),
                releaseRuns,
                ...(frozenContext?{sourceContext:frozenContext.sourceContext}:{}),
                signal,
              });
            if (get("service_agent_plan", task.id).status === "CANCELLED") return;
            const proposal = dataServices.validateAgentPlan(generated.plan);
            let selectedVersions;
            if(frozenContext){
              boundServiceContext(task.sourceBinding,task.submittedBy);
              selectedVersions=bindServicePlanProposal(proposal,frozenContext);
              assertServicePlanVersions({store,project:PROJECT,binding:task.sourceBinding,refs:selectedVersions,current:true});
            }
            store.update("service_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
              ...(frozenContext?{selectedVersions,proposalHash:hash(JSON.stringify(proposal))}:{}),
            });
          });
        return json(res, 202, publicServicePlan(task));
      }
      const serviceAgentPlan = path.match(
        /^\/api\/v2\/data-services\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (serviceAgentPlan) {
        const rawPlan=get('service_agent_plan',serviceAgentPlan[1]),action=serviceAgentPlan[2];
        if(rawPlan.sourceBinding&&action==='cancel'){
          if(!sourceBoundServicePlansEnabled||rawPlan.submittedBy!==servicePlanActor(req))throw Object.assign(fail(403,'无权取消此规划任务'),{code:'SERVICE_PLAN_ACCESS_DENIED'});
          servicePlanSourceBinding(rawPlan.sourceBinding);
        }
        const plan=action==='cancel'||method==='GET'&&!action?rawPlan:checkedServicePlan(rawPlan,req);
        if (method === "GET" && !action) return json(res, 200, readableServicePlan(plan,req));
        if (method === "POST" && action === "cancel") {
          const body=await readBody(req);
          if(body.sourceBoundOnly===true&&!plan.sourceBinding)throw fail(409,'此取消入口只操作同源规划任务');
          if(plan.sourceBinding&&Object.keys(body).some(key=>key!=='sourceBoundOnly')||body.sourceBoundOnly!==undefined&&body.sourceBoundOnly!==true)throw fail(422,'取消规划不接受覆盖来源');
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("service_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, publicServicePlan(get("service_agent_plan", plan.id)));
        }
        if (method === "POST" && action === "apply") {
          const input=await readBody(req);
          if(plan.sourceBinding){
            if(Object.keys(input).length)throw fail(422,'同源方案应用不接受覆盖字段');
            if(!['SUCCEEDED','APPLIED'].includes(plan.status)||!plan.proposal)throw fail(409,'请先等待同源方案核验通过');
            const namespace=`${PROJECT}:source-service-plan-apply:${plan.id}`,signature=hash(JSON.stringify({sourceBinding:plan.sourceBinding,proposal:plan.proposal,selectedVersions:plan.selectedVersions}));
            const prior=store.deduplicatedId(namespace);
            if(!prior){
              assertServicePlanVersions({store,project:PROJECT,binding:plan.sourceBinding,refs:plan.selectedVersions,current:true});
              const valid=dataServices.validateAgentPlan(plan.proposal);
              if(JSON.stringify(valid)!==JSON.stringify(plan.proposal))throw fail(409,'原方案固定版本已变化');
              bindServicePlanProposal(valid,{binding:plan.sourceBinding,resourceVersions:plan.resourceVersions});
            }
            const receipt=store.deduplicate(namespace,signature,()=>plan.proposal.serviceType==='DAPI'?dataServices.createDapi(plan.proposal):dataServices.createXapi(plan.proposal)),
              service=dataServices.detail(receipt.id);
            if(!servicePlanDraftMatches(service,plan.proposal,plan.sourceBinding)||plan.appliedVersionId&&
              (service.currentVersion.id!==plan.appliedVersionId||service.currentVersion.configHash!==plan.appliedConfigHash))
              throw Object.assign(fail(409,'已应用草稿的当前版本已变化，未替换原结果'),{code:'APPLIED_SERVICE_CHANGED'});
            if(plan.status==='APPLIED'&&plan.serviceId===service.id)return json(res,200,service);
            store.update('service_agent_plan',plan.id,PROJECT,{status:'APPLIED',serviceId:service.id,appliedVersionId:service.currentVersion.id,
              appliedConfigHash:service.currentVersion.configHash,appliedAt:plan.appliedAt??new Date().toISOString()});
            return json(res,receipt.replayed?200:201,service);
          }
          if (plan.status === "APPLIED" && plan.serviceId)
            return json(res, 200, dataServices.detail(plan.serviceId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型方案验证通过后才能创建草稿");
          const proposal = dataServices.validateAgentPlan(plan.proposal),
            service =
              proposal.serviceType === "DAPI"
                ? dataServices.createDapi(proposal)
                : dataServices.createXapi(proposal);
          store.update("service_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            serviceId: service.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, dataServices.detail(service.id));
        }
      }
      if (
        path === "/api/v2/data-services/applications" &&
        method === "POST"
      ) {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100);
        let issued;
        if (Array.isArray(body.serviceIds) && body.serviceIds.length <= 20)
          for (const id of body.serviceIds) assertFundServiceAccess(dataServices.detail(id));
        const dedup = store.deduplicate(
          `${PROJECT}:service-application:${key}`,
          hash(JSON.stringify(body)),
          () => {
            issued = dataServices.createApplication(body);
            return issued.application;
          },
        );
        if (dedup.replayed)
          return json(res, 200, {
            application: dataServices.application(dedup.id),
            token: null,
            tokenShownOnce: false,
            notice:
              "幂等请求已创建过应用，平台不保存明文令牌；如令牌丢失请撤销并新建应用。",
          });
        return json(res, 201, issued);
      }
      const applicationRecord = path.match(
        /^\/api\/v2\/data-services\/applications\/([a-f0-9-]+)\/(revoke)$/,
      );
      if (applicationRecord && method === "POST") {
        await readBody(req);
        for (const id of dataServices.application(applicationRecord[1]).serviceIds)
          assertFundServiceAccess(dataServices.detail(id));
        return json(
          res,
          200,
          dataServices.revokeApplication(applicationRecord[1]),
        );
      }
      if (
        ["/api/v2/data-services/dapis", "/api/v2/data-services/xapis"].includes(
          path,
        ) &&
        method === "POST"
      ) {
        const body = await readBody(req),
          type = path.endsWith("dapis") ? "DAPI" : "XAPI";
        assertFundServiceInputAccess(type, body);
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:data-service:${type}:${key}`,
            hash(JSON.stringify(body)),
            () =>
              type === "DAPI"
                ? dataServices.createDapi(body)
                : dataServices.createXapi(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          dataServices.detail(dedup.id),
        );
      }
      const dataServiceRecord = path.match(
        /^\/api\/v2\/data-services\/(dapis|xapis)\/([a-f0-9-]+)(?:\/(versions|test|publish|activate|openapi|calls|history))?$/,
      );
      if (dataServiceRecord) {
        const type = dataServiceRecord[1] === "dapis" ? "DAPI" : "XAPI",
          service = dataServices.detail(dataServiceRecord[2]),
          action = dataServiceRecord[3];
        if (service.serviceType !== type)
          throw fail(404, "未找到当前类型的数据服务");
        assertFundServiceAccess(service);
        if (method === "GET" && !action) return json(res, 200, service);
        if (method === "GET" && action === "openapi")
          return json(
            res,
            200,
            dataServices.openApi(
              service.id,
              `http://${req.headers.host ?? "127.0.0.1:3100"}`,
            ),
          );
        if (method === "GET" && action === "calls")
          return json(res, 200, dataServices.listCalls(service.id));
        if (method === "GET" && action === "history")
          return json(res,200,store.list('service_version_switch',PROJECT).filter(r=>r.serviceId===service.id));
        if (method === "POST" && action === "versions") {
          const body = await readBody(req);
          assertFundServiceInputAccess(type, body);
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:${type.toLowerCase()}-version:${service.id}:${key}`,
              hash(JSON.stringify(body)),
              () =>
                type === "DAPI"
                  ? dataServices.createDapiVersion(service.id, body)
                  : dataServices.createXapiVersion(service.id, body),
            );
          return json(res, dedup.replayed ? 200 : 201, get("data_service_version", dedup.id));
        }
        if (method === "POST" && action === "test")
          return json(res, 200, await dataServices.test(service.id, await readBody(req)));
        if (method === "POST" && action === "publish")
          return json(res, 200, publishServiceReviewed(dataServices,service.id,await readBody(req)));
        if (method === "POST" && action === "activate") {
          const body = await readBody(req);
          const target = service.versions.find(version => version.id === body.versionId);
          if (target) assertFundServiceInputAccess(type, target);
          return json(
            res,
            200,
            activateServiceReviewed({manager:dataServices,store,project:PROJECT,serviceId:service.id,
              actorId:auth.sessionFromHeaders(req.headers)?.user.id ?? 'local-engineer',
              key:req.headers['idempotency-key'],body}),
          );
        }
      }
      if (path === "/api/v2/delivery/packages" && method === "POST") {
        const body = await readBody(req),
          sourceRun = get("run", text(body.sourceRunId, 1, 80)),
          sourceRevision = get("revision", sourceRun.revisionId);
        if (!deliveryAccessForRequest().canPrepare(sourceRun, sourceRevision)) throw deliveryDenied();
        if (sourceRun.syncInput || sourceRevision.syncInput) requireDevelopmentOwner("run", sourceRun, req);
        if (sourceRevision.fundPreparation) throw fail(409, "已保存口径的基金交付请从原 Agent 任务准备");
        if (isFundContext(sourceRevision.contextId) && !localClassicSpark) throw fail(422, "基金交付仅支持本机文件演练");
        const family = validationFamilyForRun(sourceRun);
        const name =
          body.name === undefined ? "客户资产 T+1" : text(body.name, 1, 80);
        const bundle = createDeliveryPackage({
          run: sourceRun,
          revision: sourceRevision,
          agent:packageRequirementSource(sourceRun,sourceRevision).agent,
          ...syncDeliveryInputs(sourceRun, sourceRevision),
          manualAuthor:Boolean(getContext(sourceRevision.contextId)?.outputContractId&&sourceRevision.source==='MANUAL'&&!sourceRevision.manualProvenance?.originAgentTaskId),
          name,
        }),
          artifact = await artifactStore.put(
            "delivery-package",
            bundle.digest,
            bundle,
          );
        assertRequirementSource(bundle); // Re-read after artifact I/O; never freeze stale understanding.
        const key = text(req.headers["idempotency-key"], 1, 100);
        const existing = bundle.manifest.source.syncInput && store.list("delivery_package", PROJECT)
          .find(item => item.sourceRunId === sourceRun.id && item.digest === bundle.digest);
        const dedup = store.deduplicate(
          PROJECT + ":delivery:" + key,
          hash(
            JSON.stringify({
              sourceRunId: sourceRun.id,
              name,
              validationContractId: family.id,
              ...(bundle.manifest.source.requirement?{requirement:bundle.manifest.source.requirement}:{}),
            }),
          ),
          () =>
            existing ?? store.create("delivery_package", PROJECT, {
              ...bundle,
              artifact,
              sourceRunId: sourceRun.id,
              stage: "M2A",
              published: false,
            }),
        );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          protectedDeliveryPayload(get("delivery_package", dedup.id)),
        );
      }
      if (path === "/api/v2/delivery/reviews" && method === "GET")
        return json(res, 200, visibleDelivery("delivery_review"));
      const deliveryRecord = path.match(
        /^\/api\/v2\/delivery\/(packages|verifications)\/([a-f0-9-]+)(?:\/(verify|cancel|review|approve))?$/,
      );
      if (deliveryRecord) {
        const kind =
          deliveryRecord[1] === "packages"
            ? "delivery_package"
            : "delivery_verification";
        const item = get(kind, deliveryRecord[2]);
        requireDeliveryEvidence(kind, item);
        if (method === "GET" && !deliveryRecord[3]) {
          if (kind === "delivery_package" && item.manifest?.source?.syncInput) validateAnyDeliveryPackage(item);
          return json(res, 200, kind === "delivery_verification" ? exposeDeliveryVerification(item) : protectedDeliveryPayload(item));
        }
        if (
          kind === "delivery_verification" &&
          deliveryRecord[3] === "cancel" &&
          method === "POST"
        ) {
          if (!terminal.has(item.status)) {
            store.update(kind, item.id, PROJECT, { status: "CANCELLED" });
            controls.get(item.id)?.abort();
          }
          return json(res, 200, exposeDeliveryVerification(get(kind, item.id)));
        }
        if (
          kind === "delivery_package" &&
          deliveryRecord[3] === "review" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            packageDigest = text(body.packageDigest, 64, 64),
            verificationId = text(body.verificationId, 1, 80),
            reviewNote = text(body.reviewNote, 4, 500),
            requiredAttestations = [
              "code",
              "assertions",
              "deliveryFiles",
              "localScope",
            ],
            attestations = body.attestations;
          if (packageDigest !== item.digest)
            throw fail(409, "审阅摘要与当前交付包不一致");
          if (
            !attestations ||
            typeof attestations !== "object" ||
            Array.isArray(attestations) ||
            Object.keys(attestations).some(
              (key) => !requiredAttestations.includes(key),
            ) ||
            !requiredAttestations.every((key) => attestations[key] === true)
          )
            throw fail(422, "需逐项确认代码、断言、交付文件和本机范围");
          const rehearsal = get("delivery_verification", verificationId);
          requireDeliveryEvidence("delivery_verification", rehearsal);
          if (
            rehearsal.packageId !== item.id ||
            rehearsal.packageDigest !== item.digest ||
            rehearsal.status !== "SUCCEEDED"
          )
            throw fail(409, "审阅必须绑定当前交付包的成功按文件演练");
          await ensureDeliveryArtifact(item);
          const plan = validateAnyDeliveryPackage(item);
          const latestRehearsal = get("delivery_verification", verificationId);
          if (latestRehearsal.packageId !== item.id || latestRehearsal.packageDigest !== item.digest || latestRehearsal.status !== "SUCCEEDED")
            throw fail(409, "原演练已变化，请重新读取审阅依据");
          assertFundRehearsal(item, latestRehearsal);
          assertSyncSqlRehearsal(plan, item, latestRehearsal);
          const rehearsalDigest = fundSignedRehearsalDigest(item, latestRehearsal, fundSignedExecutionFor(item));
          if (body.fundRehearsalDigest !== rehearsalDigest)
            throw fail(409, "审阅必须确认当前基金签名演练摘要");
          const session = auth.sessionFromHeaders(req.headers),
            reviewer = session
              ? {
                  id: session.user.id,
                  displayName: session.user.displayName,
                  role: session.role,
                }
              : {
                  id: "local-engineer",
                  displayName: "本机工程师",
                  role: "LOCAL_DEVELOPMENT",
                },
            existingReview = store
              .list("delivery_review", PROJECT)
              .find(
                (review) =>
                  review.packageId === item.id &&
                  review.packageDigest === item.digest &&
                  review.verificationId === latestRehearsal.id &&
                  review.fundRehearsalDigest === rehearsalDigest &&
                  review.reviewer?.id === reviewer.id &&
                  review.status === "REVIEWED",
              );
          if (rehearsalDigest && reviewer.id !== item.manifest.source.attribution.actorId)
            throw deliveryDenied();
          if (existingReview) return json(res, 200, existingReview);
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              PROJECT + ":delivery-review:" + key,
              hash(
                JSON.stringify({
                  packageId: item.id,
                  packageDigest: item.digest,
                  verificationId: latestRehearsal.id,
                  ...(rehearsalDigest ? {fundRehearsalDigest:rehearsalDigest} : {}),
                  reviewerId: reviewer.id,
                  reviewNote,
                  attestations,
                }),
              ),
              () =>
                store.create("delivery_review", PROJECT, {
                  packageId: item.id,
                  packageDigest: item.digest,
                  verificationId: latestRehearsal.id,
                  ...(rehearsalDigest ? {fundRehearsalDigest:rehearsalDigest} : {}),
                  reviewer,
                  reviewNote,
                  attestations,
                  status: "REVIEWED",
                  scope: item.manifest?.source?.outputContract || item.manifest?.source?.fundLookthrough || plan.source.syncInput ? "LOCAL_FILE_REVIEW" : "LOCAL_TEST_RELEASE",
                  publicDeploymentApproved: false,
                  reviewedAt: new Date().toISOString(),
                }),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("delivery_review", dedup.id),
          );
        }
        if (
          kind === "delivery_package" &&
          deliveryRecord[3] === "approve" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            packageDigest = text(body.packageDigest, 64, 64);
          if (packageDigest !== item.digest)
            throw fail(409, "审批摘要与当前交付包不一致");
          const reviewId = text(body.reviewId, 1, 80);
          const review = get("delivery_review", reviewId);
          requireDeliveryEvidence("delivery_review", review);

          const rehearsal = store
            .list("delivery_verification", PROJECT)
            .find(
              (record) =>
                record.packageId === item.id &&
                record.packageDigest === item.digest &&
                record.status === "SUCCEEDED" && (!item.manifest?.source?.outputContract||record.id===body.distributionConsent?.verificationId) &&
                (!isFundContext(item.manifest?.source?.contextId) || record.id === body.fundConsent?.verificationId) &&
                (!item.manifest?.source?.syncInput || record.id === body.syncConsent?.verificationId),
            );
          if (!rehearsal)
            throw fail(409, "交付包尚无成功的按文件演练，不能审批发布");
          requireDeliveryEvidence("delivery_verification", rehearsal);
          if (
            review.packageId !== item.id ||
            review.packageDigest !== item.digest ||
            review.verificationId !== rehearsal.id ||
            review.status !== "REVIEWED"
          )
            throw fail(409, "审批必须引用当前包、摘要和演练一致的审阅记录");
          await ensureDeliveryArtifact(item);
          const plan = validateAnyDeliveryPackage(item);
          const latestRehearsal = plan.source.syncInput ? get("delivery_verification", rehearsal.id) : rehearsal;
          const latestReview = plan.source.syncInput ? get("delivery_review", review.id) : review;
          const distributionConsent=assertDistributionConsent({bundle:item,verification:rehearsal,review,consent:body.distributionConsent,local,schedulerMode:releaseSchedulerMode});
          const fundConsent = assertFundConsent({ bundle: item,
            verification:get("delivery_verification",rehearsal.id), review:get("delivery_review",review.id),
            consent: body.fundConsent, localClassicSpark, schedulerMode: releaseSchedulerMode,
            fundSignedExecution:fundSignedExecutionFor(item) });
          const actor = auth.sessionFromHeaders(req.headers),
            approver = actor
              ? {
                  id: actor.user.id,
                  displayName: actor.user.displayName,
                  role: actor.role,
                }
              : {
                  id: "local-engineer",
                  displayName: "本机工程师",
                  role: "LOCAL_DEVELOPMENT",
                };
          const syncConsent = assertSyncSqlConsent({ bundle: item, plan, verification: latestRehearsal, review: latestReview,
            consent: body.syncConsent, actorId: approver.id, enabled: syncSqlLocal && releaseSchedulerMode === "LOCAL_TIMER" });
          const approvedAt = syncConsent ? options.now?.() ?? Date.now() : Date.now();
          const syncReviewDigest = syncConsent && syncSqlReviewDigest(latestRehearsal, latestReview);
          const findExistingApproval = () => store
            .list("release_approval", PROJECT)
            .find(
              (approval) =>
                approval.packageId === item.id &&
                approval.packageDigest === item.digest &&
                approval.status === "APPROVED" &&
                (!syncConsent || approval.consumedByReleaseId || approvedAt < Date.parse(approval.expiresAt)),
            );
          const checkExistingApproval = existingApproval => {
            if(distributionConsent&&!sameDistributionConsent(existingApproval.distributionConsent,distributionConsent))throw fail(409,"原批准绑定另一份分布测试发布计划");
            if(fundConsent&&!sameDistributionConsent(existingApproval.fundConsent,fundConsent))throw fail(409,"原批准绑定另一份基金测试发布计划");
            if (syncConsent && (!isDeepStrictEqual(existingApproval.syncConsent, syncConsent) ||
                existingApproval.reviewId !== review.id || existingApproval.syncReviewDigest !== syncReviewDigest))
              throw fail(409, "原批准绑定另一份持仓测试发布计划");
            return existingApproval;
          };
          const existingApproval = findExistingApproval();
          if (existingApproval) return json(res, 200, checkExistingApproval(existingApproval));
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              PROJECT + ":release-approval:" + key,
              hash(
                JSON.stringify({
                  packageId: item.id,
                  packageDigest: item.digest,
                  rehearsalId: rehearsal.id,
                  reviewId: review.id,
                  approverId: approver.id,
                  ...(distributionConsent?{distributionConsent}:{}),
                  ...(fundConsent ? { fundConsent } : {}),
                  ...(syncConsent ? { syncConsent, syncReviewDigest } : {}),
                }),
              ),
              () => {
                const raced = syncConsent && findExistingApproval();
                return raced ? checkExistingApproval(raced) : store.create("release_approval", PROJECT, {
                  packageId: item.id,
                  packageDigest: item.digest,
                  rehearsalId: rehearsal.id,
                  sourceRevisionId: item.manifest.source.revisionId,
                  sourceCodeHash:
                    item.manifest.source.codeHash ??
                    item.manifest.source.sqlHash,
                  ...(item.manifest.source.sqlHash
                    ? { sourceSqlHash: item.manifest.source.sqlHash }
                    : {}),
                  reviewId: review.id,
                  reviewer: approver.displayName,
                  reviewedBy: review.reviewer,
                  ...(distributionConsent?{distributionConsent,approver}:{}),
                  ...(fundConsent ? { fundConsent, approver } : {}),
                  ...(syncConsent ? { syncConsent, syncReviewDigest, approver, expiresAt: syncApprovalExpiry(approvedAt) } : {}),
                  decision: "APPROVED",
                  status: "APPROVED",
                  reviewNote: review.reviewNote,
                  approvedAt: new Date(approvedAt).toISOString(),
                  scope: "LOCAL_TEST_RELEASE",
                  publicDeploymentApproved: false,
                });
              },
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("release_approval", dedup.id),
          );
        }
        if (
          kind === "delivery_package" &&
          deliveryRecord[3] === "verify" &&
          method === "POST"
        ) {
          if (item.manifest?.source?.attribution?.kind === fundAgentAttributionKind)
            throw fail(409, "请查看原 Agent 交付的演练回执");
          const body = await readBody(req),
            scheduledFor = text(body.scheduledFor, 1, 50);
          await ensureDeliveryArtifact(item);
          const plan = validateAnyDeliveryPackage(item),
            occurrence = resolveDeliverySchedule(plan, scheduledFor);
          if (!occurrence.eligible) throw fail(422, "样例非交易日，未提交执行");
          if (occurrence.businessDate !== plan.fixtures.context.businessDate)
            throw fail(
              422,
              "T+1业务日与冻结输入不一致，请使用交付包中的样例演练时刻",
            );
          if (
            isPythonDelivery(item)
              ? !options.pythonDeliveryRunner &&
                !options.pythonRunner &&
                !pythonRuntime.available
              : !options.deliveryRunner && !options.runner && !runtime.available
          )
            throw fail(
              503,
              isPythonDelivery(item)
                ? "受限Python尚未就绪"
                : "Spark尚未就绪",
            );
          const key = text(req.headers["idempotency-key"], 1, 100);
          const existing = plan.source.syncInput && store.list("delivery_verification", PROJECT)
            .find(record => record.packageId === item.id && record.packageDigest === item.digest &&
              record.scheduledFor === scheduledFor && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(record.status));
          if (existing?.status === "SUCCEEDED") assertSyncSqlRehearsal(plan, item, existing);
          const dedup = store.deduplicate(
            PROJECT + ":delivery-verify:" + key,
            hash(
              JSON.stringify({
                packageId: item.id,
                digest: item.digest,
                scheduledFor,
              }),
            ),
            () =>
              existing ?? store.create("delivery_verification", PROJECT, {
                packageId: item.id,
                packageDigest: item.digest,
                scheduledFor,
                status: "QUEUED",
                scope:
                  isPythonDelivery(item)
                    ? "M2A_LOCAL_PYTHON_FILE_REHEARSAL"
                    : plan.deployment.adapter === "remote-spark-worker-v1"
                    ? "M2A_CLOUD_ISOLATED_FILE_REHEARSAL"
                    : "M2A_LOCAL_FILE_REHEARSAL",
                published: false,
                fullLifecycleE2E: false,
              }),
          );
          const verification = get("delivery_verification", dedup.id);
          if (!dedup.replayed && !existing)
            schedule("delivery_verification", verification, async (signal) => {
              const parent = join(root, ".v2-artifacts", "delivery");
              mkdirSync(parent, { recursive: true });
              const directory = unpackAnyDeliveryPackage(
                item,
                join(parent, verification.id),
              );
              const executeFiles =
                (isPythonDelivery(item)
                  ? options.pythonDeliveryRunner
                  : options.deliveryRunner) ?? releaseRunner;
              let result = await executeFiles({
                directory,
                expectedDigest: item.digest,
                scheduledFor,
                signal,
              });
              if (result.status === "SUCCEEDED" && plan.source.syncInput) {
                assertRequirementSource(item);
                result = checkedSyncSqlFileRehearsal(plan, item, result);
              }
              if (
                !["SUCCEEDED", "FAILED", "VALIDATION_FAILED"].includes(
                  result.status,
                )
              )
                throw new Error("文件执行器返回无效状态");
              if (
                get("delivery_verification", verification.id).status !==
                "CANCELLED"
              )
                store.update(
                  "delivery_verification",
                  verification.id,
                  PROJECT,
                  {
                    ...result,
                    published: false,
                    fullLifecycleE2E: false,
                    finishedAt: new Date().toISOString(),
                  },
                );
            });
          return json(res, 202, exposeDeliveryVerification(verification));
        }
      }
      if (path === "/api/v2/releases" && method === "POST") {
        if (!local || releaseSchedulerMode !== "LOCAL_TIMER")
          throw fail(503, "当前发布接口仅支持已启用调度器的本机测试环境；云端发布尚未开放");
        const body = await readBody(req),
          approval = get(
            "release_approval",
            text(body.approvalId, 1, 80),
          ),
          item = get("delivery_package", approval.packageId),
          spec = localScheduleSpec(body);
        if (item.manifest?.source?.syncInput || item.manifest?.source?.attribution?.kind === fundAgentAttributionKind) {
          requireDeliveryEvidence("delivery_package", item);
          requireDeliveryEvidence("release_approval", approval);
        }
        const artifact = await ensureDeliveryArtifact(item), plan = validateAnyDeliveryPackage(item);
        const latestApproval=get('release_approval',approval.id);
        if (plan.source.syncInput) {
          const parent = join(root, ".v2-artifacts", "releases");
          mkdirSync(parent, { recursive: true });
          const { release, replayed } = activateSyncSqlRelease({ store, project: PROJECT, bundle: item, plan, artifact, spec,
            approval: latestApproval, verification: get("delivery_verification", latestApproval.rehearsalId),
            review: get("delivery_review", latestApproval.reviewId),
            actorId: auth.sessionFromHeaders(req.headers)?.user.id ?? "local-engineer",
            enabled: syncSqlLocal && releaseSchedulerMode === "LOCAL_TIMER",
            now: options.now ?? Date.now, timeUnitMs: releaseTimeUnitMs,
            unpack: releaseId => unpackAnyDeliveryPackage(item, join(parent, releaseId)),
          });
          for (const run of store.list("release_run", PROJECT).filter(run => run.releaseId === release.id))
            releaseScheduler.schedule(run);
          return json(res, replayed ? 200 : 201, expose(release));
        }
        const fundRelease = Boolean(plan.source.fundLookthrough);
        if (fundRelease) assertFundRelease({ bundle: item, approval: latestApproval, spec,
          verification: get("delivery_verification", latestApproval.rehearsalId), review: get("delivery_review", latestApproval.reviewId),
          localClassicSpark, schedulerMode: releaseSchedulerMode, fundSignedExecution:fundSignedExecutionFor(item) });
        if(plan.source.outputContract)assertDistributionRelease({bundle:item,verification:latestApproval.rehearsalId?store.get('delivery_verification',latestApproval.rehearsalId,PROJECT):undefined,review:latestApproval.reviewId?store.get('delivery_review',latestApproval.reviewId,PROJECT):undefined,approval:latestApproval,spec,local,schedulerMode:releaseSchedulerMode});
        const consumedReleaseId=plan.source.outputContract || fundRelease ? latestApproval.consumedByReleaseId : approval.consumedByReleaseId;
        if (
          approval.status !== "APPROVED" ||
          approval.packageDigest !== item.digest ||
          (approval.sourceCodeHash ?? approval.sourceSqlHash) !==
            (item.manifest.source.codeHash ?? item.manifest.source.sqlHash)
        )
          throw fail(409, "审批记录未绑定当前不可变交付包");
        if (consumedReleaseId) {
          const existing = get("release", consumedReleaseId);
          if (
            existing.packageId === item.id &&
            existing.packageDigest === item.digest &&
            JSON.stringify(existing.scheduleSpec) === JSON.stringify(spec)
          )
            return json(res, 200, expose(existing));
          throw fail(409, "该审批已绑定其他发布参数，不能重复使用");
        }
        const businessDay = plan.fixtures.context.businessDate,
          calendarIndex = plan.calendar.tradingDays.indexOf(businessDay),
          nextTradingDay = plan.calendar.tradingDays[calendarIndex + 1];
        if (!nextTradingDay)
          throw fail(422, "样例日历缺少业务日后的下一个交易日");
        const businessScheduledFor =
            nextTradingDay + "T" + plan.schedule.at + "+08:00",
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            fundRelease ? PROJECT + ":fund-release:" + approval.id : plan.source.outputContract ? PROJECT+":distribution-release:"+approval.id : PROJECT + ":release:" + key,
            hash(
              JSON.stringify({
                approvalId: approval.id,
                packageId: item.id,
                packageDigest: item.digest,
                artifact,
                spec,
              }),
            ),
            () =>
              store.create("release", PROJECT, {
                approvalId: approval.id,
                packageId: item.id,
                packageDigest: item.digest,
                artifact,
                sourceRevisionId: item.manifest.source.revisionId,
                sourceCodeHash:
                  item.manifest.source.codeHash ?? item.manifest.source.sqlHash,
                ...(item.manifest.source.sqlHash
                  ? { sourceSqlHash: item.manifest.source.sqlHash }
                  : {}),
                ...(plan.source.outputContract?{outputContract:plan.source.outputContract}:{}),
                ...(fundRelease ? { fundLookthrough: plan.source.fundLookthrough } : {}),
                status: "DEPLOYING",
                health: "PENDING",
                environment: plan.deployment.environment,
                adapter: plan.deployment.adapter,
                scheduleSpec: spec,
                businessScheduledFor,
                publicDeployed: false,
                fullLifecycleE2E: false,
              }),
          );
        let release = get("release", dedup.id);
        if (!dedup.replayed) {
          try {
            const parent = join(root, ".v2-artifacts", "releases");
            mkdirSync(parent, { recursive: true });
            const artifactDirectory = unpackAnyDeliveryPackage(
              item,
              join(parent, release.id),
            );
            for (const previous of store.list("release", PROJECT)) {
              if (
                previous.id !== release.id &&
                previous.status === "ACTIVE_LOCAL" &&
                sameLocalPublicationLane(store.get("delivery_package",previous.packageId,PROJECT),item)
              ) {
                releaseScheduler.cancelRelease(
                  previous.id,
                  "已由新发布版本替代",
                );
                store.update("release", previous.id, PROJECT, {
                  status: "SUPERSEDED_LOCAL",
                  supersededByReleaseId: release.id,
                  supersededAt: new Date().toISOString(),
                });
              }
            }
            const activatedAtMs = options.now?.() ?? Date.now();
            release = store.update("release", release.id, PROJECT, {
              status: "ACTIVE_LOCAL",
              health: "OBSERVING",
              artifactDirectory,
              activatedAt: new Date(activatedAtMs).toISOString(),
            });
            store.update("release_approval", approval.id, PROJECT, {
              consumedByReleaseId: release.id,
              consumedAt: new Date().toISOString(),
            });
            const planned = plannedLocalRuns({
              releaseId: release.id,
              packageId: item.id,
              packageDigest: item.digest,
              businessScheduledFor,
              spec,
              nowMs: activatedAtMs,
              timeUnitMs: releaseTimeUnitMs,
            });
            for (const runData of planned) {
              const run = store.create("release_run", PROJECT, runData);
              releaseScheduler.schedule(run);
            }
          } catch (error) {
            store.update("release", release.id, PROJECT, {
              status: "FAILED_LOCAL",
              error: error.message,
              finishedAt: new Date().toISOString(),
            });
            throw error;
          }
        }
        return json(res, dedup.replayed ? 200 : 201, expose(release));
      }
      const releaseRecord = path.match(
        /^\/api\/v2\/(releases|release\/runs)\/([a-f0-9-]+)(?:\/(rollback|cancel))?$/,
      );
      if (releaseRecord) {
        const kind =
            releaseRecord[1] === "releases" ? "release" : "release_run",
          item = get(kind, releaseRecord[2]);
        requireDeliveryEvidence(kind, item);
        if (method === "GET" && !releaseRecord[3])
          return json(res, 200, kind === "release_run" ? exposeReleaseRun(item) : expose(protectedDeliveryPayload(item)));
        if(kind==='release'&&method==='POST'&&releaseRecord[3]==='cancel'){
          const body=await readBody(req);
          if(!local||releaseSchedulerMode!=='LOCAL_TIMER'||(!item.outputContract&&!item.fundLookthrough&&!item.syncInput)||item.fundLookthrough&&!localClassicSpark)throw fail(422,'此停止入口仅用于本机受控测试发布');
          if(body.packageDigest!==item.packageDigest)throw fail(409,'停止须绑定确切发布与包摘要');
          if(item.status==='CANCELLED')return json(res,200,expose(item));
          if(!['ACTIVE_LOCAL','DEPLOYING'].includes(item.status))throw fail(409,'只能停止当前生效的本机测试发布');
          releaseScheduler.cancelRelease(item.id,'工程师停止后续本机批次');
          const stopped=store.update('release',item.id,PROJECT,{status:'CANCELLED',health:'STOPPED',cancelledAt:new Date().toISOString()});
          if(item.currentRollbackId)store.update('release_rollback',item.currentRollbackId,PROJECT,{status:'CANCELLED',stoppedAt:new Date().toISOString()});
          store.create('monitor_event',PROJECT,{type:'RELEASE_CANCELLED',releaseId:item.id,packageDigest:item.packageDigest,observedAt:new Date().toISOString()});
          return json(res,200,expose(stopped));
        }
        if (
          kind === "release" &&
          releaseRecord[3] === "rollback" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            target = get("release", text(body.targetReleaseId, 1, 80));
          requireDeliveryEvidence("release", target);
          const currentBundle=get('delivery_package',item.packageId),targetBundle=get('delivery_package',target.packageId);
          if (currentBundle.manifest.source.syncInput || targetBundle.manifest.source.syncInput)
            throw fail(422, "冻结持仓的历史版本须重新审阅与批准后发布");
          if (currentBundle.manifest.source.fundLookthrough || targetBundle.manifest.source.fundLookthrough)
            throw fail(422, "基金组合穿透尚未开放回滚");
          if(currentBundle.manifest.source.outputContract||targetBundle.manifest.source.outputContract){
            if(!local||releaseSchedulerMode!=='LOCAL_TIMER')throw fail(422,'分布回滚仅用于本机测试');
            const key=text(req.headers['idempotency-key'],1,100),reason=body.reason===undefined?'恢复到已验证的分布版本':text(body.reason,4,500),namespace=`${PROJECT}:distribution-rollback:${item.id}:${key}`;
            const previous=store.deduplicatedId(namespace);
            if(previous){
              const recovered=store.deduplicate(namespace,distributionRequestSignature({targetReleaseId:target.id,consent:body.distributionRollback,reason}),()=>{throw fail(409,'回滚记录未确认');});
              const rollback=get('release_rollback',recovered.id);
              return json(res,200,{rollback,activeRelease:expose(get('release',rollback.toReleaseId))});
            }
            if(item.status!=='ACTIVE_LOCAL'||target.id===item.id||!['SUPERSEDED_LOCAL','ROLLED_BACK_LOCAL'].includes(target.status))throw fail(409,'回滚须选择当前发布及已验证历史版本');
            await ensureDeliveryArtifact(targetBundle);validateAnyDeliveryPackage(targetBundle);
            const consent=assertDistributionRollback({currentBundle,targetBundle,target,consent:body.distributionRollback}),approval=get('release_approval',target.approvalId),spec=localScheduleSpec(target.scheduleSpec);
            assertDistributionRelease({bundle:targetBundle,verification:get('delivery_verification',approval.rehearsalId),review:get('delivery_review',approval.reviewId),approval,spec,local,schedulerMode:releaseSchedulerMode});
            if(['triggerAfterSeconds','intervalSeconds'].some(k=>body[k]!==undefined&&Number(body[k])!==spec[k]))throw fail(409,'回滚复用原已批准的两批计时参数');
            const planned=plannedLocalRuns({releaseId:target.id,packageId:target.packageId,packageDigest:target.packageDigest,businessScheduledFor:target.businessScheduledFor,spec,nowMs:options.now?.()??Date.now(),timeUnitMs:releaseTimeUnitMs,triggerReason:'ROLLBACK_RECOVERY'});
            const result=activateDistributionRollback({store,project:PROJECT,item,target,consent,spec,reason,key,nowMs:options.now?.()??Date.now(),plannedRuns:planned});
            if(!result.replayed){releaseScheduler.cancelRelease(item.id,'当前版本已执行回滚');for(const run of result.runs)releaseScheduler.schedule(run);}
            return json(res,result.replayed?200:202,{rollback:result.rollback,activeRelease:expose(result.activeRelease)});
          }
          if (item.status !== "ACTIVE_LOCAL")
            throw fail(409, "只能回滚当前生效的本机发布版本");
          if (
            target.id === item.id ||
            !["SUPERSEDED_LOCAL", "ROLLED_BACK_LOCAL"].includes(
              target.status,
            ) ||
            Number(target.successfulRunCount ?? 0) < 1
          )
            throw fail(409, "回滚目标必须是已有成功批次的历史发布版本");
          const spec = localScheduleSpec({
            triggerAfterSeconds: body.triggerAfterSeconds ?? 2,
            intervalSeconds: body.intervalSeconds ?? 10,
            runCount: 2,
          });
          releaseScheduler.cancelRelease(item.id, "当前版本已执行回滚");
          store.update("release", item.id, PROJECT, {
            status: "ROLLED_BACK_LOCAL",
            rolledBackToReleaseId: target.id,
            rolledBackAt: new Date().toISOString(),
          });
          const restored = store.update("release", target.id, PROJECT, {
            status: "ACTIVE_LOCAL",
            health: "OBSERVING",
            restoredFromReleaseId: item.id,
            restoredAt: new Date().toISOString(),
          });
          const resolvedAlertIds = [];
          for (const alert of store.list("monitor_alert", PROJECT)) {
            if (alert.releaseId === item.id && alert.status === "OPEN" && alert.code !== localReleaseUnknownResultCode) {
              resolvedAlertIds.push(alert.id);
              store.update("monitor_alert", alert.id, PROJECT, {
                status: "RESOLVED",
                resolutionMode: "ROLLBACK",
                recoveryReleaseId: restored.id,
                resolvedAt: new Date().toISOString(),
              });
            }
          }
          const rollback = store.create("release_rollback", PROJECT, {
            fromReleaseId: item.id,
            toReleaseId: target.id,
            actor: "local-engineer",
            reason:
              body.reason === undefined
                ? "恢复到最近已验证版本"
                : text(body.reason, 4, 500),
            status: "SCHEDULED_FOR_VERIFICATION",
            resolvedAlertIds,
          });
          store.create("monitor_event", PROJECT, {
            type: "ROLLBACK_ACTIVATED",
            releaseId: item.id,
            recoveryReleaseId: restored.id,
            rollbackId: rollback.id,
            observedAt: new Date().toISOString(),
            status: "RECOVERY_SCHEDULED",
          });
          const planned = plannedLocalRuns({
            releaseId: restored.id,
            packageId: restored.packageId,
            packageDigest: restored.packageDigest,
            businessScheduledFor: restored.businessScheduledFor,
            spec,
            nowMs: options.now?.() ?? Date.now(),
            timeUnitMs: releaseTimeUnitMs,
            triggerReason: "ROLLBACK_RECOVERY",
          });
          for (const runData of planned) {
            const run = store.create("release_run", PROJECT, runData);
            releaseScheduler.schedule(run);
          }
          return json(res, 202, {
            rollback,
            activeRelease: expose(restored),
          });
        }
      }
      const standalonePublication=path.match(/^\/api\/v2\/delivery\/manual\/([a-f0-9-]{36})\/publication(?:\/(cancel))?$/);
      if(standalonePublication){
        const actor=auth.sessionFromHeaders(req.headers);if(!actor)throw fail(401,'请先登录审阅手工交付');
        const delivery=get('manual_delivery_task',standalonePublication[1]);if(delivery.submittedBy!==actor.user.id||delivery.mode!==standaloneManualDeliveryMode)throw fail(403,'手工发布仅属于原代码作者');
        if(!standaloneCloudPublication)throw fail(503,'隔离发布执行器尚未配置；原文件和演练保留');
        if(method==='GET'&&!standalonePublication[2]){
          const selected=publicationSelectorFromUrl(url);if(selected.sourceKind!==undefined&&selected.sourceKind!=='MANUAL')throw fail(422,'独立手工读取不接受Agent来源');
          const selector=validatePublicationSelector({...selected,sourceKind:'MANUAL'},actor.user.id);
          return json(res,200,{protocol:'shuduo-standalone-manual-publication/v1',manualDeliveryTaskId:delivery.id,...await standaloneCloudPublication.detail(delivery.id,selector),scope:'PRIVATE_CLOUD_TEST',agentIndependentE2E:false});
        }
        if(method==='POST'){
          if(url.search)throw fail(422,'发布不能混用查询与正文');const body=await readBody(req),allowed=standalonePublication[2]?['sourceKind','sourceRunId','packageDigest','verificationId','releaseId']:['sourceKind','sourceRunId','packageDigest','verificationId','attestations'];
          if(Object.keys(body).some(k=>!allowed.includes(k))||body.sourceKind!=='MANUAL')throw fail(422,'仅接受当前手工来源与确切版本的审阅');
          const {attestations,...selection}=body,selector=validatePublicationSelector(selection,actor.user.id);
          if(standalonePublication[2]&&!selector.releaseId)throw fail(422,'停止须指定原发布编号');
          const publisher=manualPublisher(()=>{const fresh=auth.requireMutation(req.headers,path);if(fresh.user.id!==delivery.submittedBy)throw fail(403,'审阅身份已变化');assertPublicationMutation(publicationAccess,fresh,method,path,options.now?.()??Date.now());});
          const result=standalonePublication[2]?await publisher.cancel(delivery.id,selector):await publisher.publish({manualDeliveryTaskId:delivery.id,...selector,attestations,idempotencyKey:text(req.headers['idempotency-key'],1,100)});
          return json(res,standalonePublication[2]?200:202,{protocol:'shuduo-standalone-manual-publication/v1',manualDeliveryTaskId:delivery.id,...result,scope:'PRIVATE_CLOUD_TEST',agentIndependentE2E:false});
        }
        throw fail(405,'手工发布操作方法不受支持');
      }
      const standaloneSource=path.match(/^\/api\/v2\/delivery\/manual\/source\/([a-f0-9-]{36})$/),standaloneRecord=path.match(/^\/api\/v2\/delivery\/manual\/([a-f0-9-]{36})(?:\/(advance|cancel))?$/);
      if((standaloneSource&&method==='GET')||(path==='/api/v2/delivery/manual'&&method==='POST')||standaloneRecord){
        const actorId=auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined);
        if(!actorId)throw fail(401,'请先登录查看手工交付');
        const scope=revision=>{
          const session=auth.sessionFromHeaders(req.headers),currentActor=session?.user.id??(local?'local-engineer':undefined);
          if(currentActor!==revision?.author)throw fail(403,'手工交付仅属于原代码作者');
          if(!local||session)auth.requireMutation(req.headers,path);
          requireDevelopmentOwner('revision',revision,req);
          if(developmentAccess?.taskId)throw targetDenied();
          if(ingressChannel==='HTTP')assertDevelopmentMutation(developmentAccess,session,'POST',path,developmentNow());
          assertScopedRecord(session,revision);
        };
        const engine=durableDevelopment?createStandaloneManualDelivery({store,project:PROJECT,runner:durableDevelopment,artifactStore,persist:persistDevelopment,
          assertRunBudget:()=>budget.assertCanStartRemoteSpark(),assertExecutionScope:scope,reservationSeconds:Number(env.V2_REMOTE_SPARK_RESERVATION_SECONDS??30)}):undefined;
        const readable=revision=>{requireDevelopmentOwner('revision',revision,req);assertScopedRecord(auth.sessionFromHeaders(req.headers),revision);};
        const owned=id=>{const task=get('manual_delivery_task',id);if(task.mode!==standaloneManualDeliveryMode||task.submittedBy!==actorId)throw fail(403,'无权访问此手工交付任务');readable(get('revision',task.sourceRevisionId));return task;};
        const packageView=task=>{
          const {bundle:item,verification} = workflowDeliveryEvidence(task);
          return {package:item?{id:item.id,digest:item.digest,manifest:item.manifest,files:item.files}:undefined,verification:verification?{id:verification.id,packageId:verification.packageId,packageDigest:verification.packageDigest,manualDeliveryTaskId:verification.manualDeliveryTaskId,
            status:verification.status,engine:verification.engine,engineVersion:verification.engineVersion,mainSqlExecuted:verification.mainSqlExecuted,testSqlValidation:verification.testSqlValidation,validation:validationWithoutRawComparisons(verification.validation),durationMs:verification.durationMs,error:verification.error}:undefined};
        };
        if(standaloneSource){
          if(url.searchParams.size)throw fail(422,'手工交付来源读取不接受其他参数');
          const proof=resolveManualContinuation({store,project:PROJECT,actorId,sourceRunId:standaloneSource[1]}),run=get('run',proof.binding.runId),revision=get('revision',proof.binding.revisionId),
            all=store.list('manual_delivery_task',PROJECT).filter(t=>t.submittedBy===actorId&&t.sourceRunId===run.id&&t.sourceRevisionId===revision.id),task=all.find(t=>t.sourceBinding?.evidenceDigest===proof.binding.evidenceDigest)??all[0];
          readable(revision);if(task&&engine){workflowDeliveryEvidence(owned(task.id));await engine.reconcile(task.id);}
          const latest=task?owned(task.id):undefined,{taskId:ignored,...baseReport}=developmentVerificationReport({contextId:revision.contextId},run,revision);
          const publicationWindow=latest&&publicationAccess?.sourceKind==='MANUAL_DELIVERY'&&publicationAccess.taskId===latest.id&&publicationAccess.packageDigest===latest.packageDigest&&publicationAccess.verificationId===latest.verificationId&&publicationSession(publicationAccess,auth.sessionFromHeaders(req.headers),developmentNow())?.manualPublicationTaskId===latest.id?{manualDeliveryTaskId:latest.id,packageDigest:publicationAccess.packageDigest,verificationId:publicationAccess.verificationId,startsAt:new Date(publicationAccess.startsAt).toISOString(),expiresAt:new Date(publicationAccess.expiresAt).toISOString()}:undefined;
          return json(res,200,{protocol:'shuduo-standalone-manual-workflow/v1',executionAvailable:Boolean(engine),source:{kind:'MANUAL_RUN',runId:run.id,revisionId:revision.id,revisionHash:revision.hash,contextId:revision.contextId},sourceBinding:proof.binding,developmentReference:proof.developmentReference,
            report:{...baseReport,sourceKind:'MANUAL',sourceAttribution:'ENGINEER_AUTHORED',agentIndependentE2E:false,notice:'手工版本已按登记口径核验；文件与演练独立记录，不调用模型或虚构Agent来源。'},
            sourceCurrent:!latest||latest.sourceBinding?.evidenceDigest===proof.binding.evidenceDigest,delivery:publicDeliveryTask(latest),...packageView(latest),modelRequired:false,
            publication:{available:Boolean(privatePublicationConfig&&standalonePublicationReady&&publicationWindow),scope:'PRIVATE_CLOUD_TEST',reason:privatePublicationConfig&&standalonePublicationReady?'审阅此确切包与成功演练后可创建两个冻结样例批次，由签名定时事件执行；不调用模型，不计自主完成。':'独立手工发布协议已具备；需隔离驱动和本交付确切版本的有效审阅窗口，当前未开放。',
              ...(publicationWindow?{window:publicationWindow}:{})}});
        }
        if(path==='/api/v2/delivery/manual'&&method==='POST'){
          const body=await readBody(req);if(Object.keys(body).length!==1||!Object.hasOwn(body,'sourceBinding'))throw fail(422,'仅接受已读取的手工成功来源绑定');
          if(!engine)throw fail(503,'隔离Spark演练执行器未就绪；不要求模型凭证');
          return json(res,202,await engine.create({actorId,key:text(req.headers['idempotency-key'],1,100),sourceBinding:body.sourceBinding}));
        }
        if(standaloneRecord){
          const task=owned(standaloneRecord[1]);
          if(method==='GET'&&!standaloneRecord[2]){workflowDeliveryEvidence(task);if(engine)await engine.reconcile(task.id);return json(res,200,{protocol:'shuduo-standalone-manual-detail/v1',delivery:publicDeliveryTask(owned(task.id)),...packageView(owned(task.id)),modelRequired:false});}
          if(method==='POST'&&standaloneRecord[2]){
            const body=await readBody(req);if(Object.keys(body).length!==1||body.expectedVersion!==task.version)throw fail(409,'手工交付已更新，请按原编号读取后继续');
            if(!engine)throw fail(503,'隔离Spark执行器未就绪；已有记录保留');
            return json(res,200,standaloneRecord[2]==='advance'?await engine.advance(task.id,task.version):await engine.cancel(task.id));
          }
        }
        throw fail(405,'手工交付操作方法不受支持');
      }
      const manualCloudWorkflow = path.match(/^\/api\/v2\/runs\/([a-f0-9-]{36})\/(workflow|prepare-delivery)$/);
      if (manualCloudWorkflow && (method === "GET" && manualCloudWorkflow[2] === "workflow" || method === "POST" && manualCloudWorkflow[2] === "prepare-delivery")) {
        const actorId = auth.sessionFromHeaders(req.headers)?.user.id;
        if (!actorId) throw fail(401, "请先登录查看人工交付");
        const run = get("run", manualCloudWorkflow[1]); requireDevelopmentOwner("run", run, req);
        await reconcileDevelopment(run);
        const source = manualCloudDeliverySource({store, project: PROJECT, runId: run.id, actorId, requireVerified: method === "POST"});
        if (method === "POST") {
          if (Object.keys(await readBody(req)).length) throw fail(422, "人工交付仅使用当前已核验批次，不接受替换来源");
          if (!durableDelivery || !durableDevelopment) throw fail(503, "云端隔离交付尚未启用");
          assertScopedRecord(auth.sessionFromHeaders(req.headers), source.revision);
          return json(res, 202, await durableDelivery.createManual({runId: run.id, actorId, key: text(req.headers["idempotency-key"], 1, 100)}));
        }
        let delivery = store.list("agent_delivery_task", PROJECT).find(t => t.sourceKind === "MANUAL" && t.sourceAgentTaskId === source.agent.id &&
          t.sourceRevisionId === source.revision.id && t.sourceRunId === run.id && t.submittedBy === actorId);
        if (delivery && durableDelivery) {
          workflowDeliveryEvidence(delivery);
          await durableDelivery.reconcile(delivery.id);
          delivery = get("agent_delivery_task", delivery.id);
        }
        const {bundle, verification} = workflowDeliveryEvidence(delivery);
        return json(res, 200, {report: source.report, delivery: publicDeliveryTask(delivery),
          package: bundle ? {id: bundle.id, digest: bundle.digest, manifest: bundle.manifest, files: bundle.files} : undefined,
          verification: verification ? {id: verification.id, status: verification.status, engine: verification.engine, engineVersion: verification.engineVersion,
            mainSqlExecuted: verification.mainSqlExecuted, testSqlValidation: verification.testSqlValidation, validation: validationWithoutRawComparisons(verification.validation),
            durationMs: verification.durationMs, error: verification.error, finishedAt: verification.finishedAt} : undefined,
          publication: {available: Boolean(privatePublicationConfig && cloudPublication), scope: "PRIVATE_CLOUD_TEST", sourceKind: "MANUAL", sourceRunId: source.run.id,
            agentIndependentE2E: false, reason: privatePublicationConfig && cloudPublication ? "审阅此人工版本的确切包与成功演练后，可创建两个受控云端测试批次；人工来源保留，原开发、参考和费用记录不变。" : bundle?"当前人工辅助交付记录已保留；云端调度驱动尚未配置，发布需在确切包的有效权限范围内进行。":"先生成并演练当前版本的交付文件；云端调度驱动尚未配置，不代表已经发布。"}});
      }
      if (method === "GET" && /^\/api\/v2\/agent\/tasks\/[a-f0-9-]+\/review-evidence$/.test(path)) {
        const selection = parseAgentReviewEvidencePath(req.url);
        if (!selection) throw fail(422, "需提供原任务、交付编号与需求摘要");
        const task = get("agent", selection.taskId);
        requireDurableAgentOwner(task, req);
        const delivery = store.get("agent_delivery_task", selection.deliveryId, PROJECT);
        if (!delivery || delivery.sourceAgentTaskId !== task.id || delivery.submittedBy !== task.submittedBy)
          throw fail(404, "未找到此任务的原交付");
        const {bundle, verification} = workflowDeliveryEvidence(delivery);
        const revision = store.get("revision", delivery.sourceRevisionId ?? "", PROJECT);
        const run = store.get("run", delivery.sourceRunId ?? "", PROJECT);
        return json(res, 200, storedAgentReviewEvidence({task, delivery, bundle, verification, revision, run, requestSha256:selection.requestSha256}));
      }
      const developmentWorkflow = path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/workflow$/);
      if (developmentWorkflow && method === "GET") {
        const agent = get("agent", developmentWorkflow[1]);
        requireDurableAgentOwner(agent, req);
        const source = resolveEvidenceSource(agent, get), revision = source.revision;
        let delivery = source.retainedFailure ? undefined : store.list("agent_delivery_task", PROJECT)
          .find(item => item.sourceAgentTaskId === agent.id && item.sourceRevisionId === revision?.id && item.sourceRunId === source.run?.id);
        workflowDeliveryEvidence(delivery);
        const run = source.retainedFailure || !source.run ? source.run : await reconcileDevelopment(source.run);
        const syncContext = agent.syncInput && run?.status === "SUCCEEDED" && revision
          ? syncDeliveryInputs(run, revision).syncContext : undefined;
        if (syncContext) syncSqlDeliverySource({ agent, run, revision });
        const report = developmentVerificationReport(agent, run, revision, syncContext);
        if(agent.sourceKind==='MANUAL')Object.assign(report,{sourceKind:'MANUAL',agentIndependentE2E:false,notice:'此报告保留人工辅助来源；交付请按当前运行读取人工辅助工作流，不计自主完成。'});
        if (source.retainedFailure) Object.assign(report, {status: "NEEDS_ATTENTION", retainedFailure: true, computationSkipped: true,
          retainedFailureSourceKind:source.sourceKind,retainedRunStatus: run.status, summary: "本次修正没有形成新的 SQL，已保留原失败批次供诊断，没有重新执行或验证通过。",
          notice: source.sourceKind==="EXPLICIT_FAILED_RUN" ? "以下结论来自当前账号明确引用的原失败版本和批次，不是本次修正的新执行结果；本次模型调用照常计入历史，未新增 Spark 计算或可发布交付。" : "以下结论来自此前同一任务、版本和批次的失败记录；本次模型调用照常计入历史，未新增 Spark 计算或可发布交付。"});
        if (delivery?.mode === durableDeliveryMode && durableDelivery && !delivery.sourcePinned && !delivery.rehearsalPinned) {
          await durableDelivery.reconcile(delivery.id);
          delivery = get("agent_delivery_task", delivery.id);
        }
        const {bundle, verification} = workflowDeliveryEvidence(delivery);
        let fundReview;
        if (bundle?.manifest.source.fundSignedExecution && verification?.status === "SUCCEEDED") {
          try {
            fundReview = {status:"READY", digest:fundSignedRehearsalDigest(bundle, verification, fundSignedExecutionFor(bundle))};
          } catch {
            fundReview = {status:"UNAVAILABLE"};
          }
        }
        const fileReviewer=auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined);
        const fileReview=bundle&&(bundle.manifest.source.outputContract||agent.fundPreparation||agent.syncInput)&&verification
          ? localFileReviewFor(bundle, verification, fileReviewer) : undefined;
        return json(res, 200, {
          report,
          ...(fileReview?{fileReview:{id:fileReview.id,status:fileReview.status,packageId:fileReview.packageId,packageDigest:fileReview.packageDigest,verificationId:fileReview.verificationId,reviewedAt:fileReview.reviewedAt,scope:fileReview.scope,
            ...(fileReview.fundRehearsalDigest ? {fundRehearsalDigest:fileReview.fundRehearsalDigest} : {})}}:{}),
          delivery: publicDeliveryTask(delivery),
          package: bundle ? { id: bundle.id, digest: bundle.digest, manifest: bundle.manifest, files: bundle.files } : undefined,
          verification: verification ? { id: verification.id, status: verification.status, engine: verification.engine, engineVersion: verification.engineVersion, mainSqlExecuted: verification.mainSqlExecuted, durationMs: verification.durationMs, error: verification.error, testSqlValidation: verification.testSqlValidation, validation: validationWithoutRawComparisons(verification.validation), finishedAt: verification.finishedAt,
            ...(fundReview ? {fundReview} : {}) } : undefined,
          publication: { available: agent.syncInput ? false : agent.fundPreparation ? localClassicSpark && releaseSchedulerMode === "LOCAL_TIMER" : (!getContext(agent.contextId)?.outputContractId||local&&releaseSchedulerMode==="LOCAL_TIMER") && !source.retainedFailure && (Boolean(privatePublicationConfig) || (local && releaseSchedulerMode === "LOCAL_TIMER")), scope: local ? "LOCAL_TEST_RELEASE" : "PRIVATE_CLOUD_TEST", reason: agent.syncInput ? "冻结持仓已接入本机文件演练与审阅。" : agent.fundPreparation ? "审阅文件后，确认同一冻结业务日的两批本机测试。发布后按原版本查看批次。" : getContext(agent.contextId)?.outputContractId ? "仅本机测试：须明确批准此包与两个冻结虚构证券批次，不调用模型，不是公网或生产上线。" : source.retainedFailure ? "原失败记录仅供诊断；当前修正没有新的计算结果或可发布交付。" : local ? "审阅后可发布本机测试任务并观察实际计时批次。" : privatePublicationConfig ? "审阅此版本后创建两个云端测试批次，由受控定时器触发；使用冻结证券样例，运行与告警留在此页。" : "云端定时驱动未配置；交付演练通过后保留为待发布。" },
        });
      }
      const privatePublication = path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/publication(?:\/(cancel|history|preflight|requests\/([A-Za-z0-9_-]{1,100})))?$/);
      if (privatePublication) {
        const agent = get("agent", privatePublication[1]); requireDurableAgentOwner(agent,req);
        const actorId = auth.sessionFromHeaders(req.headers)?.user.id;
        if (method === "GET" && privatePublication[2] === "history") {
          if (local || agent.executionMode !== durableSqlAgentMode || !actorId || agent.submittedBy !== actorId)
            throw fail(403, "原发布历史仅供任务所属人核验");
          const selector = validatePublicationSelector(publicationSelectorFromUrl(url), actorId);
          if (selector.sourceKind !== "AGENT" || !selector.releaseId || !selector.packageDigest)
            throw fail(422, "请指定原 Agent 发布编号与确切包摘要");
          return json(res, 200, cloudPublicationHistory.savedDetail(agent.id, selector));
        }
        if (method === "POST") {
          if (url.search) throw fail(422, "发布写入仅接受正文中的确切来源，不接受查询参数");
          assertPublicationMutation(publicationAccess, auth.sessionFromHeaders(req.headers), method, path, options.now?.() ?? Date.now());
        }
        if (method==="GET" && (privatePublication[2]==="preflight" || privatePublication[3])) {
          if (local && agent.fundPreparation && privatePublication[2] === "preflight") {
            const selector = validatePublicationSelector(publicationSelectorFromUrl(url), actorId);
            if (selector.releaseId) throw fail(422, "预检须选择原交付版本");
            const { bundle, verification } = selectFundPublication(agent, selector);
            const review = localFileReviewFor(bundle, verification, agent.submittedBy);
            return json(res, 200, fundAgentPublicationPreflight({ bundle, verification, review,
              localClassicSpark, schedulerMode: releaseSchedulerMode, fundSignedExecution:fundSignedExecutionFor(bundle) }));
          }
          if (local) throw fail(503,"确切云端发布预检尚未就绪");
          if (privatePublication[3]) {
            if (url.searchParams.size) throw fail(422,"发布回执只接受原请求编号");
            const read = publicReadOnly || !cloudPublication ? cloudPublicationHistory.savedRequestReceipt : cloudPublication.publicationRequestReceipt;
            return json(res,200,read(agent.id,privatePublication[3],actorId));
          }
          if (!cloudPublication) throw fail(503,"确切云端发布预检尚未就绪");
          const selector = validatePublicationSelector(publicationSelectorFromUrl(url),actorId);
          return json(res,200,await cloudPublication.publicationPreflight(agent.id,selector));
        }
        if (local && method === "GET" && !privatePublication[2]) {
          const selector=url.search?validatePublicationSelector(publicationSelectorFromUrl(url),actorId):undefined;
          if(selector&&selector.sourceKind!=="AGENT")throw fail(422,"本机精确任务发布只接受原生 Agent 来源，不能转用云端人工发布");
          if (agent.fundPreparation) {
            const { bundle, verification } = selectFundPublication(agent, selector);
            return json(res, 200, localTaskPublication(store, PROJECT, agent, selector, (release, batches, events, alerts) => {
              const approval = get("release_approval", release.approvalId), review = get("delivery_review", approval.reviewId);
              if (approval.rehearsalId !== verification.id || batches.length !== 2) throw fail(409, "原基金发布批次未确认");
              assertFundBatch({ bundle, verification, approval, review, release, run: batches[0], batches,
                localClassicSpark, schedulerMode: releaseSchedulerMode, timeUnitMs: releaseTimeUnitMs,
                fundSignedExecution:fundSignedExecutionFor(bundle) });
              assertFundAgentMonitoring({ bundle, verification, release, batches, events, alerts });
            }));
          }
          return json(res,200,localTaskPublication(store,PROJECT,agent,selector));
        }
        if(agent.executionMode!==durableSqlAgentMode)throw fail(422,"云端发布仅支持持久SQL Agent任务");
        if (method==="GET" && !privatePublication[2]) {
          const selector = validatePublicationSelector(publicationSelectorFromUrl(url), actorId);
          const view = publicReadOnly || !cloudPublication
            ? cloudPublicationHistory.savedDetail(agent.id, selector) : await cloudPublication.detail(agent.id, selector);
          return json(res,200,view);
        }
        if (!cloudPublication) throw fail(503,"云端发布执行器尚未配置");
        if (method==="POST" && privatePublication[2]==="cancel") {
          const selector = validatePublicationSelector(await readBody(req), actorId);
          return json(res,200,await cloudPublication.cancel(agent.id, selector));
        }
        if (method==="POST" && !privatePublication[2]) {
          const body=await readBody(req);
          if(Object.keys(body).some(k=>!["sourceKind","sourceRunId","packageDigest","verificationId","attestations","reviewDigest"].includes(k)))throw fail(422,"发布请求包含未支持字段");
          const exact = Object.hasOwn(body,"reviewDigest");
          if (exact && (typeof body.reviewDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.reviewDigest)))
            throw fail(422,"人工审阅摘要格式不合法");
          if (exact && !publicationAccess) throw fail(403,"确切版本须在独立发布窗口提交");
          const selector = validatePublicationSelector({packageDigest:text(body.packageDigest,64,64),verificationId:text(body.verificationId,1,100),
            ...(Object.hasOwn(body,"sourceKind")?{sourceKind:body.sourceKind}:{}),...(Object.hasOwn(body,"sourceRunId")?{sourceRunId:body.sourceRunId}:{})},actorId);
          return json(res,202,await cloudPublication.publish({agent,...selector,attestations:body.attestations,
            ...(exact?{reviewDigest:body.reviewDigest}:{}),idempotencyKey:text(req.headers["idempotency-key"],1,100)}));
        }
      }
      if (path === "/api/v2/agent/deliveries" && method === "GET") {
        const sourceId = url.searchParams.get("sourceAgentTaskId");
        if (sourceId && !/^[a-f0-9-]{36}$/.test(sourceId))
          throw fail(400, "代码Agent任务编号格式不合法");
        return json(
          res,
          200,
          store
            .list("agent_delivery_task", PROJECT)
            .filter((item) => (!sourceId || item.sourceAgentTaskId === sourceId) && mayReadDurableAgent(store.get("agent", item.sourceAgentTaskId, PROJECT) ?? {}, auth.sessionFromHeaders(req.headers)))
            .filter(item => {
              try { workflowDeliveryEvidence(item); return true; }
              catch (error) {
                if (error.status === 403 || error.status === 404) return false;
                throw error;
              }
            })
            .map(publicDeliveryTask),
        );
      }
      const deliveryRequestLookup = path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]{36})\/delivery-requests\/([A-Za-z0-9_-]{1,100})$/);
      if (method === "GET" && deliveryRequestLookup) {
        if (local && (options.ingress || !isLoopbackRequest(req)))
          throw fail(403, "交付请求回执仅在本机评测入口读取");
        if (url.searchParams.size) throw fail(422, "交付回执须按原任务和请求编号读取");
        const [, taskId, key] = deliveryRequestLookup;
        const agent = get("agent", taskId);
        requireDurableAgentOwner(agent, req);
        if (!local && agent.submittedBy !== auth.sessionFromHeaders(req.headers)?.user.id)
          throw fail(403, "交付请求回执仅原任务创建者可读");
        if (!local && agent.executionMode !== durableSqlAgentMode)
          throw fail(409, "云端回执须来自原持久 SQL Agent");
        const durableId = store.deduplicatedId(`${PROJECT}:durable-delivery:${taskId}:${key}`);
        const localId = local ? store.deduplicatedId(`${PROJECT}:agent-delivery:${taskId}:${key}`) : undefined;
        if (durableId && localId) throw fail(409, "原交付请求回执有冲突");
        const id = durableId ?? localId;
        if (!id) throw fail(404, "未找到原交付请求的回执");
        const item = store.get("agent_delivery_task", id, PROJECT);
        const expectedMode = durableId ? durableDeliveryMode : "VERIFIED_ARTIFACT_ORCHESTRATION";
        if (item?.sourceAgentTaskId !== taskId || item.mode !== expectedMode ||
            (item.sourceKind !== undefined && item.sourceKind !== "AGENT") ||
            (item.submittedBy !== undefined && item.submittedBy !== agent.submittedBy))
          throw fail(409, "原交付回执与任务来源不一致");
        if (!local) {
          if (item.submittedBy !== agent.submittedBy) throw fail(409, "原交付回执与任务来源不一致");
          return json(res,200,deliveryReceipt(item));
        }
        return json(res, 200, publicDeliveryTask(item));
      }
      const agentDeliveryRecord = path.match(
        /^\/api\/v2\/agent\/deliveries\/([a-f0-9-]+)(?:\/(cancel|advance))?$/,
      );
      const fundReceiptRecheck = path.match(/^\/api\/v2\/agent\/deliveries\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/recheck-receipt$/);
      if (fundReceiptRecheck && method === "POST") {
        if (!fundRehearsalRecovery || !isLoopbackRequest(req)) throw fail(403, "原演练回执核对仅在本机可用");
        if (url.searchParams.size) throw fail(422, "原演练回执核对不接受查询参数");
        const expectedVersion = readFundRehearsalRecheck(await readBody(req));
        const item = get("agent_delivery_task", fundReceiptRecheck[1]);
        const agent = get("agent", item.sourceAgentTaskId);
        requireDurableAgentOwner(agent, req);
        const stale = () => Object.assign(fail(409, "交付版本已变化，请读取原编号后再核对"), { code: "STALE_DOCUMENT_VERSION" });
        if (item.version !== expectedVersion) throw stale();
        if (!agent.fundPreparation || item.submittedBy !== agent.submittedBy ||
            item.status !== "INTERRUPTED" || item.stage !== "FILE_REHEARSAL_UNCONFIRMED" ||
            !item.signedPackageDigest) throw fail(409, "当前交付没有待核对的基金签名演练回执");
        const { bundle, verification } = workflowDeliveryEvidence(item);
        if (!bundle?.manifest.source.fundSignedExecution || bundle.digest !== item.signedPackageDigest ||
            verification?.status !== "INTERRUPTED") throw fail(409, "原签名交付与演练记录不一致");
        fundRehearsalRecovery.recover(item);
        const updated = get("agent_delivery_task", item.id);
        if (updated.version === expectedVersion) return json(res, 200, fundRehearsalRecheckResult(updated, "UNCONFIRMED"));
        if (updated.version !== expectedVersion + 1 || updated.status !== "SUCCEEDED" ||
            updated.recoveredFromFileReceipt !== true) throw stale();
        return json(res, 200, fundRehearsalRecheckResult(updated, "RECOVERED"));
      }
      if (agentDeliveryRecord) {
        const item = get("agent_delivery_task", agentDeliveryRecord[1]);
        const agent = get("agent", item.sourceAgentTaskId);
        requireDurableAgentOwner(agent, req);
        workflowDeliveryEvidence(item);
        if (item.mode === durableDeliveryMode) {
          if (!durableDelivery) throw fail(503, "持久交付执行器尚未启用");
          if (method === "GET" && !agentDeliveryRecord[2]) {
            if (item.sourcePinned || item.rehearsalPinned) return json(res,200,deliveryReceipt(item));
            return json(res, 200, await durableDelivery.reconcile(item.id));
          }
          if (method === "POST" && agentDeliveryRecord[2] === "advance") {
            const {version,rehearsal} = readDeliveryAdvance(await readBody(req));
            if ((rehearsal || item.sourcePinned || item.rehearsalPinned) && (item.submittedBy !== agent.submittedBy ||
                item.submittedBy !== auth.sessionFromHeaders(req.headers)?.user.id))
              throw fail(403,"确切包演练须由原任务创建者操作");
            const advanced = await durableDelivery.advance(item.id,version,rehearsal);
            return json(res,200,deliveryReceipt(get("agent_delivery_task",advanced.id)));
          }
          if (method === "POST" && agentDeliveryRecord[2] === "cancel") {
            await readBody(req); return json(res, 200, await durableDelivery.cancel(item.id));
          }
        }
        if (method === "GET" && !agentDeliveryRecord[2])
          return json(res, 200, item);
        if (method === "POST" && agentDeliveryRecord[2] === "cancel") {
          await readBody(req);
          if (!terminal.has(item.status)) {
            store.update("agent_delivery_task", item.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(item.id)?.abort();
          }
          return json(res, 200, get("agent_delivery_task", item.id));
        }
      }
      const prepareAgentDelivery = path.match(
        /^\/api\/v2\/agent\/tasks\/([a-f0-9-]+)\/prepare-delivery$/,
      );
      if (prepareAgentDelivery && method === "POST") {
        const expected = readDeliveryPreparationSource(await readBody(req),prepareAgentDelivery[1]);
        const agent = get("agent", prepareAgentDelivery[1]),
          finalAttempt = agent.attempts?.at(-1);
        requireDurableAgentOwner(agent, req);
        if (agent.syncInput) requireSyncSqlLocal(req);
        if (expected && agent.submittedBy !== auth.sessionFromHeaders(req.headers)?.user.id)
          throw fail(403,"确切版本交付须由原任务创建者提交");
        if (expected && agent.executionMode !== durableSqlAgentMode)
          throw fail(409,"确切版本交付须来自原云端持久 SQL 任务");
        if(agent.repairComparison!==undefined||agent.sourceKind==='MANUAL'||agent.sourceAttribution!==undefined)throw fail(409,'人工辅助修正的开发结果已保留；人工辅助交付须独立审阅，当前不能作为原生Agent成果发布');
        if (agent.executionMode === durableSqlAgentMode) {
          if (!durableDelivery) throw fail(503, "持久交付执行器尚未启用");
          const key = text(req.headers["idempotency-key"], 1, 100);
          return json(res, 202, await durableDelivery.create(agent, key, expected));
        }
        if (agent.language === "PYTHON")
          return preparePythonAgentDelivery(agent, req, res);
        if (agent.status !== "SUCCEEDED" || finalAttempt?.status !== "SUCCEEDED")
          throw fail(409, "只有代码Agent与独立断言通过后才能准备交付");
        const run = get("run", finalAttempt.runId), rev = get("revision", finalAttempt.revisionId);
        const fund = isFundContext(agent.contextId);
        if (fund) {
          assertPreparedFundSource({ agent, run, revision: rev });
        } else if (!agent.syncInput) {
          const codeJourney = agentEvidenceJourney({ store, project: PROJECT, task: agent });
          if (codeJourney.stages.find(item => item.id === "CODE")?.status !== "SUCCEEDED" ||
              codeJourney.stages.find(item => item.id === "DEBUG")?.status !== "SUCCEEDED")
            throw fail(409, "缺少真实模型和Spark独立结果证据，不能委托交付准备");
        }
        if(getContext(agent.contextId)?.outputContractId&&!local)throw fail(422,"分布交付当前仅支持本机");
        if (!options.deliveryRunner && !options.runner && !runtime.available)
          throw fail(503, "按文件Spark演练尚未就绪");
        const candidate = createAgentBundle({ run, revision: rev, agent });
        const signedPackageDigest = candidate.manifest.source.fundSignedExecution ? candidate.digest : undefined;
        const requirement = agent.requirements ? sqlRequirementBinding(agent.requirements) : undefined;
        const existing = store.list("agent_delivery_task", PROJECT).find(item =>
          item.mode === "VERIFIED_ARTIFACT_ORCHESTRATION" && item.sourceAgentTaskId === agent.id &&
          item.sourceRevisionId === rev.id && item.sourceRunId === run.id && item.sourceSqlHash === rev.hash &&
          item.signedPackageDigest === signedPackageDigest &&
          JSON.stringify(item.sourceRequirementBinding) === JSON.stringify(requirement) &&
          (fund || ["QUEUED", "RUNNING", "SUCCEEDED"].includes(item.status)));
        if (existing?.packageId) {
          const existingBundle = get("delivery_package", existing.packageId);
          assertRequirementSource(existingBundle);
          if (signedPackageDigest && (existingBundle.digest !== signedPackageDigest || existingBundle.agentDeliveryTaskId !== existing.id))
            throw fail(409, "已登记的基金签名交付与原任务不一致");
        }
        if (existing && req.headers["idempotency-key"] === undefined) return json(res, 200, existing);
        const key = text(req.headers["idempotency-key"], 1, 100);
        const namespace = `${PROJECT}:agent-delivery:${agent.id}:${key}`;
        const signature = hash(JSON.stringify({
          agentTaskId:agent.id, runId:run.id, revisionHash:rev.hash, ...(requirement ? {requirement} : {}),
          ...(signedPackageDigest ? { signedPackageDigest } : {}),
        }));
        const dedup = store.deduplicate(namespace, signature, () => existing ?? store.create("agent_delivery_task", PROJECT, {
          sourceAgentTaskId:agent.id, sourceRunId:run.id, sourceRevisionId:rev.id, sourceSqlHash:rev.hash,
          ...(fund || agent.syncInput ? { submittedBy: agent.submittedBy } : {}),
          ...(requirement ? {sourceRequirementBinding:requirement} : {}),
          ...(signedPackageDigest ? { signedPackageDigest } : {}),
          status:"QUEUED", stage:"QUEUED", mode:"VERIFIED_ARTIFACT_ORCHESTRATION",
          completionScope:"DELIVERY_PREPARATION", fullLifecycleE2E:false, agentIndependentE2E:false, publicDeployed:false,
        }));
        const task = get("agent_delivery_task", dedup.id);
        if (existing) {
          fundRehearsalRecovery?.recover(task);
          return json(res, 200, get("agent_delivery_task", task.id));
        }
        if (!dedup.replayed)
          schedule("agent_delivery_task", task, async (signal) => {
            if (signal.aborted) throw new Error("交付准备已取消");
            const sourceRun = get("run", task.sourceRunId),
              sourceRevision = get("revision", task.sourceRevisionId),
              approvedPackageIds = new Set(
                store
                  .list("release_approval", PROJECT)
                  .filter((item) => item.status === "APPROVED")
                  .map((item) => item.packageId),
              );
            const sourceAgent=get('agent',task.sourceAgentTaskId);
            if (fund) assertPreparedFundSource({ agent: sourceAgent, run: sourceRun, revision: sourceRevision });
            if(JSON.stringify(task.sourceRequirementBinding)!==JSON.stringify(sourceAgent.requirements?sqlRequirementBinding(sourceAgent.requirements):undefined))throw fail(409,'交付任务的原需求依据已变化');
            const bundle = createAgentBundle({ agent: sourceAgent, run: sourceRun, revision: sourceRevision });
            const signed = bundle.manifest.source.fundSignedExecution !== undefined;
            if ((signed ? bundle.digest : undefined) !== task.signedPackageDigest)
              throw fail(409, "交付任务的原签名回执已变化");
            let packageItem = store
              .list("delivery_package", PROJECT)
              .find(
                (item) =>
                  item.sourceRunId === sourceRun.id &&
                  item.manifest?.source?.revisionId === sourceRevision.id &&
                  JSON.stringify(item.manifest?.source?.requirement)===JSON.stringify(task.sourceRequirementBinding)&&
                  (signed ? item.digest === bundle.digest && item.agentDeliveryTaskId === task.id :
                    item.manifest?.source?.fundSignedExecution === undefined) &&
                  !approvedPackageIds.has(item.id) &&
                  item.published !== true,
              );
            if (packageItem) {
              await ensureDeliveryArtifact(packageItem);
              packageItem = get("delivery_package", packageItem.id);
              validateDeliveryPackage(packageItem, packageItem.digest);
              assertRequirementSource(packageItem);
            } else {
              const artifact = await artifactStore.put(
                  "delivery-package",
                  bundle.digest,
                  bundle,
                );
              if (signal.aborted) throw new Error("交付准备已取消");
              assertRequirementSource(bundle);
              packageItem = store.create("delivery_package", PROJECT, {
                ...bundle,
                artifact,
                sourceRunId: sourceRun.id,
                agentDeliveryTaskId: task.id,
                stage: "M2A",
                published: false,
              });
            }
            store.update("agent_delivery_task", task.id, PROJECT, {
              stage: "PACKAGE_READY",
              packageId: packageItem.id,
              packageDigest: packageItem.digest,
            });
            const plan = validateDeliveryPackage(packageItem, packageItem.digest),
              scheduledFor = fundRehearsalAt(plan.source.contextId) ?? "2026-09-11T09:00:00+08:00",
              occurrence = resolveDeliverySchedule(plan, scheduledFor);
            if (
              !occurrence.eligible ||
              occurrence.businessDate !== plan.fixtures.context.businessDate
            )
              throw new Error("冻结交易日和交付输入不匹配，未执行演练");
            if (signal.aborted) throw new Error("交付准备已取消");
            if (plan.source.syncInput) {
              const original = store.list("delivery_verification", PROJECT).find(record =>
                record.packageId === packageItem.id && record.packageDigest === packageItem.digest &&
                record.scheduledFor === scheduledFor && ["QUEUED", "RUNNING", "SUCCEEDED"].includes(record.status));
              if (original) {
                if (original.status !== "SUCCEEDED") throw fail(409, "原文件演练仍在执行，请查看已有回执");
                assertSyncSqlRehearsal(plan, packageItem, original);
                return store.update("agent_delivery_task", task.id, PROJECT, {
                  status: "SUCCEEDED", stage: "AWAITING_ENGINEER_REVIEW", actualExecution: true,
                  verificationId: original.id, finishedAt: new Date().toISOString(),
                  notice: "已核对并复用原冻结持仓的文件演练回执。",
                });
              }
            }
            const verification = store.create("delivery_verification", PROJECT, {
              packageId: packageItem.id,
              packageDigest: packageItem.digest,
              scheduledFor,
              agentDeliveryTaskId: task.id,
              status: "RUNNING",
              scope: "M2A_LOCAL_FILE_REHEARSAL",
              published: false,
              fullLifecycleE2E: false,
            });
            store.update("agent_delivery_task", task.id, PROJECT, {
              stage: "FILE_REHEARSAL_RUNNING",
              verificationId: verification.id,
            });
            try {
              const parent = join(root, ".v2-artifacts", "agent-deliveries");
              mkdirSync(parent, { recursive: true });
              const directory = unpackDeliveryPackage(
                  packageItem,
                  join(parent, task.id),
                  packageItem.digest,
                ),
                executeFiles =
                  options.deliveryRunner ??
                  ((input) => verifyDeliveryDirectory(input, { runtime, runner,
                    fundSignedExecution: fundSignedExecutionFor(packageItem) }));
              let receipt = await executeFiles({
                  directory,
                  expectedDigest: packageItem.digest,
                  scheduledFor,
                  signal,
                });
              if (signal.aborted || get("agent_delivery_task", task.id).status === "CANCELLED") {
                store.update("delivery_verification", verification.id, PROJECT, {
                  status: "CANCELLED",
                  finishedAt: new Date().toISOString(),
                });
                return;
              }
              let actual =
                receipt.status === "SUCCEEDED" &&
                receipt.engine === "Apache Spark" &&
                receipt.engineVersion === plan.deployment.runtime.version &&
                receipt.mainSqlExecuted === true &&
                receipt.validation?.passed === true &&
                receipt.testSqlValidation?.passed === true &&
                receipt.testSqlValidation.sqlHash === hash(packageItem.files["tests.sql"]) &&
                receipt.testDouble !== true;
              if (actual && fund) {
                assertRequirementSource(packageItem);
                if (signed) {
                  fundRehearsalRecovery.complete(get("agent_delivery_task", task.id), packageItem, verification, receipt);
                  return;
                }
                assertFundRehearsal(packageItem, { ...verification, ...receipt });
              }
              if (actual && plan.source.syncInput) {
                assertRequirementSource(packageItem);
                receipt = checkedSyncSqlFileRehearsal(plan, packageItem, receipt);
                actual = receipt.status === "SUCCEEDED";
              }
              store.update("delivery_verification", verification.id, PROJECT, {
                ...receipt,
                status: actual ? "SUCCEEDED" : "FAILED",
                published: false,
                fullLifecycleE2E: false,
                finishedAt: new Date().toISOString(),
              });
              if (!actual)
                throw new Error("按文件演练未形成真实Spark与独立测试证据");
              store.update("agent_delivery_task", task.id, PROJECT, {
                status: "SUCCEEDED",
                stage: "AWAITING_ENGINEER_REVIEW",
                actualExecution: true,
                verificationId: verification.id,
                finishedAt: new Date().toISOString(),
                notice:
                  "已自动生成不可变文件并完成真实Spark演练；审批、发布和公网部署仍须工程师审阅，不计Agent自主完整E2E。",
              });
            } catch (error) {
              if (get("delivery_verification", verification.id).status === "RUNNING")
                store.update("delivery_verification", verification.id, PROJECT, {
                  status: signal.aborted ? "CANCELLED" : "FAILED",
                  errorCode: error.code ?? "FILE_REHEARSAL_FAILED",
                  finishedAt: new Date().toISOString(),
                });
              throw new Error("交付文件演练失败，已保存运行编号供工程师检查");
            }
          });
        return json(res, 202, publicAgentIntent(task));
      }
      const schemaRead = path.match(/^\/api\/v2\/runs\/([a-f0-9-]{36})\/output-schema$/);
      if (schemaRead && method === "GET") {
        if (url.searchParams.size) throw fail(422, "输出结构只接受原运行编号");
        const run = get("run", schemaRead[1]);
        requireDevelopmentOwner("run", run, req);
        const schema = syncSqlOutputSchemaDetails(run, store.get("revision", run.revisionId ?? "", PROJECT));
        if (!schema) throw fail(409, "原运行、版本或冻结快照的输出结构未能核对");
        return json(res, 200, schema);
      }
      const comparisonRead=path.match(/^\/api\/v2\/runs\/([a-f0-9-]{36})\/(comparison|comparison-candidates|repair-comparison)$/);
      if(comparisonRead&&method==='GET'){
        const current=get('run',comparisonRead[1]);requireDevelopmentOwner('run',current,req);
        if(comparisonRead[2]==='comparison-candidates'){
          if(url.searchParams.size)throw fail(422,'运行候选读取不接受其他参数');
          const revision=get('revision',current.revisionId),session=auth.sessionFromHeaders(req.headers),all=store.list('run',PROJECT).filter(r=>r.id!==current.id&&['SUCCEEDED','VALIDATION_FAILED','FAILED','CANCELLED','INTERRUPTED'].includes(r.status)&&mayReadRun(r,session)&&store.get('revision',r.revisionId,PROJECT)?.contextId===revision.contextId);
          return json(res,200,{protocol:'shuduo-run-comparison-candidates/v1',currentRunId:current.id,contextId:revision.contextId,truncated:all.length>50,candidates:all.slice(0,50).map(r=>{const rev=store.get('revision',r.revisionId,PROJECT);return{runId:r.id,revisionId:rev.id,revisionHash:r.revisionHash,contextId:rev.contextId,runStatus:r.status,createdAt:r.createdAt,sourceKind:rev.source==='MANUAL'?'MANUAL':'AGENT_OR_OTHER'};})});
        }
        if([...url.searchParams.keys()].some(k=>k!=='baseline_run_id')||url.searchParams.getAll('baseline_run_id').length!==1||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(url.searchParams.get('baseline_run_id')??''))throw fail(422,'需要一个确切的基线运行编号');
        const baseline=get('run',url.searchParams.get('baseline_run_id'));requireDevelopmentOwner('run',baseline,req);
        if(comparisonRead[2]==='repair-comparison'){
          const revision=get('revision',current.revisionId),actorId=auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined);
          return json(res,200,resolveSqlRepairComparison({store,project:PROJECT,actorId,sourceRunId:current.id,baselineRunId:baseline.id,currentSql:revision.sql,contextId:revision.contextId}));
        }
        return json(res,200,compareSqlRuns({store,project:PROJECT,current,baseline}));
      }
      const manualContinuationRead=path.match(/^\/api\/v2\/runs\/([a-f0-9-]{36})\/manual-continuation$/);
      if(manualContinuationRead&&method==='GET'){
        if(url.searchParams.size)throw fail(422,'手工续改依据不接受其他参数');
        const run=get('run',manualContinuationRead[1]);requireDevelopmentOwner('run',run,req);
        const actorId=auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined);
        return json(res,200,resolveManualContinuation({store,project:PROJECT,actorId,sourceRunId:run.id}));
      }
      const continuationRead=path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]{36})\/assisted-continuation$/);
      if(continuationRead&&method==='GET'){
        if(url.searchParams.size)throw fail(422,'续改依据读取不接受其他参数');
        const parent=get('agent',continuationRead[1]);requireDurableAgentOwner(parent,req);
        const actorId=auth.sessionFromHeaders(req.headers)?.user.id??(local?'local-engineer':undefined);
        return json(res,200,resolveAssistedContinuation({store,project:PROJECT,actorId,taskId:parent.id}));
      }
      const record = path.match(
        /^\/api\/v2\/(runs|revisions|agent\/tasks)\/([a-f0-9-]+)(?:\/(cancel|bundle|journey))?$/,
      );
      if (record) {
        const kind = {
            runs: "run",
            revisions: "revision",
            "agent/tasks": "agent",
          }[record[1]],
          original = get(kind, record[2]);
        if (kind !== "agent") requireDevelopmentOwner(kind, original, req);
        const item = kind === "run" ? await reconcileDevelopment(original) : original;
        if (kind === "agent") requireDurableAgentOwner(item, req);
        if (method === "GET" && !record[3]) return json(res, 200, kind === "run" ? exposeDevelopmentRun(item) : kind === "agent" ? exposeDurableTask(item) : item);
        if (method === "GET" && record[3] === "journey" && kind === "agent")
          return json(
            res,
            200,
            agentEvidenceJourney({ store, project: PROJECT, task: item }),
          );
        if (
          method === "POST" &&
          record[3] === "cancel" &&
          kind !== "revision"
        ) {
          if (kind === "agent" && item.executionMode === durableSqlAgentMode) {
            if (!durableAgent) throw fail(503, "持久 Agent 取消接口尚未启用");
            return json(res, 200, await durableAgent.cancel(item.id));
          }
          if (!terminal.has(item.status)) {
            if (kind === "run" && item.remoteSubmission) {
              if (!durableDevelopment) throw fail(503, "云端执行器尚未就绪，取消请求未提交");
              await durableDevelopment.cancel(item.remoteSubmission.prepared);
            }
            store.update(kind, item.id, PROJECT, { status: "CANCELLED" });
            controls.get(item.id)?.abort();
          }
          return json(res, 200, kind === "run" ? exposeDevelopmentRun(get(kind, item.id)) : get(kind, item.id));
        }
        if (method === "GET" && record[3] === "bundle" && kind === "run") {
          if (item.status !== "SUCCEEDED")
            throw fail(409, "只有经过结果验证的运行可以导出验证包");
          const rev = get("revision", item.revisionId);
          const validation = validationWithoutRawComparisons(item.validation);
          return json(res, 200, {
            format: "shuduo-verification-bundle/v1",
            revision: rev,
            validation,
            engine: item.engine,
            engineVersion: item.engineVersion,
            rows: item.rows,
            files: {
              "main.sql": rev.sql,
              "validation.json": JSON.stringify(validation, null, 2),
            },
            releaseState: "NOT_PUBLISHED",
            currentValidationContractId: validationFamily(rev.contextId).id,
            requiresRevalidation:
              item.validation?.contractId !== validationFamily(rev.contextId).id,
            notice: "这是代码与验证包。实际调度、部署和发布在 M2 实现。",
          });
        }
      }
      const manualRevisionRequest = path.match(/^\/api\/v2\/revisions\/requests\/([A-Za-z0-9_-]{1,100})$/);
      if (method === "GET" && manualRevisionRequest) {
        const actor = auth.sessionFromHeaders(req.headers)?.user.id ?? (local ? "local-engineer" : undefined);
        if (!actor) throw fail(401,"请先登录以查询原保存请求");
        const saved=savedManualRevision({store,project:PROJECT,actor,key:manualRevisionRequest[1]});
        if (!saved) return json(res,200,{status:"NOT_FOUND",notice:"当前身份尚未查到这个保存请求；未创建版本或运行。"});
        await persistDevelopment(); // Confirm pending durable metadata before saying the save is recovered.
        return json(res,200,{status:"SAVED",revision:saved});
      }
      if (method === "POST" && path === "/api/v2/revisions") {
        const body = await readBody(req),
          sql = text(body.sql),
          contextId = text(body.contextId, 1, 80);
        const context = getContext(contextId);
        if (!context) throw fail(400, "请选择有效上下文");
        assertClassicSqlContext(context);
        if (Object.keys(body).some(key=>!["sql","contextId","originAgentTaskId"].includes(key))) throw fail(400,"代码保存包含未支持字段");
        const session=auth.sessionFromHeaders(req.headers), actor=session?.user.id ?? (local ? "local-engineer" : undefined);
        if (!actor) throw fail(401,"请先登录后保存代码");
        const originAgentTaskId=body.originAgentTaskId === undefined ? undefined : text(body.originAgentTaskId,1,80);
        if (developmentAccess?.taskId && originAgentTaskId !== developmentAccess.taskId) throw targetDenied();
        let syncInput;
        if (originAgentTaskId) {
          const origin=get("agent",originAgentTaskId);
          requireDurableAgentOwner(origin,req);
          if (ingressChannel === 'HTTP') assertScopedRecord(session, origin);
          if (!local && session?.role !== "ADMIN" && origin.submittedBy !== actor) throw fail(403,"无权引用该人工接管来源");
          if (origin.contextId !== contextId) throw fail(409,"接管来源与代码业务口径不一致");
          if (origin.syncInput) {
            requireSyncSqlLocal(req);
            readSyncSqlInput({ ...syncSqlResources, actorId: actor, binding: origin.syncInput });
            syncInput = origin.syncInput;
          }
        }
        const key=req.headers["idempotency-key"] === undefined ? undefined : text(req.headers["idempotency-key"],1,100);
        if (key && !/^[A-Za-z0-9_-]+$/.test(key)) throw fail(400,"代码保存请求编号不合法");
        const result=saveManualRevision({store,project:PROJECT,actor,key,sql,contextId,originAgentTaskId,syncInput});
        return json(res,result.replayed ? 200 : 201,result.revision);
      }
      if (method === "POST" && path === "/api/v2/runs") {
        const body = await readBody(req),
          rev = get("revision", text(body.revisionId, 1, 80));
        requireDevelopmentOwner("revision", rev, req);
        if (rev.syncInput) {
          requireSyncSqlLocal(req);
          readSyncSqlInput({ ...syncSqlResources, actorId: rev.author, binding: rev.syncInput });
        }
        assertClassicSqlContext(getContext(rev.contextId));
        if (ingressChannel === 'HTTP') assertScopedRecord(auth.sessionFromHeaders(req.headers), rev);
        if (!options.runner && !runtime.available)
          throw fail(503, "Spark 尚未就绪，请运行 npm run v2:bootstrap");
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(JSON.stringify({ revisionId: rev.id }));
        const dedup = store.deduplicate(
          PROJECT + ":run:" + key,
          signature,
          () => {
            if (durableDevelopment) budget.assertCanStartRemoteSpark();
            return store.create("run", PROJECT, {
              validationContractId:rev.syncInput ? syncSqlContractId : validationFamily(rev.contextId).id,
              ...(rev.syncInput ? { syncInput: rev.syncInput } : {}),
              revisionId: rev.id,
              revisionHash: rev.hash,
              contextId: rev.contextId,
              status: "QUEUED",
            });
          },
        );
        const run = get("run", dedup.id);
        if (durableDevelopment) {
          const submitted = await submitDurableDevelopment(run, rev, {
            runner: durableDevelopment, store, project: PROJECT, persist: persistDevelopment,
            context: getContext(rev.contextId), validationContexts: validationContextsFor(rev.contextId),
          });
          return json(res, 202, exposeDevelopmentRun(submitted));
        }
        if (!dedup.replayed)
          schedule("run", run, (signal) => execute(run, rev, signal));
        return json(res, 202, exposeDevelopmentRun(run));
      }
      if (method === "GET" && /^\/api\/v2\/agent\/tasks\/[^/]+\/fund-execution-preflight$/.test(path)) {
        const session = auth.sessionFromHeaders(req.headers);
        if (!session) throw Object.assign(fail(401, "请先登录受邀开发账号"), { code:"AUTHENTICATION_REQUIRED" });
        if (!["ADMIN", "ENGINEER"].includes(session.role))
          throw Object.assign(fail(403, "基金执行预检仅向受邀开发人员开放"), { code:"PROJECT_PERMISSION_DENIED" });
        const selection = parseFundExecutionPreflightPath(req.url);
        if (!selection) throw fail(422, "基金预检须指定原任务、准备编号、版本、运行及口径摘要");
        return json(res, 200, fundExecutionPreflight({ store, project:PROJECT, actorId:session.user.id, selection }));
      }
      const fundPreparationRead = path.match(/^\/api\/v2\/agent\/fund-preparations\/requests\/([a-f0-9-]{36})$/);
      if ((method === "POST" && path === "/api/v2/agent/fund-preparations") || (method === "GET" && fundPreparationRead)) {
        if (!localClassicSpark || options.ingress || !isLoopbackRequest(req))
          throw fail(403, "基金需求准备仅在本机 Spark 工作台开放");
        if (url.searchParams.size) throw fail(422, "基金需求准备不接受附加查询参数");
        const actor = auth.sessionFromHeaders(req.headers)?.user.id ?? "local-engineer";
        if (fundPreparationRead) return json(res, 200, fundPreparations.read(fundPreparationRead[1], actor));
        const { receipt, replayed } = fundPreparations.submit(await readBody(req), actor, req.headers["idempotency-key"]);
        return json(res, replayed ? 200 : 201, receipt);
      }
      if (method === "POST" && path === "/api/v2/agent/intents") {
        const body = await readBody(req),
          message = validateAgentIntentMessage(body.message),
          approvalMode = validateAgentApprovalMode(body.approvalMode),
          session = auth.sessionFromHeaders(req.headers),
          submittedBy = session?.user.id ?? "local-engineer";
        const reportSource=body.reportSource===undefined?undefined:publishedReportSource(body.reportSource);
        if(reportSource)publishedPlanContext(reportSource,submittedBy);
        if (!options.intentPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(JSON.stringify({ message, approvalMode,...(reportSource?{reportSource}:{}) })),
          dedup = store.deduplicate(
            `${PROJECT}:agent-intent:${key}`,
            signature,
            () =>
              store.create("agent_intent", PROJECT, {
                messageHash: hash(message),
                messageLength: message.length,
                approvalMode,
                submittedBy,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "CROSS_MODULE_INTENT_ROUTING",
                execution: "NO_EXECUTION",
                fullLifecycleE2E: false,
                publicDeployed: false,
                ...(reportSource?{reportSource}:{}),
              }),
          ),
          task = get("agent_intent", dedup.id);
        if (!dedup.replayed)
          schedule("agent_intent", task, async (signal) => {
            const generated = await intentPlanner({
                message,
                destinations: publicAgentIntentDestinations(),
                signal,
              });
            if (get("agent_intent", task.id).status === "CANCELLED") return;
            const route = validateAgentIntentRoute(generated.route);
            store.update("agent_intent", task.id, PROJECT, {
              status: "SUCCEEDED",
              route,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
            store.create("agent_intent_trace", PROJECT, {
              intentId: task.id,
              sequence: 1,
              kind: "MODEL_ROUTE",
              status: "SUCCEEDED",
              model: generated.model,
              usage: generated.usage,
              input: {
                messageHash: task.messageHash,
                messageLength: task.messageLength,
              },
              output: {
                destinationId: route.destinationId,
                stepCount: route.steps.length,
                confidence: route.confidence,
              },
              execution: "NO_EXECUTION",
              observedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, publicAgentIntent(task));
      }
      if (method === "GET" && path === "/api/v2/development/synced-positions") {
        requireSyncSqlLocal(req);
        if (url.searchParams.size) throw fail(422, "同步开发输入不接受附加参数");
        const { selection, source } = currentSyncSqlInput(syncSqlResources);
        return json(res, 200, { selection, ...source, contextId: syncSqlContextId });
      }
      if (method === "POST" && path === "/api/v2/agent/tasks") {
        const body = await readBody(req),
          message = text(body.message, body.clarification===undefined?4:1, body.clarification===undefined?2000:1000),
          language =
            body.language === undefined
              ? "SPARK_SQL"
              : text(body.language, 3, 20),
          suppliedCode = body.code ?? body.sql;
        const fundRequest = body.fundPreparation !== undefined;
        let syncSelection;
        if (body.syncInput !== undefined) {
          requireSyncSqlLocal(req);
          if (language !== "SPARK_SQL" || body.contextId !== syncSqlContextId ||
              Object.keys(body).some(key => !["message", "sql", "language", "contextId", "syncInput"].includes(key)))
            throw fail(422, "同步批次只支持客户资产 T+1 的本机 SQL 开发");
          syncSelection = parseSyncSqlSelection(body.syncInput);
        }
        if (fundRequest && (language !== "SPARK_SQL" || !localClassicSpark || durableAgent || options.ingress ||
            !isLoopbackRequest(req) || Object.keys(body).some(key => !["message", "language", "contextId", "fundPreparation"].includes(key))))
          throw Object.assign(fail(422, "基金准备只支持本机 Spark SQL，不能混用代码或其他来源"), { code: "FUND_PREPARATION_EXECUTION_INVALID" });
        let currentCode = fundRequest ? undefined : text(suppliedCode, 1, 20_000);
        if(body.clarification!==undefined){
          if(Object.keys(body).some(k=>!['message','sql','code','language','contextId','clarification','background'].includes(k)))throw fail(422,'澄清请求包含未支持字段');
          if(language!=='SPARK_SQL'||[body.sourceRunId,body.sourceError,body.derivation,body.repairComparison,body.assistedContinuation,body.manualContinuation].some(v=>v!==undefined)||body.code!==undefined&&body.sql!==undefined&&body.code!==body.sql)throw fail(422,'澄清答复只能绑定原SQL问题，不能混用其他来源');
          currentCode=suppliedCode;
        }
        if(body.manualContinuation!==undefined){
          if(language!=='SPARK_SQL'||[body.sourceRunId,body.sourceError,body.derivation,body.repairComparison,body.assistedContinuation].some(v=>v!==undefined)||body.code!==undefined&&body.sql!==undefined&&body.code!==body.sql)throw Object.assign(fail(422,'手工成功版本不能混用其他续改来源'),{code:'MANUAL_CONTINUATION_CONFLICT'});
          if(!durableAgent)throw fail(503,'手工成功版本续改需要持久SQL执行器，不回退普通任务');
          currentCode=suppliedCode;
        }
        if(body.assistedContinuation!==undefined){
          if(language!=='SPARK_SQL'||[body.sourceRunId,body.sourceError,body.derivation,body.repairComparison].some(v=>v!==undefined)||body.code!==undefined&&body.sql!==undefined&&body.code!==body.sql)
            throw Object.assign(fail(422,'续改只接受同一成功版本，不能混用失败来源或口径派生'),{code:'ASSISTED_CONTINUATION_CONFLICT'});
          if(!durableAgent)throw fail(503,'成功版本续改需要持久SQL执行器，未创建普通任务');
          currentCode=suppliedCode;
        }
        if(body.repairComparison!==undefined){
          if(language!=='SPARK_SQL'||body.sourceRunId===undefined||body.derivation!==undefined||body.sourceError!==undefined||
            body.code!==undefined&&body.sql!==undefined&&body.code!==body.sql)throw fail(422,'对照修正仅支持同一失败SQL来源，不能混用口径派生或自填诊断');
          currentCode=suppliedCode;
        }
        if (body.derivation !== undefined) {
          if (language !== "SPARK_SQL" || body.sourceRunId !== undefined || body.sourceError !== undefined ||
              body.code !== undefined && body.sql !== undefined && body.code !== body.sql)
            throw Object.assign(fail(422, "成功版本口径变更仅支持原生 SQL，不能混用失败来源或不同代码"), {code:"AGENT_CONTEXT_DERIVATION_CONFLICT"});
          currentCode = suppliedCode; // Preserve the exact saved SQL bytes/hash.
        }
        if(body.background!==undefined && typeof body.background!=="boolean")throw fail(422,"后台选项必须为布尔值");
        if(body.background && (!agentEventDriver || language!=="SPARK_SQL"))throw Object.assign(fail(503,"此环境未启用Spark SQL事件后台"),{code:"AGENT_EVENT_DRIVER_DISABLED"});
        if (!["SPARK_SQL", "PYTHON"].includes(language))
          throw fail(422, "数据开发语言不受支持");
        const context = getContext(text(body.contextId, 1, 80));
        if (!context) throw fail(400, "请选择有效上下文");
        if (isFundContext(context.id) !== fundRequest)
          throw fail(422, "基金 Agent 开发须绑定已保存的基金准备，其他口径不适用");
        if(context.outputContractId&&(!local||durableDevelopment||runnerDescriptor.isolation!=="LOCAL_PROCESS"))throw Object.assign(fail(422,"分布Agent尚未启用云端执行"),{code:"OUTPUT_CONTRACT_LOCAL_ONLY"});
        if (ingressChannel === "HTTP") assertDevelopmentTaskCreation(developmentAccess, auth.sessionFromHeaders(req.headers), store, PROJECT, text(req.headers["idempotency-key"], 1, 100), language, options.now?.() ?? Date.now(), body);
        const actorId = language === "SPARK_SQL"
          ? auth.sessionFromHeaders(req.headers)?.user.id ?? (local ? "local-engineer" : undefined)
          : local ? "local-engineer" : auth.sessionFromHeaders(req.headers)?.user.id;
        const resolveFundExecution = () => fundPreparations.bindExecution(body.fundPreparation, actorId,
          { contextId: context.id, message, requestKey: req.headers["idempotency-key"] });
        const fundPreparation = fundRequest ? resolveFundExecution() : undefined;
        const mode = (fundPreparation || syncSelection) && options.generator ? "SYNTHETIC_MODEL" : "LIVE_MODEL";
        const clarification=body.clarification===undefined?undefined:resolveSqlClarification({store,project:PROJECT,actorId,binding:body.clarification,contextId:context.id,currentSql:currentCode,answer:message});
        const derivedFrom = body.derivation === undefined ? undefined : resolveAgentContextDerivation({derivation:body.derivation, actorId,
          targetContextId:context.id,currentSql:currentCode,project:PROJECT,read:(kind,id)=>store.get(kind,id,PROJECT)});
        const repairBasis=body.repairComparison===undefined?undefined:resolveSqlRepairComparison({store,project:PROJECT,actorId,sourceRunId:body.sourceRunId,
          contextId:context.id,currentSql:currentCode,binding:body.repairComparison});
        const explicitRepair=body.sourceRunId===undefined||durableAgent?undefined:resolveExplicitSqlRepairSource({sourceRunId:body.sourceRunId,actorId,contextId:context.id,currentSql:currentCode,project:PROJECT,read:(kind,id)=>store.get(kind,id,PROJECT)});
        const backgroundWindow = body.background && ingressChannel === 'HTTP' ? developmentBackgroundWindow(developmentAccess, options.now?.() ?? Date.now()) : {};
        if (durableAgent && language === "SPARK_SQL") {
          if (!options.generator && !modelSettings(env).configured) throw new ModelUnavailable();
          let repair = {};
          if (body.sourceRunId !== undefined) {
            const source = get("run", text(body.sourceRunId, 36, 36)), revision = get("revision", source.revisionId);
            requireDevelopmentOwner("run", source, req);
            if (!["FAILED", "VALIDATION_FAILED"].includes(source.status) || source.code === "REMOTE_SPARK_TIMEOUT" ||
                source.engine !== "Apache Spark" || revision.contextId !== context.id || revision.sql.trim() !== currentCode.trim())
              throw Object.assign(fail(409, "请先选择同一上下文、同一代码版本的失败运行；超时需先检查执行环境"), { code: "AGENT_REPAIR_SOURCE_MISMATCH" });
            const sourceError = String(source.error || source.validation?.issues?.join("；") || "独立业务校验未通过").slice(0, 8000);
            repair = { sourceRunId: source.id, sourceError };
          }
          const created = await durableAgent.create({ message, currentSql: currentCode, contextId: context.id,
            actorId,
            idempotencyKey: text(req.headers["idempotency-key"], 1, 100), ...repair, ...(derivedFrom ? {derivation:body.derivation} : {}),...(repairBasis?{repairComparison:repairBasis.binding}:{}),...(body.assistedContinuation!==undefined?{assistedContinuation:body.assistedContinuation}:{}),...(body.manualContinuation!==undefined?{manualContinuation:body.manualContinuation}:{}),...(body.clarification!==undefined?{clarification:body.clarification}:{}) });
          if(body.background){
            const background=await agentEventDriver.enable(created.id,auth.sessionFromHeaders(req.headers)?.user.id,{expectedVersion:created.version,...backgroundWindow,
              developmentBoundary:developmentBackgroundBoundary(developmentAccess,created.id,developmentNow())});
            return json(res,202,{...created,background});
          }
          return json(res, 202, exposeDurableTask(get("agent",created.id)));
        }
        if (
          !(language === "PYTHON" ? options.pythonGenerator : options.generator) &&
          !modelSettings(env).configured
        )
          throw new ModelUnavailable();
        if (
          language === "SPARK_SQL" &&
          !options.runner &&
          !runtime.available
        )
          throw fail(503, "请先准备 Spark 执行环境再运行 Agent");
        if (
          language === "PYTHON" &&
          !options.pythonRunner &&
          !pythonRuntime.available
        )
          throw fail(503, "请先准备受限Python执行环境再运行Agent");
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = fundPreparation
            ? fundAgentRequestSignature({ message, language, contextId: context.id, fundPreparation })
            : hash(JSON.stringify({
                message,
                language,
                currentCode,
                contextId: context.id,
                ...(syncSelection ? { syncInput: syncSelection } : {}),
                ...(derivedFrom ? {derivation:derivedFrom} : {}),
                ...(explicitRepair?{sourceRunId:body.sourceRunId}:{}),
                ...(repairBasis?{sourceRunId:body.sourceRunId,repairComparison:repairBasis.binding}:{}),
                ...(clarification?{clarification:clarification.digest}:{}),
              }));
        const existingAgent = store.deduplicatedId(PROJECT + ":agent:" + key);
        if (existingAgent) requireDurableAgentOwner(get("agent", existingAgent), req);
        const dedup = store.deduplicate(
          PROJECT + ":agent:" + key,
          signature,
          () =>
            store.create("agent", PROJECT, {
              submittedBy: language==='SPARK_SQL'?actorId:local ? "local-engineer" : auth.sessionFromHeaders(req.headers).user.id,
              message,
              language,
              contextId: context.id,
              ...(fundPreparation ? { fundPreparation } : {}),
              ...(syncSelection ? { syncInput: freezeSyncSqlInput({ ...syncSqlResources, actorId, selection: syncSelection,
                current: currentSyncSqlInput(syncSqlResources) }) } : {}),
              ...(language==='SPARK_SQL'?{initialSql:currentCode,usedTokens:0}:{}),
              ...(clarification?{clarification,...clarificationAttribution({clarification})}:derivedFrom?clarificationAttribution(store.get('agent',derivedFrom.taskId,PROJECT)):{}),
              ...(derivedFrom ? {derivedFrom,initialSql:currentCode,sql:currentCode,usedTokens:0} : {}),
              ...(explicitRepair?{sourceRunId:body.sourceRunId,initialSql:currentCode,sql:currentCode,...explicitRepairAttribution(body.sourceRunId)}:{}),
              ...(repairBasis?{sourceRunId:body.sourceRunId,repairComparison:repairBasis.binding,initialSql:currentCode,sql:currentCode,...repairBasis.attribution}:{}),
              status: "QUEUED",
              attempts: [],
              mode,
              completionScope:
                language === "PYTHON"
                  ? "PYTHON_DEVELOPMENT"
                  : "SQL_DEVELOPMENT",
              fullLifecycleE2E: false,
              validationContractId:syncSelection ? syncSqlContractId : validationFamily(context.id).id,
              maxAttempts: language === "PYTHON" ? 5 : 3,
            }),
        );
        const task = get("agent", dedup.id);
        requireDurableAgentOwner(task, req);
        if (!dedup.replayed)
          schedule("agent", task, async (signal) => {
            if (language === "PYTHON") {
              let code = currentCode,
                error,
                usedTokens = 0;
              for (let attempt = 1; attempt <= 5; attempt++) {
                if (signal.aborted) throw new Error("任务已取消");
                const remainingBudget =
                  Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000) - usedTokens;
                if (remainingBudget < 1)
                  throw new Error("本次 Agent 已达到 Token 预算上限");
                let generated;
                try {
                  generated = await pythonGenerator({
                    message,
                    context,
                    currentCode: code,
                    error,
                    signal,
                    remainingBudget,
                  });
                } catch (cause) {
                  if (cause.retryable !== true) throw cause;
                  const reportedTokens = Number(cause.usage?.total_tokens);
                  usedTokens +=
                    Number.isSafeInteger(reportedTokens) && reportedTokens > 0
                      ? reportedTokens
                      : remainingBudget;
                  const latest = get("agent", task.id),
                    attempts = [
                      ...latest.attempts,
                      {
                        attempt,
                        status: "MODEL_OUTPUT_INVALID",
                        model: cause.model,
                        usage: cause.usage,
                        error: cause.message,
                      },
                    ];
                  store.update("agent", task.id, PROJECT, {
                    attempts,
                    usedTokens,
                  });
                  if (
                    usedTokens >= Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000)
                  )
                    throw new Error("本次 Agent 已达到 Token 预算上限");
                  error = cause.message;
                  continue;
                }
                if (
                  signal.aborted ||
                  get("agent", task.id).status === "CANCELLED"
                )
                  return;
                const reportedTokens = Number(generated.usage?.total_tokens);
                usedTokens +=
                  Number.isSafeInteger(reportedTokens) && reportedTokens > 0
                    ? reportedTokens
                    : remainingBudget;
                if (usedTokens > Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000))
                  throw new Error("本次 Agent 已达到 Token 预算上限");
                code = generated.code;
                const rev = pythonRevision(code, context.id, "LIVE_MODEL", task.submittedBy),
                  run = store.create("python_run", PROJECT, {
                    revisionId: rev.id,
                    revisionHash: rev.codeHash,
                    contextId: context.id,
                    validationContractId:validationFamily(context.id).id,
                    status: "RUNNING",
                    startedAt: new Date().toISOString(),
                    engine: "CPython",
                    executionScope: "LOCAL_RESTRICTED_PYTHON",
                    publicDeployed: false,
                    agentTaskId: task.id,
                  });
                let completed;
                try {
                  const result = await pythonRunner({
                    code,
                    context,
                    validationContexts: validationContextsFor(context.id),
                    signal,
                    timeoutMs: Number(
                      env.V2_PYTHON_RUN_TIMEOUT_MS ?? 10_000,
                    ),
                  });
                  if (get("agent", task.id).status === "CANCELLED") return;
                  completed = store.update("python_run", run.id, PROJECT, {
                    ...result,
                    finishedAt: new Date().toISOString(),
                  });
                } catch (cause) {
                  store.update("python_run", run.id, PROJECT, {
                    status: signal.aborted ? "CANCELLED" : "FAILED",
                    error: cause.message,
                    finishedAt: new Date().toISOString(),
                  });
                  throw cause;
                }
                const latest = get("agent", task.id),
                  attempts = [
                    ...latest.attempts,
                    {
                      attempt,
                      runId: run.id,
                      revisionId: rev.id,
                      status: completed.status,
                      model: generated.model,
                      usage: generated.usage,
                      explanation: generated.explanation,
                    },
                  ];
                store.update("agent", task.id, PROJECT, {
                  attempts,
                  revisionId: rev.id,
                  code,
                  explanation: generated.explanation,
                  usedTokens,
                });
                if (completed.status === "SUCCEEDED") {
                  store.update("agent", task.id, PROJECT, {
                    status: "SUCCEEDED",
                    finishedAt: new Date().toISOString(),
                  });
                  return;
                }
                error =
                  completed.error ??
                  completed.validation?.issues?.join("；") ??
                  "Python结果未通过独立断言";
              }
              store.update("agent", task.id, PROJECT, {
                status: "FAILED",
                error: "五次修正后仍未通过Python结果断言，请人工检查",
                finishedAt: new Date().toISOString(),
              });
              return;
            }
            if (derivedFrom) resolveAgentContextDerivation({derivation:body.derivation,actorId,targetContextId:context.id,currentSql:currentCode,
              project:PROJECT,read:(kind,id)=>store.get(kind,id,PROJECT)});
            let sql = currentCode,
              error=explicitRepair?String(explicitRepair.run.error||explicitRepair.run.validation?.issues?.join('；')||'独立业务校验未通过').slice(0,8000):undefined,
              usedTokens = 0;
            const checkFundExecution = (attempt, generated) => {
              if (!fundPreparation) return true;
              const saved = get("agent", task.id);
              try {
                const expected = JSON.stringify(fundPreparation);
                if (saved.submittedBy === actorId && saved.contextId === context.id && saved.message === message &&
                    JSON.stringify(saved.fundPreparation) === expected && JSON.stringify(resolveFundExecution()) === expected) return true;
              } catch (cause) {
                if (!cause.status) throw cause;
              }
              const code = "FUND_PREPARATION_SOURCE_CHANGED";
              store.update("agent", task.id, PROJECT, { usedTokens, status: "FAILED", stage: code, code,
                error: "已保存的基金执行依据发生变化，已停止后续模型与 Spark 执行。",
                ...(generated ? { attempts: [...saved.attempts, { attempt, status: code, model: generated.model,
                  usage: generated.usage, computationSkipped: true }] } : {}),
                finishedAt: new Date().toISOString() });
              return false;
            };
            for (let attempt = 1; attempt <= 3; attempt++) {
              if (signal.aborted) throw new Error("任务已取消");
              if (task.syncInput) {
                if (JSON.stringify(get("agent", task.id).syncInput) !== JSON.stringify(task.syncInput))
                  throw fail(409, "原任务的同步冻结输入已变化");
                readSyncSqlInput({ ...syncSqlResources, actorId, binding: task.syncInput });
              }
              const remainingBudget =
                Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000) - usedTokens;
              if (remainingBudget < 1)
                throw new Error("本次 Agent 已达到 Token 预算上限");
              let generated;
              const modelStartedAt = Date.now();
              if (!checkFundExecution(attempt)) return;
              if(task.clarification){try{assertSqlClarificationTask(get('agent',task.id),{store,project:PROJECT});}catch(cause){store.update('agent',task.id,PROJECT,{status:'FAILED',stage:'CLARIFICATION_SOURCE_CHANGED',error:cause.message,finishedAt:new Date().toISOString()});return;}}
              if(explicitRepair)resolveExplicitSqlRepairSource({sourceRunId:body.sourceRunId,actorId,contextId:context.id,currentSql:currentCode,project:PROJECT,read:(kind,id)=>store.get(kind,id,PROJECT)});
              const comparison=repairBasis?resolveSqlRepairComparison({store,project:PROJECT,actorId,sourceRunId:body.sourceRunId,contextId:context.id,currentSql:currentCode,binding:repairBasis.binding}):undefined;
              let feedbackRun=attempt===1?explicitRepair?.run:undefined;
              if(attempt>1){
                const previous=get('agent',task.id).attempts.at(-1),failed=previous?.runId?get('run',previous.runId):undefined;
                if(failed?.agentTaskId===task.id&&failed.contextId===context.id&&failed.revisionHash===hash(sql)&&failed.revisionId===previous.revisionId&&
                  failed.status==='VALIDATION_FAILED'&&previous.status===failed.status)feedbackRun=failed;
              }
              const repairFeedback=feedbackRun?buildSqlRepairFeedback(feedbackRun,context.id,{currentSql:sql}):undefined;
              try {
                generated = await generator({
                  message,
                  context: task.syncInput ? { ...context, expected: undefined,
                    tables: context.tables.map(({ name, columns }) => ({ name, columns })) } : context,
                  ...(task.syncInput ? { outputColumns: syncSqlOutputColumns } : {}),
                  ...(fundPreparation ? { fundBasisDigest: fundPreparation.basisDigest } : {}),
                  ...(task.clarification?{clarification:task.clarification}:{}),
                  currentSql: sql,
                  error,
                  ...(repairFeedback?{repairFeedback}:{}),
                  ...(attempt===1&&comparison?{repairComparison:comparison.summary,repairFeedback:buildSqlRepairFeedback(get('run',body.sourceRunId),context.id,{currentSql:sql})}:{}),
                  signal,
                  remainingBudget,
                });
                if (mode === "SYNTHETIC_MODEL") generated = { ...generated, model: "TEST_DOUBLE" };
              } catch (cause) {
                const diagnostic = safeModelDiagnostic(cause, Date.now() - modelStartedAt);
                // An unknown provider outcome consumes the remaining reservation;
                // neither lookup nor page reload should silently retry it.
                const reservedTokens = diagnostic.requestMayHaveBeenSent ? remainingBudget : 0;
                usedTokens += reservedTokens;
                store.update("agent", task.id, PROJECT, {
                  attempts: [...get("agent", task.id).attempts, {
                    attempt,
                    status: "FAILED",
                    diagnostic,
                    ...(diagnostic.requestMayHaveBeenSent ? {
                      model: mode === "SYNTHETIC_MODEL" ? "TEST_DOUBLE" : modelSettings(env).model,
                      usage: { total_tokens: reservedTokens },
                      usageEstimated: true,
                    } : {}),
                  }],
                  usedTokens,
                });
                throw cause;
              }
              if (
                signal.aborted ||
                get("agent", task.id).status === "CANCELLED"
              )
                return;
              const reportedTokens = Number(generated.usage?.total_tokens);
              usedTokens +=
                Number.isSafeInteger(reportedTokens) && reportedTokens > 0
                  ? reportedTokens
                  : remainingBudget;
              if (usedTokens > Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000))
                throw new Error("本次 Agent 已达到 Token 预算上限");
              if (!checkFundExecution(attempt, generated)) return;
              if (task.syncInput && JSON.stringify(get("agent", task.id).syncInput) !== JSON.stringify(task.syncInput))
                throw fail(409, "原任务的同步冻结输入已变化");
              if(task.clarification){try{assertSqlClarificationTask(get('agent',task.id),{store,project:PROJECT});}catch{store.update('agent',task.id,PROJECT,{usedTokens,status:'FAILED',stage:'CLARIFICATION_SOURCE_CHANGED',error:'原澄清依据在模型返回前发生变化；已保留用量，未执行SQL。',
                attempts:[...get('agent',task.id).attempts,{attempt,status:'CLARIFICATION_SOURCE_CHANGED',model:generated.model,usage:generated.usage,computationSkipped:true}],finishedAt:new Date().toISOString()});return;}}
              const requirements=sqlRequirementReport({task,message,context,generated,attempt});
              if(requirements&&requirements.status!=='MODEL_PROPOSED'){
                const code=requirements.status==='CLARIFICATION_REQUIRED'?'REQUIREMENT_CLARIFICATION_REQUIRED':'REQUIREMENT_EVIDENCE_INVALID';
                store.update('agent',task.id,PROJECT,{usedTokens,requirements,status:'FAILED',stage:code,code,finishedAt:new Date().toISOString(),
                  error:requirements.interpretation?.question??requirements.reason,
                  attempts:[...get('agent',task.id).attempts,{attempt,status:code,model:generated.model,usage:generated.usage,computationSkipped:true}]});
                return;
              }
              if(explicitRepair){
                store.update('agent',task.id,PROJECT,{usedTokens});
                resolveExplicitSqlRepairSource({sourceRunId:body.sourceRunId,actorId,contextId:context.id,currentSql:currentCode,project:PROJECT,read:(kind,id)=>store.get(kind,id,PROJECT)});
                if(repairBasis)resolveSqlRepairComparison({store,project:PROJECT,actorId,sourceRunId:body.sourceRunId,contextId:context.id,currentSql:currentCode,binding:repairBasis.binding});
                if(attempt===1&&sameSqlIgnoringLayout(generated.sql,currentCode))throw fail(409,'模型未修改失败代码，未重新提交计算');
              }
              sql = generated.sql;
              const rev = revision(sql, context.id, mode, task.submittedBy, task.syncInput);
              if (fundPreparation) store.update("revision", rev.id, PROJECT, { fundPreparation });
              if(task.humanClarified)store.update('revision',rev.id,PROJECT,clarificationAttribution(task));
              if(requirements)store.update('revision',rev.id,PROJECT,{requirementBinding:sqlRequirementBinding(bindSqlRequirementRevision(requirements,rev))});
              if(requirements)store.update('agent',task.id,PROJECT,{usedTokens,requirements:bindSqlRequirementRevision(requirements,rev),revisionId:rev.id,
                sql,attempts:[...get('agent',task.id).attempts,{attempt,status:'GENERATED',model:generated.model,usage:generated.usage,revisionId:rev.id}]});
              if(explicitRepair)store.update('revision',rev.id,PROJECT,repairComparisonAttribution(task));
              const run = store.create("run", PROJECT, {
                validationContractId:task.validationContractId,
                revisionId: rev.id,
                revisionHash: rev.hash,
                contextId: context.id,
                status: "RUNNING",
                startedAt: new Date().toISOString(),
                agentTaskId: task.id,
                ...(fundPreparation ? { fundPreparation } : {}),
                ...(task.syncInput ? { syncInput: task.syncInput } : {}),
                ...clarificationAttribution(task),
                ...repairComparisonAttribution(task),
              });
              let completed;
              try {
                completed = await execute(run, rev, signal);
              } catch (e) {
                store.update("run", run.id, PROJECT, {
                  status: signal.aborted ? "CANCELLED" : "FAILED",
                  error: e.message,
                });
                throw e;
              }
              const latest = get("agent", task.id),
                attempts = [
                  ...latest.attempts.filter(previous=>previous.attempt!==attempt),
                  {
                    attempt,
                    runId: run.id,
                    revisionId: rev.id,
                    status: completed.status,
                    model: generated.model,
                    usage: generated.usage,
                    explanation: generated.explanation,
                  },
                ];
              if (signal.aborted) throw new Error("任务已取消");
              store.update("agent", task.id, PROJECT, {
                attempts,
                revisionId: rev.id,
                runId: run.id,
                sql,
                explanation: generated.explanation,
                usedTokens,
              });
              if (completed.status === "SUCCEEDED") {
                store.update("agent", task.id, PROJECT, {
                  status: "SUCCEEDED",
                  finishedAt: new Date().toISOString(),
                });
                return;
              }
              error = fundPreparation
                ? completed.status === "VALIDATION_FAILED"
                  ? "基金独立断言未通过，请检查组合范围、同日权重和敞口计算。"
                  : "Spark 未完成基金 SQL。请核对当前查询的语法、登记字段、参数和只读范围。"
                : task.syncInput ? completed.code === syncSqlOutputSchemaCode ? syncSqlOutputSchemaMessage
                  : "当前 SQL 未通过冻结批次或登记回归断言，请核对输出列、交易日、客户范围与金额聚合。"
                : completed.error ?? completed.validation?.issues?.join("；");
            }
            store.update("agent", task.id, PROJECT, {
              status: "FAILED",
              error: "三次修正后仍未通过结果断言，请人工检查",
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      if (path.startsWith("/api/v2")) throw fail(404, "接口不存在");
      if (method !== "GET") throw fail(405, "请求方法不支持");
      return await serveV2Static(res, root, path, req.headers["accept-encoding"]);
    } catch (error) {
      return json(res, error.status ?? 500, {
        message: error.status ? error.message : "处理失败，请检查服务日志",
        ...(typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code)
          ? { code: error.code }
          : {}),
        ...(error.code === "INGRESS_DENIED" && ingressDenialReasons.includes(error.ingressReason)
          ? { ingressReason: error.ingressReason } : {}),
        ...(typeof error.runId === "string" ? { runId: error.runId } : {}),
        ...(typeof error.auditId === "string" ? { auditId: error.auditId } : {}),
      }).finally(() => {
        if (!error.status) console.error(error.message);
      });
    }
  };
  const server = options.httpServer ?? createServer();
  const dispatchRequest = (req, res) => {
    let channel;
    try { channel = options.ingress?.assertRequest(req); }
    catch { void handleRequest(req, res).catch(() => {}); return; }
    const staticRequest = req.method === "GET" && (req.url === "/" || /^\/v2(?:[/?]|$)/.test(req.url));
    if (!options.ingress || channel === "INTERNAL"&&!serviceAgentAccess || staticRequest || isPublicContextRead(req, channel)) {
      void handleRequest(req, res).catch(() => {}); return;
    }
    const controller = new AbortController(), onClose = () => controller.abort();
    res.once("close", onClose);
    const dispatch=async()=>{
      if(serviceAgentAccess&&channel==='EVENT'&&req.url==='/invoke'){
        const input=await readPrivateSmokeBody(req);prefetchedPrivateInputs.set(req,input);
        if(input.operation==='PRIVATE_APPLICATION_HTTP_V1'){
          if(!privateSmokeEnabled)throw fail(404,'页面不存在');
          validatePrivateApplicationRequest(input,{allowDurableAgent:Boolean(durableAgent),allowDurableAgentRead:privateDataServicesEnabled,allowDataServices:true,allowServiceAgent:true});
          // Pure transport: no refresh, mutation, auth projection or final
          // metadata flush here. The authenticated INTERNAL API owns its lane.
          // This avoids carrying an outer owner across the HTTP loopback.
          const address=server.address(),base=`http://127.0.0.1:${address.port}`;
          const result=await callPrivateApplication(input,base,undefined,{internalHeaders:options.ingress.internalHeaders,
            allowDurableAgent:Boolean(durableAgent),allowDurableAgentRead:privateDataServicesEnabled,allowDataServices:true,allowServiceAgent:true});
          return json(res,200,result);
        }
      }
      if(serviceAgentAccess&&channel==='INTERNAL'&&req.url==='/invoke')throw fail(403,'服务规划内部通道不接受嵌套私有调用');
      return statefulRequests.run(() => handleRequest(req, res), { signal: controller.signal });
    };
    void dispatch()
      .catch(error => { if (!res.destroyed && !res.writableEnded) {
        if(error.status&&error.code!=='REQUEST_LANE_BUSY'){void json(res,error.status,{code:error.code??'PRIVATE_APPLICATION_REQUEST_INVALID',message:error.message}).catch(()=>{});return;}
        const notStarted = error.code === "REQUEST_LANE_BUSY";
        if (notStarted) res.setHeader("Retry-After", "1");
        void json(res, 503, { code: notStarted ? "REQUEST_LANE_BUSY" : "REQUEST_OUTCOME_UNCONFIRMED", message: notStarted ? "服务忙，请稍后重试；本次操作未执行" : "操作结果尚未确认，请查看原任务状态，不要重复提交" }).catch(() => {});
      } })
      .finally(() => {prefetchedPrivateInputs.delete(req);res.removeListener("close", onClose);});
  };
  if (!options.httpServer) server.on("request", dispatchRequest);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    server.off("close", dispose);
    privateServiceRoutes?.agentPlanner.shutdown();
    for (const c of controls.values()) c.abort();
    releaseScheduler.shutdown();
    realtime.shutdown();
    if (ownsBusinessStore) businessStore.close();
    if (ownsLandingStore) landingStore.close();
    if (ownsStreamStateStore) streamStateStore.close();
    if (ownsReportStore) reportStore.close();
  };
  server.once("close", dispose);
  return {
    server,
    dispatchRequest,
    dispose,
    store,
    host,
    releaseScheduler,
    dataServices,
    businessStore,
    ingestion,
    landingStore,
    realtime,
    streamStateStore,
    assets,
    dataContracts,
    quality,
    security,
    reports,
    reportStore,
    operations,
    auth,
    artifactStore,
    budget,
    stateCoordinator: options.stateCoordinator,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, host } = createV2Server();
  server.listen(Number(process.env.V2_PORT ?? 3100), host, () =>
    console.log(
      "Shuduo V2 ready on http://" +
        host +
        ":" +
        (process.env.V2_PORT ?? 3100) +
        "/v2/",
    ),
  );
}
