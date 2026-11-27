import test from "node:test";
import assert from "node:assert/strict";
import {loopbackKafkaBootstrap, liveWindowObservation} from "../../src/v2/live-kafka-window-session.mjs";

const sqlDigest="a".repeat(64);
const sample=(windowRows=[],extra={})=>({
  protocol:"shuduo-live-window-stream/v1",state:"RUNNING",flinkJobId:"b".repeat(32),sqlDigest,
  sourcePartitions:2,committedWindowCount:windowRows.length,windowRows,...extra,
});
const row=(second,security,volume)=>({window_start_utc:`2026-09-14 09:30:${second}`,
  security_code:`SEC-DEMO-00${security}`,event_count:1,total_volume:volume});

test("continuous Kafka bootstrap accepts bounded numeric loopback addresses only",()=>{
  assert.equal(loopbackKafkaBootstrap("127.0.0.1:9092,127.0.0.1:9093"),"127.0.0.1:9092,127.0.0.1:9093");
  for(const invalid of ["localhost:9092","10.0.0.1:9092","127.0.0.1:65536","127.0.0.1:0",
    "127.0.0.1:9092,127.0.0.1:9092","127.0.0.1:9092;command"]) assert.equal(loopbackKafkaBootstrap(invalid),undefined);
});

test("a live progress frame keeps the same job and previously committed rows through stop",()=>{
  const started=liveWindowObservation(sample(),sqlDigest);
  const rows=[row("00",1,10),row("10",2,25)];
  const running=liveWindowObservation(sample(rows),sqlDigest,started);
  const stopped=liveWindowObservation(sample(rows,{state:"STOPPED",savepointDigest:"c".repeat(64)}),sqlDigest,running);
  assert.equal(stopped.flinkJobId,started.flinkJobId);
  assert.equal(stopped.committedWindowCount,2);
  for(const unsafe of [
    sample(rows,{flinkJobId:"d".repeat(32)}),sample([rows[0]]),sample([row("00",1,11),rows[1]]),
    sample([rows[0],rows[0]]),sample(rows,{state:"STOPPED"}),sample(rows,{sqlDigest:"d".repeat(64)}),
  ]) assert.throws(()=>liveWindowObservation(unsafe,sqlDigest,running),/LIVE_WINDOW_EVIDENCE_MISMATCH/);
  assert.throws(()=>liveWindowObservation(sample(),sqlDigest,stopped),/LIVE_WINDOW_EVIDENCE_MISMATCH/);
});
