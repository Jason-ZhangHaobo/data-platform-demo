import { createV2Server, PROJECT } from "./server.mjs";
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
import {
  OssImmutableArtifactStore,
  ossArtifactConfigFromEnvironment,
} from "./artifact-store.mjs";

const metadataBackend = await MySqlMetadataBackend.open(process.env),
  store = await ReplicatedMetadataStore.open({
    backend: metadataBackend,
    project: PROJECT,
    autoFlush: false,
  }),
  businessStore = new BusinessQueryStore(),
  landingStore = new LandingStore(),
  streamStateStore = new StreamStateStore(),
  reportStore = new ReportDataStore(),
  dataStateBackend = new OssDataStateBackend(
    ossDataStateConfigFromEnvironment(process.env),
  ),
  artifactStore = new OssImmutableArtifactStore(
    ossArtifactConfigFromEnvironment(process.env),
  ),
  dataState = await ReplicatedDataState.open({
    backend: dataStateBackend,
    project: PROJECT,
    autoFlush: false,
    stores: { businessStore, landingStore, streamStateStore, reportStore },
  }),
  stateCoordinator = new CloudStateCoordinator({
    metadata: store,
    dataState,
  }),
  runnerCandidate = createRemoteSparkRunner(process.env),
  env = {
    ...process.env,
    V2_LOCAL_DEVELOPMENT: "false",
    V2_META_DRIVER: "mysql-project-snapshot-cas",
  },
  runnerStatus = runnerCandidate
    ? await runnerCandidate
        .verify()
        .then(() => ({ runner: runnerCandidate, descriptor: runnerCandidate.descriptor }))
        .catch((error) => ({
          runner: undefined,
          descriptor: {
            ...runnerCandidate.descriptor,
            healthVerified: false,
            publicWriteEnabled: false,
            errorCode: error.code ?? "REMOTE_SPARK_NOT_READY",
          },
        }))
    : { runner: undefined, descriptor: undefined },
  app = createV2Server({
    store,
    businessStore,
    landingStore,
    streamStateStore,
    reportStore,
    artifactStore,
    stateCoordinator,
    ...(runnerStatus.runner ? { runner: runnerStatus.runner } : {}),
    ...(runnerStatus.descriptor
      ? { runnerDescriptor: runnerStatus.descriptor }
      : {}),
    env,
  });
await stateCoordinator.flush();
const port = Number(process.env.FC_CUSTOM_LISTEN_PORT ?? process.env.PORT ?? 9000),
  host = process.env.V2_HOST ?? process.env.HOST ?? "0.0.0.0";
app.server.listen(port, host, () =>
  process.stdout.write(`Shuzhan V2 cloud server ready on ${host}:${port}\n`),
);
const close = () =>
  app.server.close(async () => {
    await stateCoordinator.closeReplicated({ closeDataStores: true });
    process.exit(0);
  });
process.on("SIGINT", close);
process.on("SIGTERM", close);
