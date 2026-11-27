import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const kafkaFlinkAdapter = "kafka-flink-local-v1";
const repo = fileURLToPath(new URL("../../", import.meta.url));
const hex = (value, length) =>
  typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);

export function kafkaFlinkEvidence(value, expected) {
  const {scope, result, kafkaVersion, flinkVersion, inputEvents, committedUpdatesBefore, committedUpdatesAfter,
    originalJobId, restoredJobId, originalSavepointDigest, restoredSavepointDigest, finalQuotes, fixtureDigest} = value ?? {};
  if (scope !== "LOCAL_KAFKA_FLINK_SYNTHETIC_QUOTES" || result !== "VERIFIED" ||
      kafkaVersion !== "4.1.2" || flinkVersion !== "1.20.5" || inputEvents !== 9 ||
      committedUpdatesBefore !== 4 || committedUpdatesAfter !== 5 ||
      fixtureDigest !== expected.fixtureDigest ||
      !hex(originalJobId,32) || !hex(restoredJobId,32) || originalJobId === restoredJobId ||
      !hex(originalSavepointDigest,64) || !hex(restoredSavepointDigest,64) ||
      originalSavepointDigest === restoredSavepointDigest ||
      !finalQuotes || Object.keys(finalQuotes).length !== expected.quotes.length ||
      !expected.quotes.every(quote => {
        const observed = finalQuotes[quote.security_code];
        return observed && Object.keys(observed).length === Object.keys(quote).length &&
          Object.entries(quote).every(([key, expected]) => observed[key] === expected);
      })) throw new Error("KAFKA_FLINK_EVIDENCE_MISMATCH");
  return {scope,result,kafkaVersion,flinkVersion,inputEvents,committedUpdatesBefore,committedUpdatesAfter,fixtureDigest,
    originalJobId,restoredJobId,originalSavepointDigest,restoredSavepointDigest,
    quotes:expected.quotes.map(quote => finalQuotes[quote.security_code])};
}

export function createKafkaFlinkRunner(env, root) {
  if (env.V2_LOCAL_KAFKA_FLINK_ENABLED !== "true" ||
      ![env.JAVA_HOME, env.SHUDUO_REALTIME_MAVEN_REPO].every(path =>
        typeof path === "string" && isAbsolute(path))) return undefined;
  const workRoot = join(root, ".runtime", "realtime-kafka-flink");
  const childEnvironment = {
    PATH: env.PATH || "/usr/bin:/bin",
    JAVA_HOME: env.JAVA_HOME,
    ...(env.MAVEN_BIN ? {MAVEN_BIN: env.MAVEN_BIN} : {}),
    SHUDUO_REALTIME_MAVEN_REPO: env.SHUDUO_REALTIME_MAVEN_REPO,
    SHUDUO_REALTIME_OFFLINE: "1",
  };
  return async ({signal}) => {
    if (signal.aborted) throw new Error("KAFKA_FLINK_CANCELLED");
    mkdirSync(workRoot, {recursive:true,mode:0o700});
    const work = mkdtempSync(join(workRoot,"run-"));
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", [join(repo, "scripts/realtime-lab/run.sh"), work], {
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
}
