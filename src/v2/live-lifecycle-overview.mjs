import {lstatSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {getContext} from "./context.mjs";
import {checkpointScope, directory, links, readCheckpoint, uuid} from "./live-lifecycle-checkpoint.mjs";
import {currentLiveLifecycleContract, liveLifecycleCases, summarizeLiveLifecycle, verifyLiveCaseEvidence} from "./live-lifecycle-evaluation.mjs";

const contractId = currentLiveLifecycleContract.id;
const statuses = new Set([
  "NOT_RUN", "RUNNING", "AWAITING_SOURCE", "BLOCKED_SOURCE", "AWAITING_ENGINEER_REVIEW",
  "AWAITING_MONITORING", "AWAITING_CONSUMPTION", "PAUSED", "FAILED",
]);
const phases = new Set([
  "REQUIREMENT", "SOURCE_CONTEXT", "CODE_AND_DEBUG", "DELIVERY_PREPARATION",
  "ENGINEER_REVIEW_AND_PUBLICATION", "POST_RELEASE_MONITORING", "CONSUMPTION", "COMPLETE",
]);
const failure = (status, message) => Object.assign(Error(message), {status});

function loadRuns(root, selectedId) {
  const artifacts = join(root, ".v2-artifacts");
  const base = join(artifacts, "live-lifecycle");
  for (const path of [artifacts, base]) {
    const info = lstatSync(path, {throwIfNoEntry:false});
    if (!info) return {runs:[], legacyCount:0, unreadableCount:0};
    if (!info.isDirectory() || info.isSymbolicLink())
      throw failure(409, "评测目录无法确认");
  }
  const runs = [];
  let latest, requested, legacyCount = 0, unreadableCount = 0;
  for (const id of readdirSync(base).filter(name => uuid.test(name))) {
    try {
      const runDirectory = join(base, id);
      directory(runDirectory);
      const {state} = readCheckpoint(join(runDirectory, "checkpoint.json"));
      const scope = checkpointScope(state, id, {});
      if (scope.contractId !== contractId) {
        legacyCount++;
        continue;
      }
      const startedAt = new Date(state.startedAt).toISOString();
      const item = {id, startedAt, caseLimit:state.caseLimit};
      runs.push(item);
      if (id === selectedId) requested = state;
      if (!latest || startedAt > latest.startedAt ||
          (startedAt === latest.startedAt && id > latest.state.evaluationRunId)) latest = {startedAt, state};
    } catch {
      unreadableCount++;
    }
  }
  runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.id.localeCompare(left.id));
  return {runs, selected:selectedId ? requested : latest?.state, legacyCount, unreadableCount};
}

function caseRow(definition, index, state, outcomes, simulated) {
  const entry = outcomes.get(definition.id);
  const parent = outcomes.get(definition.sourceCaseId);
  const submission = entry?.actions?.agent;
  const row = {
    caseId:definition.id, context:getContext(definition.contextId).name,
    kind:definition.kind, sourceCaseId:definition.sourceCaseId,
    phase:"REQUIREMENT", status:state && index >= state.caseLimit ? "OUTSIDE_RUN" : "NOT_RUN",
  };
  if (!entry) return row;
  row.phase = phases.has(entry.phase) ? entry.phase : "UNCONFIRMED";
  if (submission && ["UNKNOWN", "SUBMITTING"].includes(submission.status)) {
    row.status = "SUBMISSION_UNKNOWN";
  } else if (entry.status === "SUCCEEDED") {
    const verified = !simulated && verifyLiveCaseEvidence(definition, entry, {contractId, sourceCheckpoint:parent});
    row.status = simulated ? "TEST_HARNESS" : verified ? "RECORDED_PASS" : "UNCONFIRMED";
  } else {
    row.status = statuses.has(entry.status) ? entry.status : "UNCONFIRMED";
  }
  // The destination reads the original workbench records again. An unknown
  // creation receipt cannot supply a task link.
  if (row.status !== "SUBMISSION_UNKNOWN" && uuid.test(entry.taskId ?? "") &&
      submission?.status === "CONFIRMED" && submission.id === entry.taskId) {
    const navigation = links(entry, state.origin, [...outcomes.values()]);
    row.taskUrl = navigation.taskUrl;
    if (!simulated) row.servicesUrl = navigation.servicesUrl;
  }
  return row;
}

export function liveLifecycleOverview(root, selectedId) {
  if (selectedId !== undefined && !uuid.test(selectedId)) throw failure(422, "请选择原评测编号");
  const {runs, selected, legacyCount, unreadableCount} = loadRuns(root, selectedId);
  if (selectedId && !selected) throw failure(404, "该 v3 评测记录无法读取");
  const cases = liveLifecycleCases(contractId);
  const outcomes = new Map((selected?.outcomes ?? []).map(entry => [entry.caseId, entry]));
  const summary = summarizeLiveLifecycle(cases, [...outcomes.values()], {
    contractId, testDouble:selected?.executionEvidenceMode === "TEST_HARNESS",
  });
  const simulated = summary.measurementStatus === "TEST_HARNESS";
  return {
    contractId, runs, legacyCount, unreadableCount,
    selectedId:selected?.evaluationRunId ?? null,
    measurementStatus:summary.measurementStatus,
    verifiedCaseCount:summary.succeededCaseCount,
    attemptedCaseCount:summary.attemptedCaseCount,
    caseCount:summary.frozenCaseCount,
    autonomousCompletionRate:summary.autonomousCompletionRate,
    cases:cases.map((definition, index) => caseRow(definition, index, selected, outcomes, simulated)),
  };
}
