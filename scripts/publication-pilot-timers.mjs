// Pure FC 3.0 timer-body preparation. This module performs no IO and creates no
// resources. Save the returned signed payloads only in the encrypted report;
// on resume reuse that report rather than generate a new schedule with new now.
//
// Official FC docs checked 2026-10-27:
// https://help.aliyun.com/zh/functioncompute/time-triggers
// https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-timertriggerconfig
// https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-createtriggerinput
// FC documents six cron fields and UTC by default. Do not invent a year field
// or borrow scaling-policy at() syntax. A fixed day/month cron can recur next
// year: short-lived signed payloads deny execution then, but the caller MUST
// remove all four timers before the approved cleanup deadline.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { signSchedulerTick } from '../src/v2/scheduler-tick.mjs';
import { privateReleaseConfig, validatePrivateReleaseTimer } from '../src/v2/private-release-timer.mjs';

export const publicationPilotTimerNames = Object.freeze(Array.from({ length: 4 }, (_, index) => `shuduo-release-pilot-20261027-${index + 1}`));
export const publicationPilotTimerOffsetsSeconds = Object.freeze([60, 300, 540, 660]);
export const publicationPilotTimerPayloadLifetimeMs = 180000;
export const publicationPilotTimerCleanupReserveMs = 300000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const check = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { safeCode: code }); };
const timestamp = value => Number.isSafeInteger(value) && /^\d{13}$/.test(String(value));
const noCustomTriggerFields = value => !['triggerType', 'triggerConfig', 'sourceArn', 'invocationRole', 'qualifier', 'cronExpression', 'offsets', 'payload'].some(key => Object.hasOwn(value, key));
const utcDateCron = time => {
  const date = new Date(time);
  return `${date.getUTCSeconds()} ${date.getUTCMinutes()} ${date.getUTCHours()} ${date.getUTCDate()} ${date.getUTCMonth() + 1} *`;
};

// deadline must be the EARLIER of the valid IAM deadline and publication-window
// deadline, and cannot exceed the original plan deadline. No expiry is renewed.
export function publicationPilotTimers(input) {
  check(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['plan', 'target', 'releaseId', 'secret', 'now', 'deadline'].includes(key)), 'PUBLICATION_TIMER_INPUT_INVALID');
  const { plan, target, releaseId, secret, now, deadline } = input;
  check(plan && typeof plan === 'object' && !Array.isArray(plan) && plan.scope === 'INVITED_PUBLICATION_PILOT_V1' &&
    isDeepStrictEqual(plan.triggerNames, publicationPilotTimerNames) && noCustomTriggerFields(plan), 'PUBLICATION_TIMER_SCOPE_INVALID');
  check(target && typeof target === 'object' && !Array.isArray(target) && noCustomTriggerFields(target) &&
    typeof target.controlName === 'string' && /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(target.controlName) &&
    target.controlName === plan.controlName, 'PUBLICATION_TIMER_TARGET_INVALID');
  check(typeof releaseId === 'string' && uuid.test(releaseId) &&
    (plan.releaseId === undefined || plan.releaseId === releaseId), 'PUBLICATION_TIMER_RELEASE_INVALID');
  check(typeof secret === 'string' && secret.length >= 32 && secret.length <= 512 && !/\s/.test(secret) &&
    (plan.schedulerSecret === undefined || plan.schedulerSecret === secret), 'PUBLICATION_TIMER_SECRET_INVALID');
  check(timestamp(now) && timestamp(deadline) && timestamp(plan.issuedAt) && timestamp(plan.deadline) &&
    plan.issuedAt <= now && now < deadline && deadline <= plan.deadline &&
    plan.deadline - plan.issuedAt > 0 && plan.deadline - plan.issuedAt <= 3600000, 'PUBLICATION_TIMER_WINDOW_INVALID');
  const base = Math.ceil(now / 1000) * 1000;
  const lastExpiry = base + publicationPilotTimerOffsetsSeconds.at(-1) * 1000 + publicationPilotTimerPayloadLifetimeMs;
  check(lastExpiry + publicationPilotTimerCleanupReserveMs <= deadline, 'PUBLICATION_TIMER_CLEANUP_WINDOW_INSUFFICIENT');
  const config = privateReleaseConfig({ V2_PRIVATE_RELEASE_ENABLED: 'true', V2_SCHEDULER_TICK_SECRET: secret,
    V2_PRIVATE_RELEASE_TRIGGER_NAMES: plan.triggerNames.join(',') });
  return Object.freeze(plan.triggerNames.map((name, index) => {
    const at = base + publicationPilotTimerOffsetsSeconds[index] * 1000;
    const expiresAt = at + publicationPilotTimerPayloadLifetimeMs;
    const triggerTime = new Date(at).toISOString();
    const body = JSON.stringify({ releaseId, triggerName: name, expiresAt });
    const nonce = createHash('sha256').update(JSON.stringify({ scope: plan.scope, controlName: target.controlName,
      releaseId, triggerName: name, at, expiresAt })).digest('hex');
    const payload = JSON.stringify({ operation: 'PRIVATE_RELEASE_TIMER_V1', timestamp: String(at), nonce, body,
      signature: signSchedulerTick({ sharedSecret: secret, timestamp: String(at), nonce, body }) });
    const verified = validatePrivateReleaseTimer({ triggerName: name, triggerTime, payload }, config, at);
    check(verified.releaseId === releaseId && verified.triggerName === name, 'PUBLICATION_TIMER_SELF_CHECK_FAILED');
    return Object.freeze({ name, triggerTime, body: Object.freeze({ triggerName: name, triggerType: 'timer',
      qualifier: 'LATEST', description: `Bounded reviewed-release pilot; remove before ${new Date(deadline).toISOString()}`,
      triggerConfig: JSON.stringify({ cronExpression: utcDateCron(at), enable: true, payload }) }) });
  }));
}
