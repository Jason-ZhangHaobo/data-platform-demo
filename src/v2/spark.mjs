import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
export function runtimeConfig(env = process.env, root = process.cwd()) {
  const javaHome = env.JAVA_HOME ?? join(root, ".runtime/java/Contents/Home");
  const python = env.V2_PYTHON ?? join(root, ".runtime/python/bin/python");
  return {
    javaHome,
    python,
    root,
    artifactRoot: env.V2_ARTIFACT_ROOT ?? root,
    retainArtifacts: env.V2_RETAIN_SPARK_ARTIFACTS !== "false",
    available: existsSync(join(javaHome, "bin/java")) && existsSync(python),
  };
}
export function runSpark(
  { sql, context, validationContexts = [], testSql, signal, timeoutMs = 90000 },
  config = runtimeConfig(),
) {
  if (signal?.aborted) return Promise.reject(new Error("运行已取消"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)
    return Promise.reject(new Error("执行超时配置不合法"));
  if (!config.available)
    return Promise.reject(
      Object.assign(
        new Error("Spark 运行环境尚未就绪，请执行 npm run v2:bootstrap"),
        { status: 503 },
      ),
    );
  const directory = resolve(
    config.artifactRoot ?? config.root,
    ".v2-artifacts",
    randomUUID(),
  );
  mkdirSync(directory, { recursive: true });
  const input = join(directory, "input.json"),
    output = join(directory, "output.json");
  writeFileSync(
    input,
    JSON.stringify({ sql, context, validationContexts, testSql }),
  ); // Generated per-run input; never committed.
  return new Promise((resolveResult, reject) => {
    const cleanup = () => {
      if (!config.retainArtifacts)
        rmSync(directory, { recursive: true, force: true });
    };
    const child = spawn(
      config.python,
      [join(config.root, "src/v2/worker.py"), input, output],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH,
          JAVA_HOME: config.javaHome,
          TMPDIR: directory,
          SPARK_LOCAL_DIRS: directory,
          SPARK_LOCAL_IP: "127.0.0.1",
          PYSPARK_PYTHON: config.python,
          OPENBLAS_NUM_THREADS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let log = "",
      finished = false,
      timedOut = false;
    const append = (b) => {
      log = (log + b.toString()).slice(-14000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      finished = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (finished) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        cleanup();
        return reject(new Error("运行已取消"));
      }
      if (timedOut) {
        cleanup();
        return reject(new Error("Spark 执行超时，运行进程已终止"));
      }
      let result;
      try {
        result = JSON.parse(readFileSync(output, "utf8"));
      } catch {
        cleanup();
        return reject(new Error("Spark 未返回结果；" + log.slice(-1800)));
      }
      cleanup();
      resolveResult({
        ...result,
        exitCode: code,
        log,
        ...(config.retainArtifacts ? { directory } : {}),
      });
    });
  });
}
