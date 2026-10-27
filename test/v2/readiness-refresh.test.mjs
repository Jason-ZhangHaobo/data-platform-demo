import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueuedSparkJob, createQueuedSparkResult, queueConfigFromEnvironment } from '../../src/v2/remote-spark-queue.mjs';
import { privateSparkSmokePayload } from '../../src/v2/spark-worker-private-smoke.mjs';
import { functionDigest, sealReadinessProof, openReadinessProof, validateReadinessProof, refreshReadiness, inspectReadiness } from '../../scripts/refresh-v2-spark-readiness.mjs';

const now = Date.parse('2026-10-27T01:00:00Z');
function fixture() {
  const control = { functionName: 'dataplatform-v2-demo-api', runtime: 'custom.debian12', codeChecksum: '123', codeSize: 100, cpu: 0.25, memorySize: 512, instanceConcurrency: 8, state: 'Active', lastUpdateStatus: 'Successful', environmentVariables: {
    V2_SPARK_EXECUTOR_TRANSPORT: 'OSS_QUEUE', V2_SPARK_EXECUTOR_SECRET: 'fictional-shared-secret-for-tests-only', V2_SPARK_QUEUE_READY_JOB_ID: '00000000-0000-4000-8000-000000000001', V2_FC_PUBLIC_HTTP_ENABLED: 'true', V2_FC_PUBLIC_READ_ONLY: 'true', V2_LOCAL_DEVELOPMENT: 'false', V2_PROVISIONING_ONLY: 'true', OTHER_SECRET: 'keep-me',
  } };
  const config = queueConfigFromEnvironment(control.environmentVariables);
  const queued = createQueuedSparkJob(privateSparkSmokePayload({}), config, { now: now - 60000, requestId: '00000000-0000-4000-8000-000000000002' });
  const result = { status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true, validation: { passed: true }, rows: privateSparkSmokePayload({}).context.expected };
  const envelope = createQueuedSparkResult(queued.job, result, config, now - 10000);
  const proof = { scope: 'shuduo-spark-ready-refresh/v1', issuedAt: now, expiresAt: now + 600000, boundaryDigest: functionDigest(control), oldReadyJobId: config.readyJobId, job: queued.job, envelope };
  return { control, config, proof };
}
const runtime = { publicReady: false, readOnlyObserved: true, spark: { available: true, healthVerified: true, publicWriteEnabled: true, verifiedAt: new Date(now - 10000).toISOString() } };

test('proof transport authenticates encrypted private evidence and rejects tampering', () => {
  const { control, proof } = fixture(), secret = control.environmentVariables.V2_SPARK_EXECUTOR_SECRET;
  const sealed = sealReadinessProof(proof, secret);
  assert.deepEqual(openReadinessProof(sealed, secret), proof);
  assert.throws(() => openReadinessProof(sealed, secret + 'wrong'), /AUTHENTICATION/);
  assert.equal(sealed.includes(proof.job.jobId), false);
});
test('fresh fixed synthetic evidence requires signature and independent values', () => {
  const { control, config, proof } = fixture();
  assert.equal(validateReadinessProof(proof, control, now).independentAssertions, 6);
  proof.envelope.result.rows[0].total_assets = '200.00';
  assert.throws(() => validateReadinessProof(proof, control, now), /签名/);
  proof.envelope = createQueuedSparkResult(proof.job, proof.envelope.result, config, now - 10000);
  assert.throws(() => validateReadinessProof(proof, control, now), /INDEPENDENT_VALUE/);
});
test('stale evidence and altered configuration or non-fixed SQL never update', () => {
  let f = fixture(); f.proof.envelope.completedAt = new Date(now - 3600000).toISOString();
  assert.throws(() => validateReadinessProof(f.proof, f.control, now), /FRESH_COMPLETION/);
  f = fixture(); f.control.instanceConcurrency = 1;
  assert.throws(() => validateReadinessProof(f.proof, f.control, now), /CONTROL_CHANGED/);
  f = fixture(); f.proof.expiresAt = now;
  assert.throws(() => validateReadinessProof(f.proof, f.control, now), /WINDOW/);
  f = fixture(); f.proof.job = createQueuedSparkJob({ ...privateSparkSmokePayload({}), sql: 'select 1' }, f.config, { now: now - 60000, requestId: f.proof.job.jobId }).job;
  assert.throws(() => validateReadinessProof(f.proof, f.control, now), /FIXED_SMOKE/);
});
test('pointer-only update preserves all other settings and reconciles an unknown PUT', async () => {
  for (const unknown of [false, true]) {
    const { control, proof } = fixture(); let state = structuredClone(control), writes = 0;
    const result = await refreshReadiness({ control, proof, now: () => now, wait: async () => {}, verifyRuntime: async () => runtime, api: async (method, path, body) => {
      assert.equal(path, '/2023-03-30/functions/dataplatform-v2-demo-api');
      if (method === 'PUT') { writes++; assert.deepEqual(Object.keys(body), ['environmentVariables']); state.environmentVariables = body.environmentVariables; if (unknown) throw Error('lost-response'); }
      return structuredClone(state);
    } });
    assert.equal(writes, 1); assert.equal(result.runtimeVerified, true); assert.equal(result.responseUnknown, unknown);
    assert.equal(state.environmentVariables.OTHER_SECRET, 'keep-me'); assert.equal(state.instanceConcurrency, 8);
    assert.equal(state.environmentVariables.V2_FC_PUBLIC_READ_ONLY, 'true');
  }
});
test('failed or unknown write is not repeated, and runtime failure is not passed', async () => {
  const { control, proof } = fixture(); let writes = 0;
  await assert.rejects(refreshReadiness({ control, proof, now: () => now, verifyRuntime: async () => runtime, api: async method => { if (method === 'PUT') { writes++; throw Error('unknown'); } return structuredClone(control); } }), /POINTER_UPDATE_UNCONFIRMED/);
  assert.equal(writes, 1);
  let state = structuredClone(control);
  const r = await refreshReadiness({ control, proof, now: () => now, wait: async () => {}, verifyRuntime: async () => ({ ...runtime, spark: { ...runtime.spark, available: false } }), api: async (method, path, body) => { if (body) state.environmentVariables = body.environmentVariables; return structuredClone(state); } });
  assert.equal(r.runtimeVerified, false); assert.equal(r.phase, 'RUNTIME_NOT_READY');
});
test('read-only preflight checks exact Worker and quota without mutation', async () => {
  const { control } = fixture();
  const worker = { functionName: 'dataplatform-v2-demo-worker', cpu: 1, memorySize: 2048, timeout: 180, instanceConcurrency: 1, internetAccess: false, environmentVariables: { V2_SPARK_WORKER_RUN_TIMEOUT_MS: '120000', V2_SPARK_WORKER_SECRET: control.environmentVariables.V2_SPARK_EXECUTOR_SECRET } };
  const api = async (method, path) => { assert.equal(method, 'GET'); return path.endsWith('/concurrency') ? { reservedConcurrency: 1 } : path.endsWith('/scaling-config') ? { minInstances: 0 } : path.endsWith('worker') ? worker : control; };
  await inspectReadiness({ api, controlName: control.functionName, workerName: worker.functionName });
  worker.memorySize = 4096;
  await assert.rejects(inspectReadiness({ api, controlName: control.functionName, workerName: worker.functionName }), /WORKER_BOUNDARY/);
});
