import { createHash } from "node:crypto";
import { verifySchedulerTick } from "./scheduler-tick.mjs";
const fail = () => Object.assign(new Error("私有发布定时事件校验失败"), {status:401,code:"PRIVATE_RELEASE_TIMER_INVALID"});
export function privateReleaseConfig(env) {
  if (env.V2_PRIVATE_RELEASE_ENABLED !== "true") return undefined;
  const secret = env.V2_SCHEDULER_TICK_SECRET;
  const triggerNames = (env.V2_PRIVATE_RELEASE_TRIGGER_NAMES ?? "").split(",").filter(Boolean);
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || /\s/.test(secret) || triggerNames.length < 1 || triggerNames.length > 4 || new Set(triggerNames).size !== triggerNames.length || !triggerNames.every(n => /^shuduo-release-[a-z0-9-]{1,48}$/.test(n)))
    throw new Error("私有发布需要独立签名密钥及1—4个精确定时器名称");
  return {secret,triggerNames};
}
export function validatePrivateReleaseTimer(event, config, now=Date.now()) {
  if (!config || !event || !Number.isFinite(Date.parse(event.triggerTime)) || Object.keys(event).some(k=>!["triggerTime","triggerName","payload"].includes(k)) || typeof event.payload!=="string" || event.payload.length>8192 || !config.triggerNames.includes(event.triggerName)) throw fail();
  let envelope, body;
  try { envelope=JSON.parse(event.payload); body=JSON.parse(envelope.body); } catch { throw fail(); }
  if (Object.keys(envelope).some(k=>!["operation","timestamp","nonce","body","signature"].includes(k)) || envelope.operation!=="PRIVATE_RELEASE_TIMER_V1" || Object.keys(body).length!==3 || !/^[a-f0-9-]{36}$/.test(body.releaseId??"") || body.triggerName!==event.triggerName || !Number.isSafeInteger(body.expiresAt) || now>body.expiresAt || now<Number(envelope.timestamp)-1000 || body.expiresAt-Number(envelope.timestamp)>10*60000 || body.expiresAt<Number(envelope.timestamp) || Math.abs(Date.parse(event.triggerTime)-Number(envelope.timestamp))>180000 || !verifySchedulerTick({sharedSecret:config.secret,timestamp:envelope.timestamp,nonce:envelope.nonce,body:envelope.body,signature:envelope.signature,now,maxSkewMs:180000})) throw fail();
  return {releaseId:body.releaseId,requestId:createHash("sha256").update(envelope.nonce).digest("hex"),triggerName:event.triggerName,triggerTime:event.triggerTime};
}
