import { cloudV3PredecessorApprovals } from '../src/v2/cloud-v3-case-selection.mjs';
import { cloudWindowApplicationBinding, validNextCloudBinding } from './first-cloud-v3-window.mjs';

export const nextCloudPublicationScope = 'INVITED_NEXT_V3_PUBLICATION_WINDOW_V1';
export const nextCloudConsumptionScope = 'INVITED_NEXT_V3_SERVICE_WINDOW_V1';
export const nextCloudDeliveryBindingProtocol = 'SHUDUO_NEXT_V3_DELIVERY_BINDING_V1';

const formalOrigin = 'https://shuduoai.cn';
const artifactFields = ['taskId', 'packageId', 'packageDigest', 'verificationId', 'reviewDigest'];
const bindingFields = [
  'protocol', 'caseId', 'contextId', 'checkpointDigest', 'predecessorCompletionDigest',
  'developmentApprovalDigest', 'approvalDigest', ...artifactFields,
];
const consumeFields = ['publicationApprovalDigest', 'releaseId', 'batchIds'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const sameFields = (left, right, keys) => Boolean(left && right && keys.every(key => left[key] === right[key]));

function validPublication(plan, proof) {
  if (!sameFields(proof, plan.publicationApproval, [...artifactFields, 'approvalDigest']) ||
      !sameFields(proof, plan.target, ['taskId', 'packageDigest', 'verificationId'])) return false;
  if (plan.releaseBinding === undefined) return plan.releaseId === undefined;
  return sameFields(proof, plan.releaseBinding, artifactFields) &&
    uuid(plan.releaseId) && plan.releaseBinding.releaseId === plan.releaseId && plan.releaseBinding.batchCount === 2;
}

function validConsumption(plan, proof) {
  const { batchIds, releaseId, approvalDigest } = proof;
  const release = plan.releaseBinding;
  if (approvalDigest !== plan.approvalDigest || !uuid(releaseId) || !Array.isArray(batchIds) ||
      batchIds.length !== 2 || !uuid(batchIds[0]) || !uuid(batchIds[1]) || batchIds[0] === batchIds[1] ||
      !sameFields(proof, release, [...artifactFields, 'releaseId', 'publicationApprovalDigest']) ||
      !Array.isArray(release.batchIds) || release.batchIds.length !== 2 ||
      release.batchIds[0] !== batchIds[0] || release.batchIds[1] !== batchIds[1] ||
      release.closureStatus !== 'CLOSED_READONLY' || release.monitoringStatus !== 'VERIFIED' ||
      !sameFields(proof, plan.target, ['taskId', 'packageDigest']) ||
      ![1, 2].includes(plan.sequence) || plan.target.sourceReleaseRunId !== batchIds[plan.sequence - 1]) return false;
  const previous = plan.previousServiceClose;
  if (plan.sequence === 1) return previous === undefined;
  return previous?.scope === nextCloudConsumptionScope && previous.sequence === 1 &&
    previous.phase === 'CLOSED_READONLY' && previous.applicationRevoked === true &&
    previous.approvalDigest === approvalDigest && previous.releaseId === releaseId && previous.sourceReleaseRunId === batchIds[0];
}

// This binds the next-case evidence in a plan already authenticated by the
// protected operator. Publication timers, runtime limits and bill checks
// remain the responsibility of the operator's phase-specific validators.
export function nextCloudDeliveryApplicationBinding(plan, kind) {
  const consumption = kind === 'consumption';
  if ((!consumption && kind !== 'publication') ||
      plan?.scope !== (consumption ? nextCloudConsumptionScope : nextCloudPublicationScope) ||
      plan.firstCase !== undefined || !validNextCloudBinding(plan.nextCase) || plan.nextCase.origin !== formalOrigin)
    return;

  const { nextCase, nextCaseDelivery: proof } = plan;
  if (!exactKeys(proof, consumption ? [...bindingFields, ...consumeFields] : bindingFields) ||
      proof.protocol !== nextCloudDeliveryBindingProtocol ||
      !sameFields(proof, nextCase, ['caseId', 'contextId', 'checkpointDigest']) ||
      proof.predecessorCompletionDigest !== nextCase.previousCase.completionDigest ||
      !['taskId', 'packageId', 'verificationId'].every(key => uuid(proof[key])) ||
      !['packageDigest', 'reviewDigest'].every(key => digest(proof[key]))) return;

  const approvals = [proof.developmentApprovalDigest, proof.approvalDigest];
  if (consumption) approvals.push(proof.publicationApprovalDigest);
  const predecessorApprovals = cloudV3PredecessorApprovals(nextCase.previousCase);
  if (!approvals.every(value => digest(value) && !predecessorApprovals.includes(value)) || new Set(approvals).size !== approvals.length)
    return;

  const bound = consumption ? validConsumption(plan, proof) : validPublication(plan, proof);
  return bound ? cloudWindowApplicationBinding(plan.applicationInspection, nextCase) : undefined;
}
