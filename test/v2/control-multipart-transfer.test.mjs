import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildControlMultipartManifest, cleanupControlMultipart, transferControlMultipart } from '../../scripts/control-multipart-transfer.mjs';
import { controlPackageObject } from '../../scripts/render-v2-control-package-policy.mjs';

const bytes = Buffer.alloc(11 * 4 * 1024 * 1024 + 17, 0x35);
const manifest = buildControlMultipartManifest(bytes, '135');
const key = controlPackageObject(manifest.sha256), bucket = 'multipart-fixture';
const uploadId = 'original-upload-fixture';
const xml = (body, status = 200) => new Response(body, {status});
const missing = reason => xml('<Error><Code>' + reason + '</Code></Error>', 404);

function fixture(overrides = {}) {
  const calls = [];
  let session = false, exists = false, state, inFlight = 0, maxInFlight = 0;
  const parts = new Map();
  const listedTag = (number, md5) => number % 2 ? md5.toUpperCase() : md5.slice(0, 10).toUpperCase() + md5.slice(10);
  const remote = async ({op, uploadId: requested, part, body, signal}) => {
    assert.ok(signal instanceof AbortSignal);
    if (['part','parts','complete','abort'].includes(op)) assert.equal(requested, uploadId);
    switch (op) {
      case 'acl': return exists ? xml('<AccessControlList><Grant>private</Grant></AccessControlList>') : missing('NoSuchKey');
      case 'init':
        assert.equal(session, false);
        assert.equal(state.initiates, 1);
        session = true;
        return xml('<InitiateMultipartUploadResult><Bucket>' + bucket + '</Bucket><Key>' + key +
          '</Key><UploadId>' + uploadId + '</UploadId></InitiateMultipartUploadResult>');
      case 'part': {
        assert.equal(session, true);
        assert.equal(state.uploadId, uploadId);
        assert.ok(state.partAttempts[part] >= 1);
        const hash = createHash('md5').update(body).digest('hex');
        assert.equal(hash, manifest.parts[part - 1].md5);
        assert.equal(body.length, manifest.parts[part - 1].bytes);
        parts.set(part, hash);
        inFlight++;
        maxInFlight = Math.max(inFlight, maxInFlight);
        await new Promise(resolve => setImmediate(resolve));
        inFlight--;
        return new Response(null, {status: 200, headers: {ETag: '"' + hash.toUpperCase() + '"'}});
      }
      case 'parts': {
        if (!session) return missing('NoSuchUpload');
        const items = [...parts].map(([n, md5]) => '<Part><PartNumber>' + n + '</PartNumber><ETag>&quot;' +
          listedTag(n, md5) + '&quot;</ETag><Size>' + manifest.parts[n - 1].bytes + '</Size></Part>');
        return xml('<ListPartsResult><Bucket>' + bucket + '</Bucket><Key>' + key + '</Key><UploadId>' +
          uploadId + '</UploadId><IsTruncated>false</IsTruncated>' + items.join('') + '</ListPartsResult>');
      }
      case 'complete':
        assert.ok(session && !exists);
        assert.equal(state.completes, 1);
        assert.deepEqual([...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>"([0-9a-fA-F]+)"<\/ETag>/g)]
          .map(m => [Number(m[1]), m[2]]), manifest.parts.map(p => [p.number, listedTag(p.number, p.md5)]));
        session = false;
        exists = true;
        return xml('<CompleteMultipartUploadResult/>');
      case 'abort':
        assert.equal(state.aborts, 1);
        assert.ok(session);
        session = false;
        return new Response(null, {status: 204});
      case 'get':
        return exists ? new Response(bytes, {headers: {'x-oss-hash-crc64ecma': manifest.crc64}}) : missing('NoSuchKey');
      default: assert.fail('unknown: ' + op);
    }
  };
  const run = (options = {}) => transferControlMultipart({bytes, manifest, bucket, key,
    deadline: Date.now() + 1800000, versioning: 'UNVERSIONED', save: value => { state = value; },
    request: async input => {
      calls.push([input.op, input.part]);
      return (overrides[input.op] ?? ((i, original) => original(i)))(input, remote, calls);
    }, ...options});
  return {calls, run, get state() {return state;}, get session() {return session;},
    get exists() {return exists;}, get maxInFlight() {return maxInFlight;}};
}

test('reconciles a committed part and an unknown completion, returning the verified original object once', async () => {
  const f = fixture({
    part: async (input, remote) => {
      const r = await remote(input);
      if (input.part === 1) throw Error('fixture dropped response');
      return r;
    },
    complete: async (input, remote) => {await remote(input); throw Error('fixture lost completion');},
  });
  const receipt = await f.run();
  assert.equal(f.state.phase, 'VERIFIED');
  assert.deepEqual({...receipt, verifiedAt: null}, {protocol:'VERIFIED_PRIVATE_CODE_OBJECT_V1',
    sha256:manifest.sha256, bytes:bytes.length, crc64:manifest.crc64, verifiedAt:null, putAttempts:1});
  assert.equal(f.calls.filter(([op]) => op === 'part').length, 12);
  assert.equal(f.maxInFlight, 2);
  assert.equal(f.session, false);
  assert.equal(f.state.aborts, 0);
  assert.equal(f.state.sessionClosed, true);
  assert.equal(f.state.completes, 1);
  assert.equal(f.calls.filter(([op]) => op === 'get').length, 1);
});

test('retries a missing part only after listing the original session; exhausts at two and reconciles a lost abort', async () => {
  const f = fixture({
    part: (input, remote) => input.part === 1 ? xml('<Error/>', 503) : remote(input),
    abort: async (input, remote) => {await remote(input); throw Error('lost abort response');},
  });
  await assert.rejects(f.run(), {safeCode:'MULTIPART_PART_RETRY_EXHAUSTED'});
  const attempts = f.calls.map(([op, n], i) => op === 'part' && n === 1 ? i : -1).filter(i => i !== -1);
  assert.equal(attempts.length, 2);
  assert.ok(f.calls.slice(attempts[0] + 1, attempts[1]).some(([op]) => op === 'parts'));
  assert.equal(f.state.completes, 0);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.state.sessionClosed, true);
  assert.equal(f.state.phase, 'CLOSED_WITHOUT_ACCEPTANCE');
  assert.equal(f.exists, false);
});

test('absent init reply needs exact-key owner reconciliation; no blind initialize or abort', async () => {
  const f = fixture({init: async (input, remote) => {await remote(input); throw Error('init reply lost');}});
  await assert.rejects(f.run(), {safeCode:'MULTIPART_INIT_UNCONFIRMED'});
  assert.deepEqual(f.calls.map(([op]) => op), ['acl','init']);
  assert.equal(f.state.phase, 'OWNER_RECONCILIATION_REQUIRED');
  assert.equal(f.state.uploadId, undefined);
});

test('a conflicting completion is never repeated; only the original session is aborted', async () => {
  const f = fixture({complete: () => xml('<Error><Code>FileAlreadyExists</Code></Error>', 409)});
  await assert.rejects(f.run(), {safeCode:'MULTIPART_COMPLETE_REJECTED'});
  assert.equal(f.state.completes, 1);
  assert.equal(f.state.aborts, 1);
  assert.equal(f.session, false);
  assert.equal(f.state.receipt, undefined);
});

test('existing object or unverified package, bucket version or deadline never starts an upload', async () => {
  const f = fixture({acl: () => xml('<AccessControlList><Grant>private</Grant></AccessControlList>')});
  for (const options of [{versioning:'Suspended'}, {key:'some-other-object'},
    {deadline:Date.now() + 3606000}, {manifest:{...manifest, sha256:'1'.repeat(64)}}]) {
    await assert.rejects(f.run(options));
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.run(), {safeCode:'MULTIPART_OBJECT_ABSENCE_UNCONFIRMED'});
  assert.equal(f.calls.length, 1);
});

test('a merged object with wrong bytes does not produce a receipt or a second merge', async () => {
  const f = fixture({get: () => new Response(new Uint8Array(3), {headers:{'x-oss-hash-crc64ecma':manifest.crc64}})});
  await assert.rejects(f.run(), {safeCode:'MULTIPART_RESULT_MISMATCH'});
  assert.equal(f.state.receipt, undefined);
  assert.equal(f.state.completes, 1);
  assert.equal(f.state.aborts, 0);
  assert.equal(f.state.sessionClosed, true);
});

function cleanupFixture(initial, priorAbortAttempted) {
  let session = initial;
  const calls = [], states = [];
  const run = () => cleanupControlMultipart({bucket, key, uploadId, deadline:Date.now() + 180000,
    priorAbortAttempted, save: state => states.push({...state}), request: async input => {
      calls.push(input.op);
      assert.equal(input.uploadId, uploadId);
      if (input.op === 'abort') {
        assert.equal(states.at(-1).abortAttempts, 1);
        session = 'ABSENT';
        throw Error('cleanup reply lost');
      }
      assert.equal(input.op, 'parts');
      if (session === 'ABSENT') return missing('NoSuchUpload');
      if (session === 'UNKNOWN') return xml('<Error/>', 403);
      const actualKey = session === 'OTHER' ? 'other-object' : key;
      return xml('<ListPartsResult><Bucket>' + bucket + '</Bucket><Key>' + actualKey + '</Key><UploadId>' +
        uploadId + '</UploadId><IsTruncated>false</IsTruncated></ListPartsResult>');
    }});
  return {run, calls, states};
}

test('one independent cleanup reconciles prior aborts and aborts only a still-open, exact session', async () => {
  const closed = cleanupFixture('ABSENT', true);
  assert.deepEqual(await closed.run(), {uploadId, priorAbortAttempted:true, reads:1, abortAttempts:0, sessionClosed:true});
  assert.deepEqual(closed.calls, ['parts']);
  for (const prior of [true, false]) {
    const open = cleanupFixture('OPEN', prior);
    assert.deepEqual(await open.run(), {uploadId, priorAbortAttempted:prior, reads:2, abortAttempts:1, sessionClosed:true});
    assert.deepEqual(open.calls, ['parts','abort','parts']);
  }
  for (const status of ['OTHER','UNKNOWN']) {
    const unresolved = cleanupFixture(status, false);
    await assert.rejects(unresolved.run());
    assert.deepEqual(unresolved.calls, ['parts']);
    assert.equal(unresolved.states.at(-1).abortAttempts, 0);
  }
});
