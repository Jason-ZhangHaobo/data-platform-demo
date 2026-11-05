import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, statSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { runConsumerBinding } from "../../scripts/verify-service-consumer.mjs";
import { consumerCanonical, consumerDigest, consumerV2PlanEvidence } from "../../src/v2/consumer-source.mjs";

// Synthetic protected files and child processes only. No HTTP server or cloud
// exists; the child preload fails immediately on any network/write/token access.
const hash=value=>consumerDigest(consumerCanonical(value));
const script=resolve("scripts/verify-service-consumer.mjs");
const sentinel="SYNTHETIC_SECRET_MUST_NEVER_BE_READ_OR_ECHOED";
const writeJson=(path,value)=>writeFileSync(path,JSON.stringify(value)+"\n",{mode:0o600});
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),"shuduo-consumer-binding-cli-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const files={planFile:join(root,"plan.json"),sourceFile:join(root,"source.json"),evidenceFile:join(root,"evidence.json")},reportFile=join(root,"report.json"),tokenFile=join(root,"forbidden-token");
  const source={schema:"shuduo-service-consumer-source/v1",scope:"LOCAL_TEST_ONLY",sourceKind:"AGENT",taskId:"synthetic-task",revisionId:"synthetic-revision",
    revisionHash:consumerDigest("synthetic SQL"),developmentRunId:"synthetic-development",contextId:"holdings-t1",validationContractId:"securities-five-fixtures-v1",
    packageDigest:consumerDigest("synthetic package"),releaseId:"synthetic-release",sourceReleaseRunId:"synthetic-published-batch"};
  const time=n=>new Date(Date.UTC(2026,10,5,0,0,0,n)).toISOString();
  const plan={protocol:"SERVICE_CONSUMER_V2",authorized:true,origin:"http://127.0.0.1:9",approvedOrigin:"http://127.0.0.1:9",testOnly:true,
    startedAt:time(0),deadline:time(120000),timeoutMs:1000,maxRequests:12,reportFile,source,
    expectedRows:[{client_id:"DEMO-101",holding_market_value:"100.00",available_cash:"20.00",total_assets:"120.00",security_count:1},
      {client_id:"DEMO-102",holding_market_value:"200.00",available_cash:"30.00",total_assets:"230.00",security_count:2}],
    dapis:[{id:"holdings-service",slug:"holdings",versionId:"holdings-version",configHash:consumerDigest("holdings"),alias:"holdings",fields:["client_id","holding_market_value","security_count"],granted:true},
      {id:"cash-service",slug:"cash",versionId:"cash-version",configHash:consumerDigest("cash"),alias:"cash",fields:["client_id","available_cash","total_assets"],granted:false}],
    xapi:{id:"overview-service",slug:"overview",versionId:"overview-version",configHash:consumerDigest("overview")},ungranted:{type:"DAPI",slug:"cash"},rateLimit:{serviceId:"holdings-service",perMinute:3}};
  const metadata=consumerV2PlanEvidence(plan),report={...metadata,protocol:plan.protocol,planDigest:hash(plan),credentialDigest:consumerDigest(sentinel),
    maxRequests:plan.maxRequests,startedAt:plan.startedAt,deadline:plan.deadline,evidence:"LOCAL_HTTP_FIXTURE",requestCount:0,phases:{consume:"PASSED",revoked:"PASSED"},requests:[]};
  const append=(service,query,expectedStatus,check,phase="consume")=>{
    const sequence=report.requests.length+1,callId=`synthetic-cli-call-${sequence}`;
    const entry={sequence,phase,check,startedAt:time(sequence*1000),finishedAt:time(sequence*1000+100),result:"PASSED",serviceId:service.id,type:service.type,
      versionId:service.versionId,configHash:service.configHash,expectedStatus,queryDigest:hash(query),statusCode:expectedStatus};
    if(expectedStatus===200){
      const all=plan.expectedRows.filter(row=>!query.client_id||row.client_id===query.client_id),page=all.slice(query.page-1,query.page);
      const data=page.map(row=>service.type==="DAPI"?Object.fromEntries(service.fields.map(field=>[field,row[field]])):{client_id:row.client_id,
        holdings:{holding_market_value:row.holding_market_value,security_count:row.security_count},cash:{available_cash:row.available_cash,total_assets:row.total_assets}});
      Object.assign(entry,{rowsDigest:hash(data),rowCount:data.length,responseDigest:hash({data,pagination:{page:query.page,pageSize:1,total:all.length,totalPages:Math.max(1,all.length)}}),
        callIdDigest:consumerDigest(callId),versionBindingsVerified:true,childBindingsVerified:service.type==="XAPI"});
      if(service.type==="XAPI")entry.childBindingsDigest=hash(plan.dapis.map(child=>({alias:child.alias,dapiId:child.id,dapiVersionId:child.versionId})));
    }
    report.requests.push(entry);return {entry,callId};
  };
  const targets=[{...plan.dapis[0],type:"DAPI"},{...plan.xapi,type:"XAPI"}],query={page:1,page_size:1};let selected;
  targets.forEach((service,index)=>{append(service,query,200,`SERVICE_${index+1}_PAGE_1`);append(service,{...query,page:2},200,`SERVICE_${index+1}_PAGE_2`);
    const result=append(service,{...query,client_id:"DEMO-101"},200,`SERVICE_${index+1}_FILTER`);if(service.type==="XAPI")selected=result;});
  append(targets[0],query,401,"MISSING_TOKEN");append(targets[0],query,401,"INVALID_TOKEN");append(metadata.ungrantedService,query,403,"UNGRANTED_SERVICE");
  append(targets[0],{...query,page:0},400,"INVALID_PARAMETERS");append(targets[0],query,429,"RATE_LIMIT_REJECTED");append(targets[0],query,401,"REVOKED_TOKEN","revoked");
  report.requestCount=report.requests.length;report.finishedAt=report.requests.at(-1).finishedAt;
  const evidence={protocol:"shuduo-local-task-consumption/v1",taskId:source.taskId,packageDigest:source.packageDigest,releaseId:source.releaseId,sourceKind:"AGENT",scope:source.scope,
    status:"VERIFIED",checkedAt:time(20000),services:[{serviceId:plan.xapi.id,serviceType:"XAPI",versionId:plan.xapi.versionId,configHash:plan.xapi.configHash,status:"VERIFIED",
      source,sourceKind:"AGENT",agentIndependentE2E:false,releaseId:source.releaseId,sourceRunIds:[source.sourceReleaseRunId],fullAssetComposition:true,
      sourceVersions:plan.dapis.map(service=>({serviceId:service.id,versionId:service.versionId,configHash:service.configHash,fields:service.fields,releaseId:source.releaseId,
        sourceReleaseRunId:source.sourceReleaseRunId,packageDigest:source.packageDigest,sourceKind:"AGENT"})),
      call:{callId:selected.callId,versionId:plan.xapi.versionId,configHash:plan.xapi.configHash,rowCount:selected.entry.rowCount,resultHash:selected.entry.rowsDigest,verified:true,
        applicationId:"synthetic-cli-app",applicationStatus:"REVOKED",finishedAt:selected.entry.finishedAt}}],
    matchingCount:1,truncated:false,publicDeployed:false,externalSystemVerified:false,agentIndependentE2E:false};
  writeJson(files.planFile,plan);writeJson(files.sourceFile,source);writeJson(files.evidenceFile,evidence);writeJson(reportFile,report);writeFileSync(tokenFile,sentinel,{mode:0o600});
  const guardFile=join(root,"no-io-guard.mjs");
  writeFileSync(guardFile,`import fs from 'node:fs';import http from 'node:http';import https from 'node:https';import {syncBuiltinESMExports} from 'node:module';
const deny=()=>{process.stderr.write('UNEXPECTED_NETWORK_WRITE_OR_TOKEN_ACCESS\\n');throw Error('GUARDED_IO');};
http.request=deny;https.request=deny;globalThis.fetch=deny;
const open=fs.openSync;fs.openSync=(path,flags,...args)=>{if(path===${JSON.stringify(tokenFile)}||typeof flags==='string'&&/[wa+]/.test(flags)||typeof flags==='number'&&(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_APPEND|fs.constants.O_TRUNC)))return deny();return open(path,flags,...args);};
for(const name of ['writeFileSync','renameSync','unlinkSync','mkdirSync'])fs[name]=deny;syncBuiltinESMExports();\n`,{mode:0o600});
  const args=["--plan",files.planFile,"--expected-source",files.sourceFile,"--bind-evidence",files.evidenceFile];
  const cli=(tail=args)=>spawnSync(process.execPath,["--import",guardFile,script,...tail],{encoding:"utf8",timeout:10000,maxBuffer:1024*1024});
  const snapshot=()=>Object.fromEntries(readdirSync(root).sort().map(name=>{const path=join(root,name);return [name,{bytes:readFileSync(path,"utf8"),mtime:statSync(path).mtimeMs,mode:statSync(path).mode&0o777}];}));
  return {root,files,plan,source,evidence,report,reportFile,tokenFile,args,cli,snapshot};
}

test("actual read-only binding CLI emits only consistency decision without token, network, locks, writes or file changes",t=>{
  const f=fixture(t),before=f.snapshot(),result=f.cli();
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,"");const decision=JSON.parse(result.stdout);
  assert.equal(decision.status,"MATCHED_ONLY");assert.equal(decision.eligibleForExternalAcceptance,false);
  assert.equal(decision.externalSystemVerified,false);assert.equal(decision.agentIndependentE2E,false);assert.equal(decision.publicDeployed,false);
  assert.equal(decision.verificationScope,"REPORT_AND_PLATFORM_RECEIPT_CONSISTENCY");assert.equal(decision.matchedRequestSequence,6);
  for(const value of [sentinel,"DEMO-101","100.00",f.report.credentialDigest,f.evidence.services[0].call.callId,f.tokenFile,f.plan.reportFile])assert.equal(result.stdout.includes(value),false);
  assert.deepEqual(f.snapshot(),before);assert.deepEqual(runConsumerBinding(f.files),decision);
});

test("binding CLI rejects every mixed execution/token/phase mode before reading files",t=>{
  const f=fixture(t),before=f.snapshot();
  for(const tail of [["--execute"],["--token-file",f.tokenFile],["--phase","consume"],["--phase","revoked"]]){
    const args=["--plan","/does-not-exist/plan.json","--expected-source","/does-not-exist/source.json","--bind-evidence","/does-not-exist/evidence.json",...tail];
    const result=f.cli(args);assert.equal(result.status,1);assert.deepEqual(JSON.parse(result.stderr),{result:"FAILED",code:"BINDING_MODE_CONFLICT"});assert.equal(result.stdout,"");
  }
  assert.throws(()=>runConsumerBinding({...f.files,tokenFile:f.tokenFile}),{code:"INVALID_BINDING_ARGUMENTS"});
  for(const args of [["--plan",f.files.planFile,"--expected-source",f.files.sourceFile],["--plan",f.files.planFile,"--bind-evidence",f.files.evidenceFile]])
    assert.equal(JSON.parse(f.cli(args).stderr).code,"BINDING_MODE_CONFLICT");
  assert.deepEqual(f.snapshot(),before);
});

test("legacy reports return INELIGIBLE without migration, even after the old execution window expires",t=>{
  const f=fixture(t);f.plan.protocol="SERVICE_CONSUMER_V1";f.report.protocol="SERVICE_CONSUMER_V1";
  writeJson(f.files.planFile,f.plan);writeJson(f.reportFile,f.report);const before=f.snapshot(),result=f.cli();
  assert.equal(result.status,0,result.stderr);const decision=JSON.parse(result.stdout);assert.equal(decision.status,"INELIGIBLE");assert.equal(decision.reason,"V2_REPORT_REQUIRED");
  assert.equal(decision.externalSystemVerified,false);assert.deepEqual(f.snapshot(),before);
});

test("binding inputs retain protected-file and malformed-JSON gates without dumping private content",t=>{
  const f=fixture(t);
  for(const path of [f.files.planFile,f.files.sourceFile,f.files.evidenceFile,f.reportFile]){
    const bytes=readFileSync(path,"utf8");chmodSync(path,0o644);const weak=f.cli();assert.equal(weak.status,1);assert.equal(JSON.parse(weak.stderr).code,"PRIVATE_FILE_REQUIRED");chmodSync(path,0o600);
    writeFileSync(path,'{"raw":"'+sentinel+'" invalid-json',{mode:0o600});const malformed=f.cli();
    assert.equal(malformed.status,1);assert.equal(JSON.parse(malformed.stderr).code,"INVALID_PRIVATE_JSON");assert.equal(malformed.stderr.includes(sentinel),false);assert.equal(malformed.stdout,"");
    writeFileSync(path,bytes,{mode:0o600});
  }
  const link=join(f.root,"linked-source.json");symlinkSync(f.files.sourceFile,link);
  const rejected=f.cli(["--plan",f.files.planFile,"--expected-source",link,"--bind-evidence",f.files.evidenceFile]);
  assert.equal(rejected.status,1);assert.equal(JSON.parse(rejected.stderr).code,"LOCAL_IO_FAILED");assert.equal(rejected.stderr.includes(link),false);
});

test("unknown source/report fields yield only a fixed mismatch decision, with all external flags false",t=>{
  const f=fixture(t);f.evidence.services[0].rawResponse=sentinel;writeJson(f.files.evidenceFile,f.evidence);const before=f.snapshot(),result=f.cli();
  assert.equal(result.status,0,result.stderr);const decision=JSON.parse(result.stdout);assert.equal(decision.status,"UNMATCHED");
  assert.equal(decision.eligibleForExternalAcceptance,false);assert.equal(decision.externalSystemVerified,false);assert.equal(result.stdout.includes(sentinel),false);assert.deepEqual(f.snapshot(),before);
});
