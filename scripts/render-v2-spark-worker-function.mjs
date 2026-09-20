import { closeSync, openSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { renderV2SparkWorkerW2Plan } from "./render-v2-spark-worker-w2-plan.mjs";

export function renderV2SparkWorkerFunction(input = {}) {
  const rendered = renderV2SparkWorkerW2Plan(input);
  if (!rendered.ok) return rendered;
  const fn = rendered.plan.function;
  return {
    ok: true,
    body: {
      ...fn,
      environmentVariables: {
        ...fn.environmentVariables,
        V2_SPARK_WORKER_SECRET: input.V2_SPARK_WORKER_SECRET,
      },
    },
  };
}

function safeOutputPath(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("INVALID:V2_SPARK_WORKER_FUNCTION_BODY_FILE");
  const parent = dirname(path),
    parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error("UNSAFE:V2_SPARK_WORKER_FUNCTION_BODY_FILE");
  return join(realpathSync(parent), basename(path));
}

function run() {
  const rendered = renderV2SparkWorkerFunction(process.env);
  if (!rendered.ok) {
    process.stdout.write(JSON.stringify(rendered) + "\n");
    process.exitCode = 1;
    return;
  }
  let descriptor;
  try {
    const target = safeOutputPath(
      process.env.V2_SPARK_WORKER_FUNCTION_BODY_FILE,
    );
    descriptor = openSync(target, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(rendered.body), "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    process.stdout.write(
      JSON.stringify({
        ok: true,
        fileCreated: true,
        secretEchoed: false,
        functionNameHash: createHash("sha256")
          .update(rendered.body.functionName)
          .digest("hex"),
      }) + "\n",
    );
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    const code =
      typeof error.message === "string" &&
      /^[A-Z][A-Z0-9_:.-]{2,100}$/.test(error.message)
        ? error.message
        : "SPARK_WORKER_FUNCTION_BODY_WRITE_FAILED";
    process.stderr.write(JSON.stringify({ ok: false, code }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
