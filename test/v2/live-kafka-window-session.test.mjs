import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {liveWindowRestoreArtifacts,liveWindowWorkDirectory,loopbackKafkaBootstrap,liveWindowObservation} from "../../src/v2/live-kafka-window-session.mjs";

const sqlDigest="a".repeat(64);
const planDigest="e".repeat(64);
const sample=(windowRows=[],extra={})=>({
  protocol:"shuduo-live-window-stream/v1",state:"RUNNING",flinkJobId:"b".repeat(32),sqlDigest,planDigest,
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
    sample(rows,{planDigest:"d".repeat(64)}),sample(rows,{restoredSavepointDigest:"d".repeat(64)}),
  ]) assert.throws(()=>liveWindowObservation(unsafe,sqlDigest,running),/LIVE_WINDOW_EVIDENCE_MISMATCH/);
  assert.throws(()=>liveWindowObservation(sample(),sqlDigest,stopped),/LIVE_WINDOW_EVIDENCE_MISMATCH/);
});

test("resume binds the original stopped run, plan and savepoint metadata without following substitutions",t=>{
  const root=mkdtempSync(join(tmpdir(),"shuduo-live-restore-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const id="00000000-0000-4000-8000-000000000001";
  const base=join(liveWindowWorkDirectory(root,id),"session","run");
  const folder=join(base,"savepoints","savepoint-local");
  mkdirSync(folder,{recursive:true,mode:0o700});
  const plan=join(base,"live-plan.json"),metadata=join(folder,"_metadata");
  const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
  writeFileSync(plan,"fixture original plan",{mode:0o600});
  writeFileSync(metadata,"fixture original metadata",{mode:0o600});
  const evidence=sample([],{state:"STOPPED",planDigest:sha("fixture original plan"),savepointDigest:sha("fixture original metadata")});
  assert.equal(liveWindowRestoreArtifacts(root,id,evidence).savepointDigest,evidence.savepointDigest);
  assert.throws(()=>liveWindowRestoreArtifacts(root,"../wrong",evidence),/LIVE_WINDOW_RESTORE_UNVERIFIED/);
  assert.throws(()=>liveWindowRestoreArtifacts(root,id,{...evidence,state:"RUNNING"}),/LIVE_WINDOW_RESTORE_UNVERIFIED/);
  writeFileSync(plan,"changed plan");
  assert.throws(()=>liveWindowRestoreArtifacts(root,id,evidence),/LIVE_WINDOW_RESTORE_UNVERIFIED/);
  writeFileSync(plan,"fixture original plan");
  rmSync(metadata);
  const copied=join(root,"same-digest-metadata");
  writeFileSync(copied,"fixture original metadata",{mode:0o600});
  symlinkSync(copied,metadata);
  assert.throws(()=>liveWindowRestoreArtifacts(root,id,evidence),/LIVE_WINDOW_RESTORE_UNVERIFIED/);
});
