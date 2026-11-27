import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

const displayLimit = 24;
const failure = () => new Error("LIVE_WINDOW_EVIDENCE_MISMATCH");

export function loopbackKafkaBootstrap(value) {
  if (typeof value !== "string") return;
  const targets = value.split(",");
  if (targets.length > 6 || new Set(targets).size !== targets.length) return;
  if (targets.every(target => {
    const match = /^127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(target);
    return match && +match[1] <= 65535;
  })) return value;
}

export function liveWindowObservation(value, sqlDigest, previous) {
  const {protocol,state,flinkJobId,sourcePartitions,committedWindowCount,windowRows,savepointDigest}=value??{};
  if (protocol!=="shuduo-live-window-stream/v1" || value.sqlDigest!==sqlDigest ||
      (state!=="RUNNING" && state!=="STOPPED") || typeof flinkJobId!=="string" || !/^[0-9a-f]{32}$/.test(flinkJobId) ||
      !Number.isInteger(sourcePartitions) || sourcePartitions<1 || sourcePartitions>8 ||
      !Number.isSafeInteger(committedWindowCount) || committedWindowCount<0 ||
      !Array.isArray(windowRows) || windowRows.length!==Math.min(displayLimit,committedWindowCount) ||
      (state==="STOPPED" ? typeof savepointDigest!=="string" || !/^[0-9a-f]{64}$/.test(savepointDigest)
        : savepointDigest!==undefined))
    throw failure();
  const keys=new Set();
  for (const row of windowRows) {
    if (!row || Object.keys(row).length!==4 ||
        typeof row.window_start_utc!=="string" || !/^\d{4}-\d\d-\d\d \d\d:\d\d:[0-5]0$/.test(row.window_start_utc) ||
        !Number.isFinite(Date.parse(row.window_start_utc.replace(" ","T")+"Z")) ||
        !["SEC-DEMO-001","SEC-DEMO-002"].includes(row.security_code) ||
        !Number.isSafeInteger(row.event_count) || row.event_count<1 ||
        !Number.isSafeInteger(row.total_volume) || row.total_volume<0)
      throw failure();
    keys.add(row.window_start_utc+row.security_code);
  }
  if (keys.size!==windowRows.length || (!previous && state!=="RUNNING")) throw failure();
  if (previous) {
    if (previous.state!=="RUNNING" || previous.flinkJobId!==flinkJobId || previous.sourcePartitions!==sourcePartitions ||
        committedWindowCount<previous.committedWindowCount) throw failure();
    const overlap=Math.max(0,previous.committedWindowCount-(committedWindowCount-windowRows.length));
    if (overlap && !isDeepStrictEqual(previous.windowRows.slice(-overlap),windowRows.slice(0,overlap))) throw failure();
  }
  return {protocol,state,flinkJobId,sourcePartitions,committedWindowCount,windowRows,
    ...(state==="STOPPED" ? {savepointDigest} : {})};
}

export function runLiveWindowProcess({script,work,repo,env,signal,sqlDigest,onProgress}) {
  return new Promise((resolve,reject)=>{
    const child=spawn("/bin/bash",[script,work,"--live-windows"],{
      cwd:repo,env,detached:true,stdio:["pipe","pipe","ignore"],
    });
    let buffer="", failed, observation, header=false, stopTimer;
    const kill=()=>{
      if (child.pid) {
        try { process.kill(-child.pid,"SIGKILL"); } catch {}
      }
    };
    const fail=reason=>{
      if (failed) return;
      failed=reason;
      kill();
    };
    const requestStop=()=>{
      if (stopTimer) return;
      child.stdin.end("STOP\n");
      stopTimer=setTimeout(()=>fail(new Error("LIVE_WINDOW_STOP_UNCONFIRMED")),60_000);
    };
    const startupTimer=setTimeout(()=>fail(new Error("LIVE_WINDOW_STARTUP_TIMEOUT")),180_000);
    signal.addEventListener("abort",requestStop,{once:true});
    if (signal.aborted) requestStop();
    child.stdin.on("error",()=>{});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",chunk=>{
      if (failed) return;
      buffer+=chunk;
      try {
        let end;
        while ((end=buffer.indexOf("\n"))!==-1) {
          if (end>32768) throw failure();
          const line=buffer.slice(0,end);
          buffer=buffer.slice(end+1);
          if (!header) {
            if (!line.startsWith("Run directory: ")) throw failure();
            header=true;
            continue;
          }
          observation=liveWindowObservation(JSON.parse(line),sqlDigest,observation);
          clearTimeout(startupTimer);
          if (observation.state==="RUNNING") onProgress(observation);
        }
        if (buffer.length>32768) throw failure();
      } catch {
        fail(failure());
      }
    });
    child.once("error",()=>fail(new Error("KAFKA_FLINK_EXECUTION_FAILED")));
    child.once("close",code=>{
      clearTimeout(startupTimer);
      clearTimeout(stopTimer);
      signal.removeEventListener("abort",requestStop);
      if (failed || code!==0 || buffer.length || !signal.aborted || observation?.state!=="STOPPED")
        reject(failed ?? new Error(signal.aborted ? "LIVE_WINDOW_STOP_UNCONFIRMED" : "KAFKA_FLINK_EXECUTION_FAILED"));
      else resolve(observation);
    });
  });
}
