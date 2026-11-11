import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveryPackage, validateDeliveryPackage, deliveryFiles, sha256, computeManifestDigest, unpackDeliveryPackage } from '../../src/v2/delivery.mjs';
import { verifyDeliveryDirectory } from '../../src/v2/delivery-runner.mjs';
import { fundContext, fundReferenceSql } from '../../src/v2/fund-lookthrough.mjs';
import { fundDeliveryBinding } from '../../src/v2/fund-delivery.mjs';
import { deliverySourceSelection } from '../../web/src/delivery-source.ts';

function fixture() {
  const context = fundContext(), binding = fundDeliveryBinding();
  const revision = { id: 'fund-revision', projectId: 'demo', contextId: context.id, sql: fundReferenceSql,
    hash: sha256(fundReferenceSql), source: 'MANUAL', author: 'engineer',
    manualProvenance: { kind: 'ENGINEER_EDIT', actorId: 'engineer', agentIndependentE2E: false } };
  const inputEvidence = { protocol: 'shuduo-spark-execution-input/v1', scope: 'MANAGER_SCOPED_REGISTERED_TABLES',
    contextId: context.id, inputHash: binding.inputHash, schemaHash: binding.schemaHash, tableCount: 3 };
  const assertionEvidence = { protocol: 'shuduo-securities-assertion-evidence/v1', verifierRevision: 'fund-lookthrough-v1',
    contentHash: binding.assertionHash };
  const run = { id: 'fund-run', revisionId: revision.id, revisionHash: revision.hash, projectId: revision.projectId,
    contextId: context.id, validationContractId: binding.contractId, status: 'SUCCEEDED', finishedAt: '2026-09-11T01:00:00.000Z',
    engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true, rows: context.expected, inputEvidence,
    validation: { passed: true, selectedPassed: true, contractId: binding.contractId, assertionEvidence,
      regressions: [{ contextId: context.id, passed: true, inputEvidence, assertionEvidence }] } };
  return { run, revision, binding };
}

test('fund files pin the original local run, scoped input and independent result', () => {
  const { run, revision, binding } = fixture();
  const bundle = createDeliveryPackage({ run, revision });
  const plan = validateDeliveryPackage(bundle, bundle.digest);
  assert.deepEqual(Object.keys(bundle.files).sort(), [...deliveryFiles].sort());
  assert.deepEqual(plan.source.fundLookthrough, binding);
  assert.equal(plan.source.attribution.kind, 'ENGINEER_AUTHORED');
  assert.match(bundle.files['tests.sql'], /未穿透.*450\.00/);
  assert.equal(plan.deployment.adapter, 'local-spark-v1');
  assert.equal(createDeliveryPackage({ run, revision }).digest, bundle.digest);
  assert.equal(deliverySourceSelection([run]).source, run.id);
  for (const bad of [{ ...run, isolation: 'FUNCTION_PROCESS' }, { ...run, rows: run.rows.slice(1) },
    { ...run, inputEvidence: { ...run.inputEvidence, inputHash: 'a'.repeat(64) } }]) {
    assert.throws(() => createDeliveryPackage({ run: bad, revision }), /本机真实 Spark/);
  }
});

test('fund file validation rejects a rehashed wrong date or weakened assertion', () => {
  const original = createDeliveryPackage(fixture());
  for (const mutate of [
    bundle => { bundle.manifest.source.fundLookthrough.businessDate = '2026-09-09'; },
    bundle => {
      bundle.files['tests.sql'] = 'SELECT true AS passed';
      bundle.manifest.files['tests.sql'] = { sha256: sha256(bundle.files['tests.sql']), bytes: Buffer.byteLength(bundle.files['tests.sql']) };
    },
  ]) {
    const bundle = structuredClone(original);
    mutate(bundle);
    bundle.digest = computeManifestDigest(bundle.manifest);
    assert.throws(() => validateDeliveryPackage(bundle, bundle.digest), { code: 'FUND_DELIVERY_CONTRACT_MISMATCH' });
  }
});

test('a passing fund test SQL cannot override a mismatched file-run input', async t => {
  const input = fixture(), bundle = createDeliveryPackage(input);
  const root = mkdtempSync(join(tmpdir(), 'fund-delivery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = unpackDeliveryPackage(bundle, join(root, 'files'), bundle.digest);
  const receipt = await verifyDeliveryDirectory({ directory, expectedDigest: bundle.digest, scheduledFor: '2026-09-11T09:00:00+08:00' }, {
    runner: async () => ({ ...input.run, inputEvidence: { ...input.run.inputEvidence, inputHash: 'b'.repeat(64) },
      testSqlValidation: { passed: true, sqlHash: sha256(bundle.files['tests.sql']) } }),
  });
  assert.equal(receipt.status, 'FAILED');
  assert.equal(receipt.published, false);
});
