import {isDeepStrictEqual} from 'node:util';
import {uuid} from './live-lifecycle-checkpoint.mjs';

const id=value=>typeof value==='string'&&uuid.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const rehearsalWakeKey=(project,deliveryId)=>`${project}:rehearsal-wake:${deliveryId}`;

export function rehearsalWakeFor(store,project,deliveryId) {
  const id=store.deduplicatedId(rehearsalWakeKey(project,deliveryId));
  return id&&store.get('rehearsal_wake',id,project);
}

export function rehearsalWakeMatches(wake,delivery) {
  const binding=wake?.binding;
  return Boolean(binding && delivery && binding.deliveryId===delivery.id && binding.taskId===delivery.sourceAgentTaskId && binding.actorId===delivery.submittedBy &&
    binding.packageId===delivery.packageId && binding.packageDigest===delivery.packageDigest);
}

export function validBackgroundRehearsalEvidence(evidence,code,delivery,rehearsal) {
  return code?.sourceKind==='AGENT' && [code.taskId,code.revisionId,code.runId,delivery?.id,delivery?.packageId,rehearsal?.id,evidence?.wakeId].every(id) &&
    digest(code.revisionHash)&&digest(delivery.packageDigest)&&digest(evidence.workerResultDigest)&&rehearsal.status==='SUCCEEDED'&&
    isDeepStrictEqual(evidence,{trigger:'SIGNED_BACKGROUND_EVENT',taskId:code.taskId,revisionId:code.revisionId,revisionHash:code.revisionHash,developmentRunId:code.runId,
      deliveryId:delivery.id,packageId:delivery.packageId,packageDigest:delivery.packageDigest,verificationId:rehearsal.id,
      wakeId:evidence.wakeId,workerResultDigest:evidence.workerResultDigest});
}
