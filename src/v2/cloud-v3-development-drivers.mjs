import { isDeepStrictEqual } from "node:util";
import { agentExecutionTrigger } from "./agent-execution-drivers.mjs";
import { uuid } from "./live-lifecycle-checkpoint.mjs";

const id = value => typeof value === "string" && uuid.test(value);
const validTrigger = value => value === agentExecutionTrigger(value);

export function bindCloudV3DevelopmentDrivers(attempts, code, originalRunIds) {
  if (code?.sourceKind !== "AGENT" || ![code.taskId, code.revisionId, code.runId].every(id) ||
      !Array.isArray(attempts) || attempts.length < 1 || attempts.length > 3 ||
      attempts.length !== code.modelAttempts || attempts.at(-1)?.spark?.runId !== code.runId) return;
  if (originalRunIds!==undefined && (!Array.isArray(originalRunIds)||originalRunIds.length!==attempts.length||
      !originalRunIds.every((runId,index)=>(runId===null||id(runId))&&runId===(attempts[index]?.spark?.runId??null)))) return;

  const usedRuns = new Set(), boundAttempts = [];
  for (const [index, item] of attempts.entries()) {
    if (item?.attempt !== index + 1 || !validTrigger(item.modelTrigger) ||
        Object.keys(item).length !== (item.spark === undefined ? 2 : 3)) return;
    const entry = {attempt:item.attempt, modelTrigger:item.modelTrigger};
    if (item.spark !== undefined) {
      const {runId,submissionTriggers} = item.spark ?? {};
      if (!id(runId) || usedRuns.has(runId) || !Array.isArray(submissionTriggers) ||
          submissionTriggers.length < 1 || submissionTriggers.length > 4 ||
          !submissionTriggers.every(validTrigger) || new Set(submissionTriggers).size !== submissionTriggers.length ||
          Object.keys(item.spark).length !== 2) return;
      usedRuns.add(runId);
      entry.spark = {runId, submissionTriggers:[...submissionTriggers]};
    }
    boundAttempts.push(entry);
  }
  return {taskId:code.taskId, revisionId:code.revisionId, developmentRunId:code.runId, attempts:boundAttempts};
}

export function validStoredCloudV3DevelopmentDrivers(evidence, code) {
  const bound = bindCloudV3DevelopmentDrivers(evidence?.attempts, code);
  return bound !== undefined && isDeepStrictEqual(evidence, bound);
}
