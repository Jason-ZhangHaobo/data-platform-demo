import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publicationPilotTimers, publicationPilotTimerNames, publicationPilotTimerOffsetsSeconds,
  publicationPilotTimerPayloadLifetimeMs, publicationPilotTimerCleanupReserveMs } from '../../scripts/publication-pilot-timers.mjs';
import { privateReleaseConfig, validatePrivateReleaseTimer } from '../../src/v2/private-release-timer.mjs';

function fixture(now = Date.parse('2026-10-27T04:05:06.123Z')) {
  const secret = 'synthetic-test-only-publication-timer-secret-123456789';
  const controlName = 'dataplatform-v2-synthetic-api';
  return { plan: { scope: 'INVITED_PUBLICATION_PILOT_V1', controlName,
    triggerNames: [...publicationPilotTimerNames], issuedAt: now - 1000, deadline: now + 3000000,
    schedulerSecret: secret }, target: { controlName },
    releaseId: '00000000-0000-4000-8000-000000000001', secret, now, deadline: now + 2400000 };
}
const configFor = input => privateReleaseConfig({ V2_PRIVATE_RELEASE_ENABLED: 'true',
  V2_SCHEDULER_TICK_SECRET: input.secret, V2_PRIVATE_RELEASE_TRIGGER_NAMES: input.plan.triggerNames.join(',') });
const eventFor = timer => ({ triggerTime: timer.triggerTime, triggerName: timer.name,
  payload: JSON.parse(timer.body.triggerConfig).payload });

test('four deterministic six-field UTC timer bodies pass the actual private timer verifier', () => {
  const input = fixture(), before = structuredClone(input), timers = publicationPilotTimers(input);
  assert.deepEqual(input, before); assert.equal(timers.length, 4);
  assert.deepEqual(publicationPilotTimerOffsetsSeconds, [60, 300, 540, 660]);
  assert.deepEqual(timers.map(item => item.name), publicationPilotTimerNames);
  const base = Math.ceil(input.now / 1000) * 1000, requestIds = new Set();
  for (const [index, item] of timers.entries()) {
    assert.deepEqual(Object.keys(item).sort(), ['body', 'name', 'triggerTime']);
    assert.deepEqual(Object.keys(item.body).sort(), ['description', 'qualifier', 'triggerConfig', 'triggerName', 'triggerType']);
    assert.equal(item.body.triggerName, item.name); assert.equal(item.body.triggerType, 'timer'); assert.equal(item.body.qualifier, 'LATEST');
    const parsed = JSON.parse(item.body.triggerConfig), at = Date.parse(item.triggerTime), date = new Date(at);
    assert.deepEqual(Object.keys(parsed).sort(), ['cronExpression', 'enable', 'payload']);
    assert.equal(parsed.enable, true); assert.equal(at - base, publicationPilotTimerOffsetsSeconds[index] * 1000);
    assert.equal(parsed.cronExpression, `${date.getUTCSeconds()} ${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`);
    assert.equal(parsed.cronExpression.split(' ').length, 6);
    const envelope = JSON.parse(parsed.payload), signedBody = JSON.parse(envelope.body);
    assert.equal(Number(envelope.timestamp), at); assert.equal(signedBody.releaseId, input.releaseId);
    assert.equal(signedBody.expiresAt - at, publicationPilotTimerPayloadLifetimeMs);
    assert.ok(signedBody.expiresAt + publicationPilotTimerCleanupReserveMs <= input.deadline);
    const verified = validatePrivateReleaseTimer(eventFor(item), configFor(input), at);
    assert.equal(verified.releaseId, input.releaseId); assert.equal(verified.triggerName, item.name);
    requestIds.add(verified.requestId);
  }
  assert.equal(requestIds.size, 4);
  assert.deepEqual(publicationPilotTimers(input), timers);
  assert.equal(JSON.stringify(timers).includes(input.secret), false);
  assert.equal(Object.isFrozen(timers), true); assert.equal(Object.isFrozen(timers[0].body), true);
});

test('UTC day, month and year boundaries change only the documented six fields without a year or at expression', () => {
  const input = fixture(Date.parse('2026-12-31T23:58:30.000Z')), timers = publicationPilotTimers(input);
  assert.equal(JSON.parse(timers[0].body.triggerConfig).cronExpression, '30 59 23 31 12 *');
  assert.equal(JSON.parse(timers[1].body.triggerConfig).cronExpression, '30 3 0 1 1 *');
  assert.equal(timers[1].triggerTime, '2027-01-01T00:03:30.000Z');
  for (const timer of timers) assert.doesNotThrow(() => validatePrivateReleaseTimer(eventFor(timer), configFor(input), Date.parse(timer.triggerTime)));
});

test('expiry, premature calls, wrong trigger name, release tampering and changed secret fail actual signature validation', () => {
  const input = fixture(), timer = publicationPilotTimers(input)[0], event = eventFor(timer), at = Date.parse(timer.triggerTime), config = configFor(input);
  assert.throws(() => validatePrivateReleaseTimer(event, config, at + publicationPilotTimerPayloadLifetimeMs + 1));
  assert.throws(() => validatePrivateReleaseTimer(event, config, at - 1001));
  assert.throws(() => validatePrivateReleaseTimer({ ...event, triggerName: input.plan.triggerNames[1] }, config, at));
  const envelope = JSON.parse(event.payload), body = JSON.parse(envelope.body);
  const altered = { ...event, payload: JSON.stringify({ ...envelope, body: JSON.stringify({ ...body,
    releaseId: '00000000-0000-4000-8000-000000000002' }) }) };
  assert.throws(() => validatePrivateReleaseTimer(altered, config, at));
  assert.throws(() => validatePrivateReleaseTimer(event, { ...config, secret: 'different-synthetic-key-123456789012345' }, at));
  // Same date/time next year still matches cron, but it can never pass this payload.
  const nextYear = new Date(at); nextYear.setUTCFullYear(nextYear.getUTCFullYear() + 1);
  assert.throws(() => validatePrivateReleaseTimer({ ...event, triggerTime: nextYear.toISOString() }, config, nextYear.getTime()));
});

test('the immutable scope rejects wrong or extra timers, targets, release IDs and custom trigger capabilities', () => {
  for (const mutate of [
    x => { x.plan.scope = 'INVITED_DEVELOPMENT_PILOT_V1'; },
    x => { x.plan.triggerNames.pop(); }, x => { x.plan.triggerNames.push('shuduo-release-extra'); },
    x => { x.plan.triggerNames[0] = x.plan.triggerNames[1]; }, x => { x.plan.triggerNames.reverse(); },
    x => { x.plan.triggerNames[0] = 'shuduo-release-other'; },
    x => { x.target.controlName = 'dataplatform-v2-other-api'; }, x => { x.target.controlName = '../other'; },
    x => { x.releaseId = 'invalid'; }, x => { x.releaseId = 'f'.repeat(36); },
    x => { x.plan.releaseId = '00000000-0000-4000-8000-000000000002'; },
    x => { x.secret = 'short'; }, x => { x.secret += '\n'; }, x => { x.secret = 'b'.repeat(513); },
    x => { x.plan.schedulerSecret = 'different-synthetic-key-123456789012345'; },
    x => { x.invocationRole = 'forbidden'; }, x => { x.sourceArn = 'forbidden'; },
    x => { x.target.invocationRole = 'forbidden'; }, x => { x.target.sourceArn = 'forbidden'; },
    x => { x.plan.triggerType = 'oss'; }, x => { x.plan.cronExpression = '@every 1m'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => publicationPilotTimers(input)); }
  for (const input of [undefined, null, [], {}]) assert.throws(() => publicationPilotTimers(input));
});

test('deadlines cannot renew IAM lifetime and retain five minutes after the final payload expires for cleanup', () => {
  for (const mutate of [
    x => { x.now = NaN; }, x => { x.now = String(x.now); }, x => { x.deadline = Infinity; },
    x => { x.plan.issuedAt = x.now + 1; }, x => { x.plan.deadline = x.plan.issuedAt + 3600001; },
    x => { x.deadline = x.plan.deadline + 1; }, x => { x.deadline = x.now; },
    x => { x.deadline = Math.ceil(x.now / 1000) * 1000 + 660000 + publicationPilotTimerPayloadLifetimeMs + publicationPilotTimerCleanupReserveMs - 1; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => publicationPilotTimers(input)); }
  const input = fixture();
  input.deadline = Math.ceil(input.now / 1000) * 1000 + 660000 + publicationPilotTimerPayloadLifetimeMs + publicationPilotTimerCleanupReserveMs;
  assert.equal(publicationPilotTimers(input).length, 4);
});

test('builder is pure and cannot print, create, retry or delete timers', () => {
  const source = readFileSync(new URL('../../scripts/publication-pilot-timers.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:fetch|execFileSync|writeFileSync|readFileSync|setTimeout|setInterval)\s*\(/);
  assert.doesNotMatch(source, /console\.|process\.env|randomUUID|randomBytes/);
  const input = fixture(), first = publicationPilotTimers(input), restored = JSON.parse(JSON.stringify(input));
  assert.deepEqual(publicationPilotTimers(restored), first);
  assert.deepEqual(first.map(item => JSON.parse(JSON.parse(item.body.triggerConfig).payload).nonce),
    publicationPilotTimers(restored).map(item => JSON.parse(JSON.parse(item.body.triggerConfig).payload).nonce));
});
