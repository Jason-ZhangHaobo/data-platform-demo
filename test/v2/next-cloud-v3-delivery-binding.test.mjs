import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../src/v2/delivery.mjs';
import { currentLiveLifecycleContract, liveLifecyclePlan } from '../../src/v2/live-lifecycle-evaluation.mjs';
import { firstCloudDevelopmentScope } from '../../scripts/first-cloud-v3-window.mjs';
import {
  nextCloudConsumptionScope,
  nextCloudDeliveryApplicationBinding,
  nextCloudDeliveryBindingProtocol,
  nextCloudPublicationScope,
} from '../../scripts/next-cloud-v3-delivery-binding.mjs';

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');

function fixture(kind, { ordinal = 2, sequence = 1 } = {}) {
  const { selectedCases, caseSetDigest } = liveLifecyclePlan(ordinal, { contractId: currentLiveLifecycleContract.id });
  const definition = selectedCases.at(-1);
  const source = 'a'.repeat(40);
  const approvals = Array.from({ length: ordinal - 1 }, (_, i) => sha256('prior development ' + i));
  const nextCase = {
    protocol: 'SHUDUO_V3_NEXT_CHECKPOINT_BINDING_V1',
    evaluationRunId: id(1), caseId: definition.id, contextId: definition.contextId,
    caseSetDigest, projectId: 'synthetic-securities', origin: 'https://shuduoai.cn',
    sourceRevision: source, checkpointDigest: sha256('prepared case'), requestKeyHash: sha256('frozen request key'),
    requestBodyHash: sha256(JSON.stringify({ message: definition.request, sql: definition.seedSql, contextId: definition.contextId })),
    previousCase: {
      checkpointDigest: sha256('prior checkpoint'), completionDigest: sha256('prior completion'),
      approvalDigest: approvals.at(-1), reserveCny: 88,
      ...(ordinal > 2 ? { approvalDigests: approvals } : {}),
    },
  };
  const applicationInspection = {
    protocol: 'shuduo-control-artifact-inspection/v1', applicationSource: source, applicationTree: 'b'.repeat(40),
    operatorSource: 'c'.repeat(40), buildWorkflowSource: 'd'.repeat(40), sha256: sha256('inspected application'),
    bytes: 4096, webIndexSha256: sha256('synthetic web index'), webIndexBytes: 512, zipValid: true,
    sensitivePaths: 0, sourceChecks: 3, buildRunId: '1', inspectionRunId: '2', artifactId: '3',
    buildAttempt: '1', artifactDigest: 'sha256:' + sha256('synthetic artifact'),
  };
  const artifacts = { taskId: id(2), packageId: id(3), packageDigest: sha256('frozen delivery'),
    verificationId: id(4), reviewDigest: sha256('engineer review') };
  const nextCaseDelivery = {
    protocol: nextCloudDeliveryBindingProtocol, caseId: nextCase.caseId, contextId: nextCase.contextId,
    checkpointDigest: nextCase.checkpointDigest, predecessorCompletionDigest: nextCase.previousCase.completionDigest,
    developmentApprovalDigest: sha256('new development window'), approvalDigest: sha256(kind + ' approval'), ...artifacts,
  };
  const { taskId, packageDigest, verificationId } = artifacts;
  const shared = { applicationInspection, nextCase, nextCaseDelivery };
  if (kind === 'publication') return {
    ...shared, scope: nextCloudPublicationScope, target: { taskId, packageDigest, verificationId },
    publicationApproval: { ...artifacts, approvalDigest: nextCaseDelivery.approvalDigest },
  };
  const releaseId = id(5), batchIds = [id(6), id(7)];
  const approvalDigest = nextCaseDelivery.approvalDigest;
  const publicationApprovalDigest = sha256('prior publication approval');
  return {
    ...shared, scope: nextCloudConsumptionScope, approvalDigest, sequence,
    nextCaseDelivery: { ...nextCaseDelivery, releaseId, batchIds: [...batchIds], publicationApprovalDigest },
    releaseBinding: { ...artifacts, releaseId, batchIds, publicationApprovalDigest, closureStatus: 'CLOSED_READONLY', monitoringStatus: 'VERIFIED' },
    target: { taskId, packageDigest, sourceReleaseRunId: batchIds[sequence - 1] },
    ...(sequence === 2 ? { previousServiceClose: { scope: nextCloudConsumptionScope, sequence: 1,
      phase: 'CLOSED_READONLY', applicationRevoked: true, approvalDigest, releaseId, sourceReleaseRunId: batchIds[0] } } : {}),
  };
}

test('the prepared cash-change case keeps its inspected application through the reviewed publication and release assignment', () => {
  const plan = fixture('publication');
  const selected = nextCloudDeliveryApplicationBinding(plan, 'publication');
  assert.equal(plan.nextCase.contextId, 'cash-change');
  assert.equal(selected.sha256, plan.applicationInspection.sha256);

  const { approvalDigest, ...reviewed } = plan.publicationApproval;
  plan.releaseId = id(5);
  plan.releaseBinding = { ...reviewed, releaseId: plan.releaseId, batchCount: 2 };
  assert.deepEqual(nextCloudDeliveryApplicationBinding(plan, 'publication'), selected);
  plan.releaseBinding.releaseId = id(8);
  assert.equal(nextCloudDeliveryApplicationBinding(plan, 'publication'), undefined);
});

test('a correctly attested next batch can continue only the same closed first batch and current approval', () => {
  const first = fixture('consumption');
  const second = fixture('consumption', { sequence: 2 });
  const expected = nextCloudDeliveryApplicationBinding(first, 'consumption');
  assert.ok(expected);
  assert.deepEqual(nextCloudDeliveryApplicationBinding(second, 'consumption'), expected);
  for (const alter of [
    p => { delete p.previousServiceClose; },
    p => { p.previousServiceClose.approvalDigest = sha256('older window'); },
    p => { p.previousServiceClose.scope = 'INVITED_FIRST_V3_SERVICE_WINDOW_V1'; },
    p => { p.previousServiceClose.releaseId = id(8); },
    p => { p.previousServiceClose.sourceReleaseRunId = p.releaseBinding.batchIds[1]; },
    p => { p.previousServiceClose.applicationRevoked = false; },
    p => { p.target.sourceReleaseRunId = p.releaseBinding.batchIds[0]; },
  ]) {
    const stale = structuredClone(second);
    alter(stale);
    assert.equal(nextCloudDeliveryApplicationBinding(stale, 'consumption'), undefined);
  }
  first.previousServiceClose = second.previousServiceClose;
  assert.equal(nextCloudDeliveryApplicationBinding(first, 'consumption'), undefined);
});

test('the frozen case, predecessor, package and exact current publication approval cannot be replaced', () => {
  for (const alter of [
    p => { p.scope = firstCloudDevelopmentScope; },
    p => { p.firstCase = {}; },
    p => { p.nextCaseDelivery.caseId = 'v3-fresh--holdings-t1'; },
    p => { p.nextCase.contextId = p.nextCaseDelivery.contextId = 'holdings-t1'; },
    p => { p.nextCase.origin = 'http://127.0.0.1:3100'; },
    p => { p.nextCase.origin = 'https://other.example'; },
    p => { p.nextCaseDelivery.checkpointDigest = sha256('other prepared request'); },
    p => { p.nextCaseDelivery.predecessorCompletionDigest = sha256('other predecessor'); },
    p => { p.nextCaseDelivery.taskId = id(8); },
    p => { p.nextCaseDelivery.packageId = id(8); },
    p => { p.nextCaseDelivery.verificationId = id(8); },
    p => { p.publicationApproval.reviewDigest = sha256('stale version'); },
    p => { p.target.packageDigest = sha256('different frozen package'); },
    p => { p.publicationApproval.approvalDigest = sha256('different current approval'); },
    p => { p.applicationInspection.applicationSource = 'e'.repeat(40); },
  ]) {
    const plan = fixture('publication');
    alter(plan);
    assert.equal(nextCloudDeliveryApplicationBinding(plan, 'publication'), undefined);
  }
});

test('no predecessor approval or other phase approval can authorize a new operation', () => {
  const plan = fixture('publication', { ordinal: 3 });
  assert.ok(nextCloudDeliveryApplicationBinding(plan, 'publication'));
  for (const prior of plan.nextCase.previousCase.approvalDigests) {
    const stale = structuredClone(plan);
    stale.nextCaseDelivery.approvalDigest = stale.publicationApproval.approvalDigest = prior;
    assert.equal(nextCloudDeliveryApplicationBinding(stale, 'publication'), undefined);
  }
  for (const selectOldApproval of [
    p => p.nextCase.previousCase.approvalDigest,
    p => p.nextCaseDelivery.developmentApprovalDigest,
    p => p.nextCaseDelivery.publicationApprovalDigest,
  ]) {
    const stale = fixture('consumption');
    stale.nextCaseDelivery.approvalDigest = stale.approvalDigest = selectOldApproval(stale);
    assert.equal(nextCloudDeliveryApplicationBinding(stale, 'consumption'), undefined);
  }
});

test('consumption rejects a different release, unordered batches, missing monitoring and the wrong reviewer reference', () => {
  for (const alter of [
    p => { p.nextCaseDelivery.releaseId = id(8); },
    p => { p.releaseBinding.batchIds.reverse(); },
    p => { p.nextCaseDelivery.batchIds[1] = p.nextCaseDelivery.batchIds[0]; },
    p => { p.releaseBinding.closureStatus = 'RESTORE_REQUESTED'; },
    p => { p.releaseBinding.monitoringStatus = 'PENDING'; },
    p => { p.releaseBinding.reviewDigest = sha256('different review'); },
    p => { delete p.releaseBinding.publicationApprovalDigest; },
    p => { p.releaseBinding.publicationApprovalDigest = sha256('different publication approval'); },
    p => { p.approvalDigest = sha256('stale consume approval'); },
    p => { p.nextCaseDelivery.extraScope = 'unapproved'; },
  ]) {
    const plan = fixture('consumption');
    alter(plan);
    assert.equal(nextCloudDeliveryApplicationBinding(plan, 'consumption'), undefined);
  }
});
