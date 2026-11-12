import { checkedAgentConsumption, checkedAgentPublication } from "./agent-delivery-evidence-read.ts";
import type { TaskConsumption } from "./agent-journey";
import { serviceEvidencePath } from "./service-source-binding.ts";

const fragment = "#agent-call-history?";
const keys = ["release", "package", "batch", "call"] as const;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
type Target = Record<typeof keys[number], string> & {taskId: string};
const valid = (target: Target) => uuid.test(target.taskId) && uuid.test(target.release) &&
  uuid.test(target.batch) && hash.test(target.package) && hash.test(target.call);

export function agentCallHistoryTarget(href: string, taskId: string): Target | null | undefined {
  const url = new URL(href);
  if (!url.hash.startsWith(fragment)) return undefined;
  const values = new URLSearchParams(url.hash.slice(fragment.length));
  if (url.pathname !== "/v2/" || url.searchParams.size !== 2 ||
      url.searchParams.get("module") !== "agent-center" || url.searchParams.get("task") !== taskId ||
      values.size !== keys.length || keys.some(key => values.getAll(key).length !== 1)) return null;
  const target = {taskId, release: values.get("release")!, package: values.get("package")!,
    batch: values.get("batch")!, call: values.get("call")!};
  return valid(target) ? target : null;
}

async function callDigest(id: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

export async function agentCallHistoryHref(href: string, source: Omit<Target, "call">, callId: string) {
  if (!uuid.test(callId)) throw Error("原调用编号不完整。");
  const target = {...source, call: await callDigest(callId)};
  if (!valid(target)) throw Error("原调用来源不完整。");
  const url = new URL("/v2/", href);
  url.search = new URLSearchParams({module: "agent-center", task: target.taskId}).toString();
  url.hash = fragment + new URLSearchParams({release: target.release, package: target.package, batch: target.batch, call: target.call});
  return url.href;
}

export async function readAgentCallHistory(api: <T>(path: string) => Promise<T>, target: Target): Promise<TaskConsumption["services"][number]> {
  if (!valid(target)) throw Error("原调用链接不完整。");
  const query = new URLSearchParams({releaseId: target.release, packageDigest: target.package});
  const path = "/agent/tasks/" + target.taskId + "/publication/history?" + query;
  const publication = checkedAgentPublication(await api(path), {
    taskId: target.taskId, scope: "PRIVATE_CLOUD_TEST", releaseId: target.release, requireRelease: true,
  });
  const release = publication.release, batch = publication.runs.find(run => run.id === target.batch);
  if (publication.readMode !== "SAVED_HISTORY" || !release || release.sourceAgentTaskId !== target.taskId ||
      release.packageDigest !== target.package || (release.sourceKind ?? "AGENT") !== "AGENT" ||
      release.status !== "COMPLETED_CLOUD_TEST" || release.health !== "HEALTHY" ||
      !release.sourceRevisionId || !release.sourceRunId || batch?.status !== "SUCCEEDED" || batch.schedulerTriggered !== true ||
      !publication.events.some(event => event.type === "BATCH_SUCCEEDED" && event.releaseRunId === batch.id))
    throw Error("原发布、交付包或批次的证据不一致。");
  const binding = {taskId: target.taskId, releaseId: target.release, packageDigest: target.package,
    sourceKind: "AGENT" as const, scope: "PRIVATE_CLOUD_TEST" as const, revisionId: release.sourceRevisionId, runId: release.sourceRunId};
  const proof = checkedAgentConsumption(await api(serviceEvidencePath(binding) + "&call_id_digest=" + target.call),
    binding, [batch]);
  const entry = proof.services[0];
  if (proof.services.length !== 1 || entry?.status !== "VERIFIED" || !entry.call ||
      entry.sourceRunIds.length !== 1 || entry.sourceRunIds[0] !== target.batch || await callDigest(entry.call.callId) !== target.call)
    throw Error("未能核验此链接对应的原调用。");
  return entry;
}
