import { createHash } from 'node:crypto';
import { boundedBytes } from './control-code-transport.mjs';
import { controlPackageObject } from './render-v2-control-package-policy.mjs';

const partSize = 4 * 1024 * 1024;
const partCount = 12;
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const fail = code => Object.assign(new Error(code), {safeCode: code});
const check = (condition, code) => { if (!condition) throw fail(code); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,160}$/.test(value);

export function buildControlMultipartManifest(bytes, crc64) {
  check(Buffer.isBuffer(bytes) && Math.ceil(bytes.length / partSize) === partCount &&
    typeof crc64 === 'string' && /^\d{1,20}$/.test(crc64) && BigInt(crc64) <= 0xffffffffffffffffn,
    'INVALID_MULTIPART_PACKAGE');
  const parts = [];
  for (let start = 0; start < bytes.length; start += partSize) {
    const part = bytes.subarray(start, start + partSize);
    parts.push({number: parts.length + 1, bytes: part.length, sha256: digest('sha256', part), md5: digest('md5', part)});
  }
  return {sha256: digest('sha256', bytes), bytes: bytes.length, crc64, chunkBytes: partSize, parts};
}

function xmlField(xml, name) {
  const matches = [...xml.matchAll(new RegExp('<' + name + '>([^<>]*)</' + name + '>', 'g'))];
  return matches.length === 1 ? matches[0][1] : undefined;
}

function checkedEtag(value, md5) {
  const tag = value?.replaceAll('&quot;', '"').replace(/^"([a-fA-F0-9]{32})"$/, '$1');
  return tag?.toLowerCase() === md5 ? tag : undefined;
}

async function xmlBody(response) {
  return (await boundedBytes(response, 65536)).toString('utf8');
}

async function absent(response, reason) {
  if (response.status !== 404) return false;
  const reader = response.body?.getReader();
  if (!reader) return false;
  const chunks = [];
  let size = 0;
  try {
    while (size < 8192) {
      const {done, value} = await reader.read();
      if (done) return xmlField(Buffer.concat(chunks).toString('utf8'), 'Code') === reason;
      size += value.byteLength;
      if (size <= 8192) chunks.push(Buffer.from(value));
    }
    return false;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function discard(response) {
  await response?.body?.cancel().catch(() => {});
}

async function exactSessionXml(response, bucket, key, uploadId) {
  if (await absent(response, 'NoSuchUpload')) return null;
  const xml = await xmlBody(response);
  check(xmlField(xml, 'Bucket') === bucket && xmlField(xml, 'Key') === key &&
    xmlField(xml, 'UploadId') === uploadId && xmlField(xml, 'IsTruncated') === 'false', 'MULTIPART_LIST_UNCONFIRMED');
  return xml;
}

// The owner supplies an ID from the sealed receipt or its exact-key recovery.
// A terminal predecessor may have lost its abort reply. Only a fresh,
// positively identified open session permits one cleanup attempt in this run.
export async function cleanupControlMultipart({bucket, key, uploadId, priorAbortAttempted, deadline,
  request, save, now = Date.now}) {
  const sha = key?.match(/([a-f0-9]{64})\.zip$/)?.[1];
  check(sha && key === controlPackageObject(sha) && /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) &&
    validId(uploadId) && Number.isSafeInteger(deadline) && deadline > now() && deadline - now() <= 3600000 &&
    typeof request === 'function' && typeof save === 'function', 'MULTIPART_CLEANUP_SCOPE_INVALID');
  const state = {uploadId, priorAbortAttempted: priorAbortAttempted !== false, reads: 0, abortAttempts: 0, sessionClosed: false};
  function record() {
    const result = save({...state});
    check(!result?.then, 'SYNCHRONOUS_MULTIPART_CHECKPOINT_REQUIRED');
  }
  async function call(op) {
    const remaining = deadline - now();
    check(remaining > 0, 'MULTIPART_WINDOW_EXPIRED');
    if (op === 'parts') state.reads++;
    else state.abortAttempts++;
    record();
    return request({op, uploadId, signal: AbortSignal.timeout(Math.min(30000, remaining))});
  }
  const list = async () => exactSessionXml(await call('parts'), bucket, key, uploadId);
  if (await list() !== null) {
    let response;
    try {response = await call('abort');}
    catch { /* Confirm the same upload ID after an uncertain response. */ }
    await discard(response);
    check(await list() === null, 'MULTIPART_CLEANUP_UNCONFIRMED');
  }
  state.sessionClosed = true;
  record();
  return state;
}

// request is bound by the caller to the signed plan's single bucket and key.
// save must synchronously persist the private operation state, including the
// upload ID, before each remote side effect. A new dispatch cannot resume or
// start another session from an unknown initialize/complete outcome.
export async function transferControlMultipart({bytes, manifest, bucket, key, versioning, deadline,
  request, save, now = Date.now}) {
  const local = buildControlMultipartManifest(bytes, manifest?.crc64);
  check(local.sha256 === manifest.sha256 && local.bytes === manifest.bytes && local.chunkBytes === manifest.chunkBytes &&
    Array.isArray(manifest.parts) && manifest.parts.length === partCount &&
    local.parts.every((p, i) => ['number','bytes','sha256','md5'].every(k => manifest.parts[i]?.[k] === p[k])),
    'MULTIPART_MANIFEST_CHANGED');
  check(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) && key === controlPackageObject(local.sha256) &&
    versioning === 'UNVERSIONED' && Number.isSafeInteger(deadline) && deadline > now() &&
    deadline - now() <= 3600000 && typeof save === 'function' && typeof request === 'function',
    'MULTIPART_SESSION_SCOPE_INVALID');
  const state = {phase: 'READY', sha256: local.sha256, bytes: local.bytes, startedAt: now(), deadline,
    initiates: 0, completes: 0, aborts: 0, reads: 0, partAttempts: {}, partWarnings: [], etags: {}};
  let stopNewParts = false;
  function record(phase) {
    if (phase) state.phase = phase;
    const result = save(structuredClone(state));
    check(!result?.then, 'SYNCHRONOUS_MULTIPART_CHECKPOINT_REQUIRED');
  }
  async function call(op, fields = {}) {
    const available = deadline - now() - 90000;
    check(available > 0, 'MULTIPART_WINDOW_EXPIRED');
    if (['get','acl','parts'].includes(op)) state.reads++;
    record();
    const signal = AbortSignal.timeout(Math.min(op === 'get' ? 120000 : op === 'part' ? 100000 : 30000, available));
    return request({op, ...fields, signal});
  }
  async function listParts() {
    const response = await call('parts', {uploadId: state.uploadId});
    const xml = await exactSessionXml(response, bucket, key, state.uploadId);
    if (xml === null) return null;
    const known = new Map();
    for (const [, part] of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const number = Number(xmlField(part, 'PartNumber')), expected = local.parts[number - 1];
      const tag = expected && checkedEtag(xmlField(part, 'ETag'), expected.md5);
      check(tag && !known.has(number) && Number(xmlField(part, 'Size')) === expected.bytes,
        'MULTIPART_REMOTE_PART_MISMATCH');
      known.set(number, tag);
    }
    return known;
  }
  async function uploadPart(part) {
    const number = part.number;
    const start = (number - 1) * partSize;
    const body = bytes.subarray(start, start + part.bytes);
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (stopNewParts) throw fail('MULTIPART_BATCH_STOPPED');
      state.partAttempts[number] = attempt;
      let response;
      try {
        response = await call('part', {body, part: number, uploadId: state.uploadId});
      } catch (error) {
        if (error.safeCode) throw error;
      }
      await discard(response);
      if (response?.status === 200) {
        const tag = checkedEtag(response.headers.get('etag'), part.md5);
        check(tag, 'MULTIPART_RETURNED_ETAG_MISMATCH');
        state.etags[number] = tag;
        record();
        return;
      }
      state.partWarnings.push({number, attempt, httpStatus: response?.status ?? 0});
      record();
      check(!response || response.status === 408 || response.status === 429 || response.status >= 500,
        'MULTIPART_PART_REJECTED');
      const known = await listParts();
      check(known !== null, 'MULTIPART_SESSION_GONE');
      if (known.has(number)) {
        state.etags[number] = known.get(number);
        record();
        return;
      }
    }
    throw fail('MULTIPART_PART_RETRY_EXHAUSTED');
  }
  async function verifyObject() {
    const response = await call('get');
    state.objectHttpStatus = response.status;
    if (response.status !== 200 || response.headers.get('x-oss-hash-crc64ecma') !== local.crc64) {
      await discard(response);
      throw fail('MULTIPART_RESULT_UNCONFIRMED');
    }
    const observed = await boundedBytes(response, local.bytes);
    check(observed.length === local.bytes && digest('sha256', observed) === local.sha256,
      'MULTIPART_RESULT_MISMATCH');
    const acl = await call('acl');
    check(['default','private'].includes(xmlField(await xmlBody(acl), 'Grant')), 'MULTIPART_ACL_UNCONFIRMED');
  }
  async function cleanupAfterFailure() {
    if (!state.uploadId) return;
    const previousReads = state.reads;
    await cleanupControlMultipart({bucket, key, uploadId:state.uploadId, priorAbortAttempted:state.aborts !== 0,
      deadline, request, now, save: progress => {
        state.reads = previousReads + progress.reads;
        state.aborts = progress.abortAttempts;
        state.sessionClosed = progress.sessionClosed;
        record(progress.abortAttempts ? 'ABORT_REQUESTED' : 'CHECKING_SESSION');
      }});
  }
  try {
    record('CHECKING_OBJECT');
    const acl = await call('acl');
    const missing = await absent(acl, 'NoSuchKey');
    await discard(acl);
    check(missing, 'MULTIPART_OBJECT_ABSENCE_UNCONFIRMED');
    state.initiates = 1;
    record('INIT_REQUESTED');
    const init = await call('init');
    const xml = await xmlBody(init);
    const uploadId = xmlField(xml, 'UploadId');
    check(init.status === 200 && xmlField(xml, 'Bucket') === bucket && xmlField(xml, 'Key') === key &&
      validId(uploadId), 'MULTIPART_INIT_UNCONFIRMED');
    state.uploadId = uploadId;
    record('UPLOADING');
    for (let index = 0; index < partCount; index += 2) {
      const pair = await Promise.allSettled(local.parts.slice(index, index + 2).map(async part => {
        try { await uploadPart(part); }
        catch (error) { stopNewParts = true; throw error; }
      }));
      const failed = pair.find(result => result.status === 'rejected' && result.reason?.safeCode !== 'MULTIPART_BATCH_STOPPED');
      if (failed) throw failed.reason;
    }
    const known = await listParts();
    check(known?.size === partCount && local.parts.every(p =>
      known.get(p.number)?.toLowerCase() === state.etags[p.number]?.toLowerCase()),
      'MULTIPART_ALL_PARTS_UNCONFIRMED');
    // OSS expects the ETag spelling it returned. MD5 validation above is
    // case-insensitive; the completion manifest preserves the final listing.
    const body = Buffer.from('<CompleteMultipartUpload>' + local.parts.map(p =>
      '<Part><PartNumber>' + p.number + '</PartNumber><ETag>"' + known.get(p.number) + '"</ETag></Part>').join('') +
      '</CompleteMultipartUpload>');
    state.completes = 1;
    record('COMPLETE_REQUESTED');
    let response;
    try { response = await call('complete', {uploadId, body}); }
    catch (error) { if (error.safeCode) throw error; }
    state.completeHttpStatus = response?.status ?? 0;
    await discard(response);
    check(!response || response.ok || response.status === 408 || response.status >= 500,
      'MULTIPART_COMPLETE_REJECTED');
    await verifyObject();
    check(await listParts() === null, 'MULTIPART_SESSION_STILL_OPEN');
    state.sessionClosed = true;
    const receipt = {protocol: 'VERIFIED_PRIVATE_CODE_OBJECT_V1', sha256: local.sha256, bytes: local.bytes,
      crc64: local.crc64, verifiedAt: new Date(now()).toISOString(), putAttempts: 1};
    state.receipt = receipt;
    record('VERIFIED');
    return receipt;
  } catch (error) {
    state.failure = state.initiates && !state.uploadId ? 'MULTIPART_INIT_UNCONFIRMED'
      : error?.safeCode ?? 'MULTIPART_REQUEST_UNCONFIRMED';
    try { await cleanupAfterFailure(); }
    catch { state.cleanupFailure = 'MULTIPART_CLEANUP_UNCONFIRMED'; }
    record(state.initiates && !state.sessionClosed ? 'OWNER_RECONCILIATION_REQUIRED' : 'CLOSED_WITHOUT_ACCEPTANCE');
    throw fail(state.failure);
  }
}
