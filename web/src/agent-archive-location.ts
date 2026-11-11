import type {BatchArchive} from "../../src/v2/private-batch-archive-client.mjs";

export type AgentArchivePin = {requestId: string; batchId: string; digest: string};
const fields = ["archiveRequest", "archiveBatch", "archiveDigest"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const valid = (pin: AgentArchivePin) => uuid.test(pin.requestId) && uuid.test(pin.batchId) && hash.test(pin.digest);

export function agentArchivePin(href: string, taskId: string): AgentArchivePin | null | undefined {
  const url = new URL(href), params = url.searchParams;
  if (!fields.some(field => params.has(field))) return undefined;
  if (url.pathname !== "/v2/" || params.get("module") !== "agent-center" || params.getAll("module").length !== 1 ||
      params.get("task") !== taskId || params.getAll("task").length !== 1 || !uuid.test(taskId) ||
      fields.some(field => params.getAll(field).length !== 1)) return null;
  const pin = {requestId:params.get("archiveRequest")!, batchId:params.get("archiveBatch")!, digest:params.get("archiveDigest")!};
  return valid(pin) ? pin : null;
}

export function clearAgentArchivePin(url: URL) {
  for (const field of fields) url.searchParams.delete(field);
  if (url.hash === "#agent-report-archives") url.hash = "";
  return url;
}

export function agentArchiveHref(href: string, taskId: string, pin?: AgentArchivePin) {
  const url = clearAgentArchivePin(new URL(href));
  url.searchParams.set("module", "agent-center");
  url.searchParams.set("task", taskId);
  if (pin) {
    if (!uuid.test(taskId) || !valid(pin)) throw Error("归档版本链接不完整。");
    url.searchParams.set("archiveRequest", pin.requestId);
    url.searchParams.set("archiveBatch", pin.batchId);
    url.searchParams.set("archiveDigest", pin.digest);
  }
  return url.pathname + url.search + "#agent-report-archives";
}

export function checkedAgentArchive(receipt: BatchArchive, taskId: string, pin: AgentArchivePin) {
  const source = receipt.summary.source;
  if (receipt.review.requestId !== pin.requestId || source.taskId !== taskId || source.batchId !== pin.batchId || receipt.digest !== pin.digest)
    throw Error("原归档与此任务、批次或版本摘要不一致。");
  return receipt;
}
