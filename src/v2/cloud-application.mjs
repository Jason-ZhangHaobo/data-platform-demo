import { createV2Server } from "./server.mjs";
import { PROJECT } from "./request-scope.mjs";
import { ReplicatedMetadataStore } from "./metadata-replica.mjs";
import { MySqlMetadataBackend } from "./mysql-metadata-backend.mjs";
import { LandingStore } from "./ingestion.mjs";
import { StreamStateStore } from "./realtime.mjs";
import { BusinessQueryStore } from "./data-services.mjs";
import { ReportDataStore } from "./reports.mjs";
import { ReplicatedDataState } from "./data-state-replica.mjs";
import {
  OssDataStateBackend,
  ossDataStateConfigFromEnvironment,
} from "./oss-data-state-backend.mjs";
import { CloudStateCoordinator } from "./cloud-state-coordinator.mjs";
import { createRemoteSparkRunner } from "./remote-spark.mjs";
import { cloudExecutionState } from "./cloud-execution-state.mjs";
import { agentEventConfigFromEnvironment } from "./agent-event-driver.mjs";
import {
  OssImmutableArtifactStore,
  ossArtifactConfigFromEnvironment,
} from "./artifact-store.mjs";

export async function createCloudV2Application(env = process.env, {
  openMetadataBackend = MySqlMetadataBackend.open,
  createDataBackend = config => new OssDataStateBackend(ossDataStateConfigFromEnvironment(config)),
  createArtifactStore = config => new OssImmutableArtifactStore(ossArtifactConfigFromEnvironment(config)),
  createRunner = createRemoteSparkRunner,
  root,
  httpServer,
  now = Date.now,
  ingress,
} = {}) {
  if (env.V2_BOOTSTRAP_ADMIN_PASSWORD)
    throw new Error("云端禁止注入管理员明文密码，请仅配置V2_BOOTSTRAP_ADMIN_PASSWORD_HASH");

  const started = performance.now(), phases = {};
  const measure = async (phase, operation) => {
    const phaseStarted = performance.now();
    try { return await operation(); }
    finally { phases[phase] = Math.round(performance.now() - phaseStarted); }
  };
  const dataStateBackend = createDataBackend(env);
  const artifactStore = createArtifactStore(env);
  const runnerCandidate = createRunner(env);
  // The immutable Worker result belongs to its own OSS prefix. Read it during
  // persistence restoration, then verify the signature and age at the original
  // readiness gate. Keep the MySQL snapshot ahead of the OSS state read.
  const pendingWorkerEvidence = runnerCandidate?.prepareVerification
    ? measure("workerEvidenceReadMs", () => runnerCandidate.prepareVerification())
        .then(verify => ({ verify }), error => ({ error }))
    : undefined;

  let metadataBackend, store, stores, app;
  try {
    metadataBackend = await measure("mysqlOpenMs", () => openMetadataBackend(env));
    store = await measure("metadataRestoreMs", () => ReplicatedMetadataStore.open({
      backend: metadataBackend, project: PROJECT, autoFlush: false,
    }));
    stores = {
      businessStore: new BusinessQueryStore(), landingStore: new LandingStore(),
      streamStateStore: new StreamStateStore(), reportStore: new ReportDataStore(),
    };
    const dataState = await measure("dataStateRestoreMs", () => ReplicatedDataState.open({
      backend: dataStateBackend, project: PROJECT, autoFlush: false, stores,
    }));
    const stateCoordinator = new CloudStateCoordinator({ metadata: store, dataState });
    let runner, descriptor;
    if (runnerCandidate) {
      try {
        await measure("workerReadyMs", async () => {
          if (!pendingWorkerEvidence) {
            await runnerCandidate.verify();
            return;
          }
          const evidence = await pendingWorkerEvidence;
          if (!evidence.verify) throw evidence.error;
          evidence.verify();
        });
        runner = runnerCandidate;
        descriptor = runnerCandidate.descriptor;
      } catch (error) {
        descriptor = {
          ...runnerCandidate.descriptor,
          healthVerified: false,
          publicWriteEnabled: false,
          errorCode: error?.code ?? "REMOTE_SPARK_NOT_READY",
        };
      }
    }
    const execution = cloudExecutionState({
      ...env, V2_LOCAL_DEVELOPMENT: "false", V2_META_DRIVER: "mysql-project-snapshot-cas",
    }, runner, descriptor, runnerCandidate);
    app = createV2Server({
      root,
      store,
      ...stores,
      artifactStore,
      stateCoordinator,
      runner: execution.runner,
      runnerDescriptor: execution.descriptor,
      readPendingSparkResult: execution.readPendingSparkResult,
      resultEventConfig: execution.readPendingSparkResult && env.V2_PROVISIONING_ONLY==="true" &&
        env.V2_PRIVATE_SMOKE_ENABLED==="true" ? agentEventConfigFromEnvironment(env) : undefined,
      env: execution.env,
      ingress,
      httpServer,
      now,
    });
    await measure("initialFlushMs", () => stateCoordinator.flush());
    return { app, stateCoordinator, timing: { ...phases, elapsedMs: Math.round(performance.now() - started) } };
  } catch (error) {
    app?.dispose();
    store?.close();
    for (const stateStore of Object.values(stores ?? {})) stateStore.close();
    await Promise.allSettled([metadataBackend?.close?.(), dataStateBackend.close?.()]);
    throw error;
  }
}
