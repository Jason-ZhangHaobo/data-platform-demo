import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export function pythonRuntimeConfig(env = process.env, root = process.cwd()) {
  const python = env.V2_PYTHON ?? join(root, ".runtime/python/bin/python");
  return {
    python,
    root,
    artifactRoot: env.V2_ARTIFACT_ROOT ?? root,
    retainArtifacts: env.V2_RETAIN_PYTHON_ARTIFACTS === "true",
    requireMemoryLimit: env.V2_PYTHON_REQUIRE_MEMORY_LIMIT === "true",
    available: existsSync(python),
  };
}

export function runRestrictedPython(
  { code, context, validationContexts = [], signal, timeoutMs = 10_000 },
  config = pythonRuntimeConfig(),
) {
  if (signal?.aborted) return Promise.reject(new Error("运行已取消"));
  if (typeof code !== "string" || code.length < 20 || code.length > 20_000)
    return Promise.reject(new Error("Python代码长度不合法"));
  if (!Array.isArray(validationContexts) || validationContexts.length > 5)
    return Promise.reject(new Error("Python回归上下文数量不合法"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)
    return Promise.reject(new Error("Python超时配置不合法"));
  if (!config.available)
    return Promise.reject(
      Object.assign(new Error("Python运行环境尚未就绪"), { status: 503 }),
    );
  const directory = resolve(
      config.artifactRoot,
      ".v2-artifacts",
      "python",
      randomUUID(),
    ),
    input = join(directory, "input.json"),
    output = join(directory, "output.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    input,
    JSON.stringify({ code, context, validationContexts }),
    { mode: 0o600 },
  );
  return new Promise((resolveResult, reject) => {
    let log = "",
      finished = false,
      timedOut = false;
    const cleanup = () => {
      if (!config.retainArtifacts)
        rmSync(directory, { recursive: true, force: true });
    };
    const child = spawn(
      config.python,
      ["-I", "-S", join(config.root, "src/v2/python-worker.py"), input, output],
      {
        cwd: directory,
        detached: process.platform !== "win32",
        env: {
          PATH: process.env.PATH,
          LC_ALL: "C.UTF-8",
          PYTHONHASHSEED: "0",
          TMPDIR: directory,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const append = (chunk) => {
      log = (log + chunk.toString()).slice(-8000);
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
    child.on("close", (exitCode) => {
      if (finished) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        cleanup();
        return reject(new Error("运行已取消"));
      }
      if (timedOut) {
        cleanup();
        return reject(new Error("Python执行超时，运行进程已终止"));
      }
      let result;
      try {
        result = JSON.parse(readFileSync(output, "utf8"));
      } catch {
        cleanup();
        return reject(new Error("Python未返回结果；" + log.slice(-1200)));
      }
      if (
        config.requireMemoryLimit &&
        result.resourceLimits?.addressSpace !== true
      ) {
        cleanup();
        return reject(
          new Error("当前Python执行环境未能强制内存上限，已拒绝运行结果"),
        );
      }
      cleanup();
      resolveResult({
        ...result,
        exitCode,
        ...(config.retainArtifacts ? { directory } : {}),
      });
    });
  });
}
