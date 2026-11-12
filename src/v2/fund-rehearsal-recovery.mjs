import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { linkSync, lstatSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual as same } from "node:util";
import { loadDeliveryDirectory } from "./delivery.mjs";
import { assertFundRehearsal, fundSignedRehearsalDigest } from "./fund-publication.mjs";
import { readPrivateFundReceipt } from "./fund-signed-receipts.mjs";

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const receiptName = "fund-rehearsal-recovery.json";
const namespace = "shuduo-fund-local-rehearsal/v1\0";
const unconfirmedStage = "FILE_REHEARSAL_UNCONFIRMED";
const unconfirmedMessage = "原文件演练结果待核对。保留原编号，请核对受保护回执。";
const unproven = () => Object.assign(new Error(unconfirmedMessage), { code: "FUND_REHEARSAL_RECOVERY_UNPROVEN", status: 409 });
const authenticate = (body, evidence) => createHmac("sha256", evidence.queueConfig.sharedSecret).update(namespace).update(body).digest();

function claimFor(task, bundle, verification) {
  const source = bundle?.manifest?.source;
  if (!uuid.test(task.id) || task.mode !== "VERIFIED_ARTIFACT_ORCHESTRATION" || !task.signedPackageDigest ||
      !["FILE_REHEARSAL_RUNNING", unconfirmedStage].includes(task.stage) ||
      !["RUNNING", "INTERRUPTED"].includes(task.status) || verification?.status !== task.status ||
      bundle?.agentDeliveryTaskId !== task.id || bundle.id !== task.packageId || bundle.digest !== task.signedPackageDigest ||
      bundle.digest !== task.packageDigest || !source?.fundSignedExecution || source.runId !== task.sourceRunId ||
      source.revisionId !== task.sourceRevisionId || source.sqlHash !== task.sourceSqlHash ||
      source.attribution?.originAgentTaskId !== task.sourceAgentTaskId ||
      verification.id !== task.verificationId || verification.agentDeliveryTaskId !== task.id ||
      verification.packageId !== bundle.id || verification.packageDigest !== bundle.digest)
    throw unproven();
  return { project: task.projectId, deliveryId: task.id, verificationId: verification.id,
    verificationCreatedAt: verification.createdAt, packageId: bundle.id, packageDigest: bundle.digest,
    scheduledFor: verification.scheduledFor };
}

function checkReceipt(bundle, claim, receipt, evidence) {
  if (!receipt || !evidence || receipt.occurrence?.scheduledFor !== claim.scheduledFor ||
      !(Date.parse(claim.verificationCreatedAt) <= Date.parse(receipt.startedAt) &&
        Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt))) throw unproven();
  assertFundRehearsal(bundle, { ...receipt, packageId: claim.packageId });
  fundSignedRehearsalDigest(bundle, receipt, evidence);
}

function checkedReceiptPath(root, claim) {
  const parent = join(root, ".v2-artifacts", "agent-deliveries");
  const directory = join(parent, claim.deliveryId);
  for (const path of [parent, directory]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw unproven();
  }
  loadDeliveryDirectory(directory, claim.packageDigest);
  return join(directory, receiptName);
}

function writeRecoveryReceipt(path, claim, receipt, evidence) {
  const body = JSON.stringify({ claim, receipt });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ body, signature: authenticate(body, evidence).toString("hex") }),
    { flag: "wx", mode: 0o600, flush: true });
  try { linkSync(temporary, path); }
  finally { unlinkSync(temporary); }
}

function readRecoveryReceipt(path, claim, evidence) {
  if (!evidence) throw unproven();
  const { body, signature } = JSON.parse(readPrivateFundReceipt(path));
  if (typeof body !== "string" || typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(authenticate(body, evidence), Buffer.from(signature, "hex"))) throw unproven();
  const saved = JSON.parse(body);
  if (!same(saved.claim, claim)) throw unproven();
  return saved.receipt;
}

export function createFundRehearsalRecovery({ store, project, root, evidenceFor, assertSource }) {
  const read = (kind, id) => typeof id === "string" ? store.get(kind, id, project) : undefined;
  const update = (kind, item, patch) => store.update(kind, item.id, project, patch, { expectedVersion: item.version });
  const transaction = work => {
    store.db.exec("BEGIN IMMEDIATE");
    try { work(); store.db.exec("COMMIT"); }
    catch (error) {
      if (store.db.isTransaction) store.db.exec("ROLLBACK");
      throw error;
    }
  };
  const settle = task => {
    if (!task.signedPackageDigest || !["FILE_REHEARSAL_RUNNING", unconfirmedStage].includes(task.stage) ||
        !["RUNNING", "INTERRUPTED"].includes(task.status)) return;
    const bundle = read("delivery_package", task.packageId);
    const verification = read("delivery_verification", task.verificationId);
    let receipt;
    try {
      const claim = claimFor(task, bundle, verification);
      assertSource(bundle);
      const evidence = evidenceFor(bundle);
      const saved = readRecoveryReceipt(checkedReceiptPath(root, claim), claim, evidence);
      checkReceipt(bundle, claim, saved, evidence);
      receipt = saved;
    } catch { if (task.stage === unconfirmedStage) return; }
    transaction(() => {
      if (read("agent_delivery_task", task.id)?.version !== task.version ||
          (verification && read("delivery_verification", verification.id)?.version !== verification.version)) return;
      if (receipt) {
        update("delivery_verification", verification, { ...receipt, status: "SUCCEEDED", published: false,
          fullLifecycleE2E: false, error: undefined, errorCode: undefined });
        update("agent_delivery_task", task, { status: "SUCCEEDED", stage: "AWAITING_ENGINEER_REVIEW",
          actualExecution: true, finishedAt: receipt.finishedAt, error: undefined,
          ...(task.status === "INTERRUPTED" ? { recoveredFromFileReceipt: true } : {}),
          notice: "文件演练已通过。发布前须由工程师审阅确切版本。" });
      } else {
        if (verification?.status === "RUNNING" && verification.agentDeliveryTaskId === task.id)
          update("delivery_verification", verification, { status: "INTERRUPTED", error: unconfirmedMessage });
        update("agent_delivery_task", task, { status: "INTERRUPTED", stage: unconfirmedStage, error: unconfirmedMessage });
      }
    });
  };
  return {
    complete(task, bundle, verification, receipt) {
      const claim = claimFor(task, bundle, verification);
      const evidence = evidenceFor(bundle);
      checkReceipt(bundle, claim, receipt, evidence);
      writeRecoveryReceipt(checkedReceiptPath(root, claim), claim, receipt, evidence);
      settle(task);
    },
    recover(task) {
      if (task.status === "INTERRUPTED") settle(task);
    },
  };
}
