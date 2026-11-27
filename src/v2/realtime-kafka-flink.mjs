import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loopbackKafkaBootstrap, runLiveWindowProcess } from "./live-kafka-window-session.mjs";

export const kafkaFlinkAdapter = "kafka-flink-local-v1";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const hex = (value, length) =>
  typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);

const expectedWindows = new Map([
  ["00/001", [2,300]], ["00/002", [1,25]],
  ["10/001", [2,80]], ["10/002", [1,20]],
  ["20/001", [1,70]], ["20/002", [1,40]],
]);

function kafkaFlinkWindowEvidence(value, expectedSqlDigest, brokerCrash) {
  const {scope,result,kafkaVersion,flinkVersion,sqlDigest,partitionInputCounts,windowsWhilePartitionHeld,
    windowsBeforeCrash,windowsAfterRestore,finalWindowRows,originalJobId,restoredJobId,checkpointId,
    restoredCheckpointId,checkpointDigest,restoredSavepointDigest,exitCode,partitionBeforeExit,inputOffsetBeforeExit,
    windowRows,brokerFailover} = value ?? {};
  const fail = () => { throw new Error("KAFKA_FLINK_EVIDENCE_MISMATCH"); };
  if (scope !== (brokerCrash ? "LOCAL_KAFKA_REPLICATED_WINDOWS" : "LOCAL_KAFKA_FLINK_EVENT_TIME_WINDOWS") ||
      result !== "VERIFIED" ||
      kafkaVersion !== "4.1.2" || flinkVersion !== "1.20.5" ||
      !hex(sqlDigest,64) || sqlDigest !== expectedSqlDigest ||
      !Array.isArray(partitionInputCounts) || partitionInputCounts.length !== 2 ||
      partitionInputCounts[0] !== 5 || partitionInputCounts[1] !== 6 ||
      windowsWhilePartitionHeld !== 0 || windowsBeforeCrash !== 2 || windowsAfterRestore !== 4 || finalWindowRows !== 6 ||
      !hex(originalJobId,32) || !hex(restoredJobId,32) || !hex(restoredSavepointDigest,64) ||
      partitionBeforeExit !== 0 || inputOffsetBeforeExit !== 2 ||
      !Array.isArray(windowRows) || windowRows.length !== expectedWindows.size) fail();
  let recovery;
  if (brokerCrash) {
    const {partition,leaderBefore,leaderAfter,replicasBefore,replicasAfter,minInSyncReplicas,exitCode:brokerExitCode} = brokerFailover ?? {};
    if (originalJobId !== restoredJobId || checkpointId !== undefined || restoredCheckpointId !== undefined ||
        checkpointDigest !== undefined || exitCode !== undefined || partition !== 0 ||
        ![1,2,3].includes(leaderBefore) || ![1,2,3].includes(leaderAfter) || leaderBefore === leaderAfter ||
        replicasBefore !== 3 || replicasAfter !== 2 || minInSyncReplicas !== 2 || brokerExitCode !== 137) fail();
    recovery = {brokerFailover:{partition,leaderBefore,leaderAfter,replicasBefore,replicasAfter,
      minInSyncReplicas,exitCode:brokerExitCode,inputOffsetBeforeExit}};
  } else {
    if (brokerFailover !== undefined || originalJobId === restoredJobId ||
        !Number.isSafeInteger(checkpointId) || checkpointId < 1 || checkpointId !== restoredCheckpointId ||
        !hex(checkpointDigest,64) || checkpointDigest === restoredSavepointDigest || exitCode !== 137) fail();
    recovery = {checkpointRecovery:{checkpointId,restoredCheckpointId,checkpointDigest,exitCode,
      partitionBeforeExit,inputOffsetBeforeExit,committedUpdatesAtExit:windowsBeforeCrash}};
  }
  const keys = new Set();
  for (const row of windowRows) {
    if (typeof row?.window_start_utc !== "string" || typeof row.security_code !== "string") fail();
    const time = row.window_start_utc.match(/^2026-09-14 09:30:(00|10|20)$/)?.[1];
    const security = row.security_code.match(/^SEC-DEMO-(001|002)$/)?.[1];
    const key = `${time}/${security}`;
    const expected = expectedWindows.get(key);
    if (keys.has(key) || !expected || Object.keys(row).length !== 4 ||
        row.event_count !== expected[0] || row.total_volume !== expected[1]) fail();
    keys.add(key);
  }
  return {scope,result,kafkaVersion,flinkVersion,sqlDigest,partitionInputCounts,
    inputEvents:11,committedUpdatesBefore:windowsBeforeCrash,committedUpdatesAfter:finalWindowRows,
    windowsWhilePartitionHeld,windowsAfterRestore,originalJobId,restoredJobId,restoredSavepointDigest,windowRows,
    ...recovery};
}

export function kafkaFlinkEvidence(value, expected) {
  if (expected.windowSqlDigest) return kafkaFlinkWindowEvidence(value,expected.windowSqlDigest,expected.brokerCrash === true);
  const {scope, result, kafkaVersion, flinkVersion, inputEvents, committedUpdatesBefore, committedUpdatesAfter,
    originalJobId, restoredJobId, originalSavepointDigest, restoredSavepointDigest, finalQuotes, fixtureDigest,
    checkpointRecovery} = value ?? {};
  const checkpointCrash = expected.checkpointCrash === true;
  const originalDigest = checkpointCrash ? checkpointRecovery?.checkpointDigest : originalSavepointDigest;
  const recoveryMatches = checkpointCrash
    ? originalSavepointDigest === undefined && Number.isSafeInteger(checkpointRecovery?.checkpointId) &&
      checkpointRecovery.checkpointId > 0 && checkpointRecovery.restoredCheckpointId === checkpointRecovery.checkpointId &&
      checkpointRecovery.exitCode === 137 && checkpointRecovery.inputOffsetBeforeExit === 4 &&
      checkpointRecovery.committedUpdatesAtExit === committedUpdatesBefore
    : checkpointRecovery === undefined;
  if (scope !== "LOCAL_KAFKA_FLINK_SYNTHETIC_QUOTES" || result !== "VERIFIED" ||
      kafkaVersion !== "4.1.2" || flinkVersion !== "1.20.5" || inputEvents !== 9 ||
      committedUpdatesBefore !== 4 || committedUpdatesAfter !== 5 ||
      fixtureDigest !== expected.fixtureDigest ||
      !hex(originalJobId,32) || !hex(restoredJobId,32) || originalJobId === restoredJobId ||
      !hex(originalDigest,64) || !hex(restoredSavepointDigest,64) ||
      originalDigest === restoredSavepointDigest || !recoveryMatches ||
      !finalQuotes || Object.keys(finalQuotes).length !== expected.quotes.length ||
      !expected.quotes.every(quote => {
        const observed = finalQuotes[quote.security_code];
        return observed && Object.keys(observed).length === Object.keys(quote).length &&
          Object.entries(quote).every(([key, expected]) => observed[key] === expected);
      })) throw new Error("KAFKA_FLINK_EVIDENCE_MISMATCH");
  return {scope,result,kafkaVersion,flinkVersion,inputEvents,committedUpdatesBefore,committedUpdatesAfter,fixtureDigest,
    originalJobId,restoredJobId,restoredSavepointDigest,
    ...(checkpointCrash ? {checkpointRecovery:{
      checkpointId:checkpointRecovery.checkpointId,restoredCheckpointId:checkpointRecovery.restoredCheckpointId,
      checkpointDigest:originalDigest,exitCode:checkpointRecovery.exitCode,
      inputOffsetBeforeExit:checkpointRecovery.inputOffsetBeforeExit,committedUpdatesAtExit:checkpointRecovery.committedUpdatesAtExit,
    }} : {originalSavepointDigest}),
    quotes:expected.quotes.map(quote => finalQuotes[quote.security_code])};
}

export function createKafkaFlinkRunner(env, root) {
  if (env.V2_LOCAL_KAFKA_FLINK_ENABLED !== "true" ||
      ![env.JAVA_HOME, env.SHUDUO_REALTIME_MAVEN_REPO].every(path =>
        typeof path === "string" && isAbsolute(path))) return undefined;
  const workRoot = join(root, ".runtime", "realtime-kafka-flink");
  const configuredBootstrap=env.V2_LOCAL_KAFKA_FLINK_LIVE_BOOTSTRAP;
  const bootstrap=loopbackKafkaBootstrap(configuredBootstrap);
  if (configuredBootstrap!==undefined && !bootstrap) return undefined;
  const brokerCrash = !bootstrap && env.V2_LOCAL_KAFKA_FLINK_BROKER_CRASH === "true";
  const windowCrash = !bootstrap && (brokerCrash || env.V2_LOCAL_KAFKA_FLINK_WINDOW_CRASH === "true");
  const checkpointCrash = !bootstrap && !windowCrash && env.V2_LOCAL_KAFKA_FLINK_CHECKPOINT_CRASH === "true";
  const liveSqlDigest = bootstrap
    ? createHash("sha256").update(readFileSync(join(repo,"scripts/realtime-lab/live-windows.sql"))).digest("hex")
    : undefined;
  const windowSqlDigest = windowCrash
    ? createHash("sha256").update(readFileSync(join(repo,"scripts/realtime-lab/windows.sql"))).digest("hex")
    : undefined;
  const childEnvironment = {
    PATH: env.PATH || "/usr/bin:/bin",
    JAVA_HOME: env.JAVA_HOME,
    ...(env.MAVEN_BIN ? {MAVEN_BIN: env.MAVEN_BIN} : {}),
    SHUDUO_REALTIME_MAVEN_REPO: env.SHUDUO_REALTIME_MAVEN_REPO,
    SHUDUO_REALTIME_OFFLINE: "1",
    ...(bootstrap ? {SHUDUO_REALTIME_LIVE_BOOTSTRAP:bootstrap} : {}),
  };
  const script=join(repo,"scripts/realtime-lab/run.sh");
  const run = async ({signal,onProgress}) => {
    if (signal.aborted) throw new Error("KAFKA_FLINK_CANCELLED");
    mkdirSync(workRoot, {recursive:true,mode:0o700});
    const work = mkdtempSync(join(workRoot,"run-"));
    if (bootstrap) return runLiveWindowProcess({script,work,repo,env:childEnvironment,signal,sqlDigest:liveSqlDigest,onProgress});
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", [script, work,
        ...(brokerCrash ? ["--broker-crash"] : windowCrash ? ["--window-crash"] : checkpointCrash ? ["--checkpoint-crash"] : [])], {
        cwd:repo, env:childEnvironment, detached:true, stdio:["ignore","pipe","ignore"],
      });
      let output = "", failure, killTimer;
      const kill = (name) => {
        if (!child.pid) return;
        try { process.kill(-child.pid,name); } catch (error) {
          if (error.code !== "ESRCH") failure ??= new Error("KAFKA_FLINK_PROCESS_ERROR");
        }
      };
      const stop = (reason) => {
        if (failure) return;
        failure = new Error(reason);
        kill("SIGTERM");
        killTimer = setTimeout(() => kill("SIGKILL"), 4000);
      };
      const abort = () => stop("KAFKA_FLINK_CANCELLED");
      const deadline = setTimeout(() => stop("KAFKA_FLINK_TIMEOUT"), 180_000);
      signal.addEventListener("abort", abort, {once:true});
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (failure) return;
        output += chunk;
        if (output.length > 32_768) stop("KAFKA_FLINK_OUTPUT_LIMIT");
      });
      child.once("error", () => { failure ??= new Error("KAFKA_FLINK_PROCESS_ERROR"); });
      child.once("close", code => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal.removeEventListener("abort", abort);
        if (failure) {
          kill("SIGKILL");
          reject(failure);
        } else if (code !== 0 || !output.startsWith("Run directory: ") || !output.includes("\n")) {
          reject(new Error("KAFKA_FLINK_EXECUTION_FAILED"));
        } else {
          try { resolve(JSON.parse(output.slice(output.indexOf("\n") + 1))); }
          catch { reject(new Error("KAFKA_FLINK_EVIDENCE_MISMATCH")); }
        }
      });
    });
  };
  return Object.assign(run,{checkpointCrash,windowSqlDigest,brokerCrash,liveSqlDigest});
}
