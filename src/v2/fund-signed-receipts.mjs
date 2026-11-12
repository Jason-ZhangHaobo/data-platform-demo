import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./delivery.mjs";
import { verifyFundSignedExecution } from "./fund-signed-execution.mjs";
import { queueConfigFromEnvironment } from "./remote-spark-queue.mjs";

const kind = "fund_signed_execution";
const maxBytes = 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;
const missing = () => Object.assign(new Error("基金签名原件缺失或与登记摘要不符"), {
  status: 409, code: "FUND_SIGNED_RECEIPT_UNAVAILABLE",
});

export function readPrivateFundReceipt(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid() || info.size > maxBytes) throw missing();
    const body = readFileSync(fd);
    if (body.length !== info.size) throw missing();
    return body;
  } finally { closeSync(fd); }
}

// Local operator registration links a completed signed Worker result to one
// original run. Metadata contains only the reference. The signing key stays in
// the runtime, and the raw Worker objects never enter public artifact storage.
export function createFundSignedReceipts({ store, project, root, env }) {
  const directory = join(root, ".data", "fund-signed-receipts");
  const keyFor = runId => `${project}:fund-signed-execution:${runId}`;
  const queueConfig = () => {
    try {
      return queueConfigFromEnvironment({ ...env, V2_PROJECT_ID: project, V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE" });
    } catch { throw missing(); }
  };
  const assertDirectory = () => {
    const parent = lstatSync(dirname(directory));
    const info = lstatSync(directory);
    const uid = process.getuid();
    if (!parent.isDirectory() || (parent.mode & 0o022) !== 0 || parent.uid !== uid ||
        !info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== uid) throw missing();
  };
  const read = runId => {
    const id = store.deduplicatedId(keyFor(runId));
    if (!id) return;
    const record = store.get(kind, id, project);
    if (record?.selection?.runId !== runId || !digestPattern.test(record.digest)) throw missing();
    let proof;
    try {
      assertDirectory();
      const body = readPrivateFundReceipt(join(directory, `${record.digest}.json`));
      if (sha256(body) !== record.digest) throw missing();
      proof = JSON.parse(body.toString("utf8"));
    } catch { throw missing(); }
    return { ...proof, queueConfig: queueConfig(), source: { store, project, actorId: record.actorId, selection: record.selection } };
  };
  const register = ({ selection, preflightDigest, jobId, serializedJob, envelope }) => {
    const actorId = store.get("agent", selection.taskId, project)?.submittedBy;
    const source = { store, project, actorId, selection };
    const proof = { preflightDigest, jobId, serializedJob, envelope };
    const body = JSON.stringify(proof);
    if (Buffer.byteLength(body) > maxBytes) throw missing();
    const verified = verifyFundSignedExecution({ ...proof, queueConfig: queueConfig(), source });
    if (!verified) throw missing();
    const digest = sha256(body);
    const key = keyFor(selection.runId);
    const existing = store.deduplicatedId(key);
    if (existing && store.get(kind, existing, project)?.digest !== digest) throw missing();
    // Pin the original receipt first. An atomic link exposes either the entire
    // file or no file. The database association is committed only after that.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertDirectory();
    const file = join(directory, `${digest}.json`), temporary = join(directory, `.${randomUUID()}.tmp`);
    writeFileSync(temporary, body, { flag: "wx", mode: 0o600 });
    try {
      try { linkSync(temporary, file); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      if (sha256(readPrivateFundReceipt(file)) !== digest) throw missing();
      const { id, replayed } = store.deduplicate(key, digest, () => store.create(kind, project, { digest, actorId, selection }));
      return { id, preflightDigest, replayed };
    } finally { unlinkSync(temporary); }
  };
  return { read, register };
}
