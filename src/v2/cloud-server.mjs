import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertV2RequestScope, createV2Server, publicV2Contexts, PROJECT } from "./server.mjs";
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
import { createFcIngress } from "./fc-ingress.mjs";
import { serveV2Static } from "./static-response.mjs";
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
  ingress = createFcIngress({
    publicHttpEnabled: env.V2_FC_PUBLIC_HTTP_ENABLED === "true",
    publicReadOnly: env.V2_FC_PUBLIC_READ_ONLY !== "false",
  }),
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
    }, runner, descriptor);
    app = createV2Server({
      root,
      store,
      ...stores,
      artifactStore,
      stateCoordinator,
      runner: execution.runner,
      runnerDescriptor: execution.descriptor,
      env: execution.env,
      ingress,
      httpServer,
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

const startupAsset = /^\/v2\/assets\/[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|svg|woff2?)$/;
function startupResponse(res, status, payload, retry = false) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(retry ? { "Retry-After": "1" } : {}),
  });
  res.end(JSON.stringify(payload));
}

export function startCloudV2Listener(env = process.env, {
  port = Number(env.FC_CUSTOM_LISTEN_PORT ?? env.PORT ?? 9000),
  host = env.V2_HOST ?? env.HOST ?? "0.0.0.0",
  ...options
} = {}) {
  const server = createServer();
  const publicHttpEnabled = env.V2_FC_PUBLIC_HTTP_ENABLED === "true",
    publicReadOnly = env.V2_FC_PUBLIC_READ_ONLY !== "false";
  const ingress = createFcIngress({ publicHttpEnabled, publicReadOnly });
  const earlyRead = publicHttpEnabled && publicReadOnly && !env.V2_BOOTSTRAP_ADMIN_PASSWORD;
  let app, stopped = false, closing;
  const listen = () => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const stopListening = async force => {
    if (!server.listening) return;
    const closed = new Promise(resolve => server.close(resolve));
    if (force) server.closeAllConnections();
    await closed;
  };
  const dispose = async runtime => {
    if (!runtime) return;
    runtime.app.dispose();
    await runtime.stateCoordinator.closeReplicated({ closeDataStores: true });
  };
  const ready = (async () => {
    let runtime;
    try {
      if (earlyRead) await listen();
      if (stopped) return undefined;
      runtime = await createCloudV2Application(env, { ...options, ingress, httpServer: server });
      if (!earlyRead && !stopped) await listen();
      if (!stopped) app = runtime.app;
      return runtime;
    } catch (error) {
      await stopListening(true);
      await dispose(runtime).catch(() => {});
      throw error;
    }
  })();
  const opening = async (req, res) => {
    try {
      const channel = ingress.assertRequest(req);
      assertV2RequestScope(req, { env, local: false });
      const path = req.url.split("?", 1)[0];
      const staticFile = path === "/v2" || path === "/v2/" || startupAsset.test(path);
      const catalog = path === "/api/v2/contexts";
      const publicOpeningRead = earlyRead && channel === "HTTP" && req.method === "GET" && (staticFile || catalog);
      if (!stopped && publicOpeningRead && req.headers.cookie === undefined && req.headers.authorization === undefined) {
        if (catalog) return startupResponse(res, 200, publicV2Contexts());
        return await serveV2Static(res, options.root ?? process.cwd(), path, req.headers["accept-encoding"]);
      }
      // Deliver marked events and signed-in page reads to the normal handler
      // only once the application owns a recovered, durably flushed state.
      if (!stopped && (channel === "EVENT" || publicOpeningRead)) {
        await ready;
        if (!stopped && !res.destroyed) return app.dispatchRequest(req, res);
      }
      return startupResponse(res, 503, { code: "CLOUD_STARTUP_PENDING", message: "服务正在恢复，请稍候。" }, true);
    } catch (error) {
      return startupResponse(res, error.status ?? 503, {
        code: error.code ?? "CLOUD_STARTUP_UNAVAILABLE",
        message: error.status ? error.message : "服务尚未就绪",
      });
    }
  };
  server.on("request", (req, res) => {
    if (app && !stopped) app.dispatchRequest(req, res);
    else void opening(req, res);
  });
  const close = () => closing ??= (async () => {
    stopped = true;
    await stopListening(!app);
    const runtime = await ready.catch(() => undefined);
    await stopListening(true);
    await dispose(runtime);
  })();
  return { server, ready, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const listener = startCloudV2Listener();
  const shutdown = () => void listener.close().catch(() => { process.exitCode = 1; });
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  const runtime = await listener.ready, address = listener.server.address();
  if (runtime && address) {
    process.stdout.write(`Shuduo V2 cloud server ready on ${address.address}:${address.port}\n`);
    process.stdout.write(JSON.stringify({ event: "CLOUD_STARTUP_READY", ...runtime.timing }) + "\n");
  }
}
