import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeBeijingCatalogue, runModelKeySync } from "../../scripts/run-v2-control-model-secret.mjs";
import { preservedModelConfigDigest } from "../../scripts/sync-v2-control-model-secret.mjs";
import { functionDigest } from "../../scripts/refresh-v2-spark-readiness.mjs";

const candidate = "sk-TEST-ONLY-synthetic-blue-key";
const previous = "sk-TEST-ONLY-synthetic-green-key";
const unrelatedSecret = "TEST-ONLY-other-runtime-value";
const sharedBase = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const workspaceBase = "https://llm-synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const model = "qwen3.7-plus";
const name = "dataplatform-v2-synthetic-api";
const account = "1234567890123456";
const role = "synthetic-deploy-role";
const rev = "f".repeat(40);
const envelope = (modelName = model) => ({ success:true, output:{models:[{model:modelName}]} });
const json = (status, body) => Response.json(body, {status});

function fixture(mode) {
  const current = {
    functionName:name, runtime:"custom.debian12", codeChecksum:"123456", codeSize:2048,
    instanceConcurrency:8, state:"Active", lastUpdateStatus:"Successful",
    environmentVariables:{
      V2_LOCAL_DEVELOPMENT:"false", V2_PROVISIONING_ONLY:"true", V2_PRIVATE_SMOKE_ENABLED:"true",
      V2_FC_PUBLIC_HTTP_ENABLED:"true", V2_FC_PUBLIC_READ_ONLY:"true", V2_PRIVATE_RELEASE_ENABLED:"false",
      V2_MYSQL_USER:"platform_app", V2_MYSQL_DATABASE:"platform_meta", V2_MYSQL_PASSWORD:unrelatedSecret,
      V2_MODEL_BASE_URL:sharedBase, V2_MODEL:model, DASHSCOPE_API_KEY:previous,
    },
  };
  const env = {
    GITHUB_ACTIONS:"true", GITHUB_EVENT_NAME:"workflow_dispatch", GITHUB_REF:"refs/heads/main",
    GITHUB_SHA:rev, GITHUB_RUN_ATTEMPT:"1", ALIBABA_CLOUD_REGION_ID:"cn-hangzhou",
    V2_FUNCTION_NAME:name, V2_DEPLOY_ROLE_ARN:`acs:ram::${account}:role/${role}`,
    V2_DEPLOY_OIDC_PROVIDER_ARN:`acs:ram::${account}:oidc-provider/synthetic-github`,
    V2_MODEL_SYNC_MODE:mode, V2_EXPECTED_SOURCE:rev,
    V2_BASELINE_DIGEST:functionDigest(current), V2_PRESERVED_DIGEST:preservedModelConfigDigest(current),
    V2_EXCLUSIVE_CHANGE_WINDOW:mode==="apply"?"true":"false", DASHSCOPE_API_KEY:candidate,
  };
  const calls = [];
  const io = {
    identity:async()=>{calls.push("STS");return {AccountId:account, Arn:`acs:ram::${account}:assumed-role/${role}/synthetic-run`};},
    api:async(method,path,body)=>{
      calls.push(method);
      assert.equal(path,"/2023-03-30/functions/"+name);
      if(method==="PUT"){
        assert.deepEqual(Object.keys(body),["environmentVariables"]);
        assert.ok(body.environmentVariables.DASHSCOPE_API_KEY===candidate);
        assert.ok(body.environmentVariables.V2_MYSQL_PASSWORD===unrelatedSecret);
        current.environmentVariables=structuredClone(body.environmentVariables);
      } else assert.equal(method,"GET");
      return structuredClone(current);
    },
    fetchImpl:async(_url,opts)=>{
      const authorized=new Headers(opts.headers).has("authorization");
      calls.push(authorized?"CATALOGUE_AUTHENTICATED":"CATALOGUE_ANONYMOUS");
      return authorized?json(200,envelope()):json(401,{code:"Unauthorized"});
    },
    readDelay:async()=>{},
  };
  return {env,io,calls,current};
}

test("off-branch, mismatched revision, rerun, and unconfirmed apply never request an identity", async()=>{
  for(const patch of [
    {GITHUB_ACTIONS:"false"}, {GITHUB_REF:"refs/heads/example"}, {GITHUB_EVENT_NAME:"push"},
    {GITHUB_RUN_ATTEMPT:"2"}, {V2_EXPECTED_SOURCE:"0".repeat(40)}, {V2_MODEL_SYNC_MODE:"deploy"},
    {V2_EXCLUSIVE_CHANGE_WINDOW:"false"}, {V2_BASELINE_DIGEST:"missing"}, {V2_PRESERVED_DIGEST:"missing"},
  ]){
    const {env,io,calls}=fixture("apply");
    await assert.rejects(runModelKeySync({...env,...patch},io));
    assert.deepEqual(calls,[]);
  }
});

test("the wrong STS role cannot read the function or probe the catalogue", async()=>{
  const {env,io,calls}=fixture("verify");
  io.identity=async()=>({AccountId:account,Arn:`acs:ram::${account}:assumed-role/other-role/synthetic-run`});
  await assert.rejects(runModelKeySync(env,io));
  assert.deepEqual(calls,[]);
});

test("apply and subsequent verification use the dedicated target and return no secret values", async()=>{
  const {env,io,calls}=fixture("apply");
  const applied=await runModelKeySync(env,io);
  assert.equal(applied.ok,true);
  assert.equal(calls.filter(c=>c==="PUT").length,1);
  calls.length=0;
  const verified=await runModelKeySync({...env,V2_MODEL_SYNC_MODE:"verify",V2_EXCLUSIVE_CHANGE_WINDOW:"false"},io);
  assert.equal(verified.ok,true);
  assert.equal(calls.includes("PUT"),false);
  const summary=JSON.stringify([applied,verified]);
  for(const value of [candidate,previous,unrelatedSecret])assert.ok(!summary.includes(value));
});

test("catalogue checks authenticate only to the same Beijing provider after an anonymous rejection", async()=>{
  for(const baseUrl of [sharedBase,workspaceBase]){
    const auth=[];
    const ok=await probeBeijingCatalogue({baseUrl,model,modelKey:candidate},async(raw,options)=>{
      const url=new URL(raw);
      assert.equal(url.origin,new URL(baseUrl).origin);
      assert.equal(url.pathname,"/api/v1/models");
      assert.equal(url.searchParams.get("model"),model);
      assert.equal(options.method??"GET","GET");
      assert.equal(options.redirect,"error");
      assert.equal(options.body,undefined);
      const bearer=new Headers(options.headers).get("authorization");
      auth.push(bearer!==null);
      if(auth.length===1){assert.equal(bearer,null);return json(403,{message:"synthetic denied"});}
      assert.ok(bearer==="Bearer "+candidate);
      return json(200,envelope());
    });
    assert.equal(ok,true);
    assert.deepEqual(auth,[false,true]);
  }
});

test("an untrusted origin, anonymous success, redirect, and an unrelated model cannot verify the key", async()=>{
  for(const baseUrl of ["https://catalogue.example.invalid/compatible-mode/v1",
    "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    sharedBase+"?other=1", sharedBase+"/../other"]){
    let calls=0;
    const ok=await probeBeijingCatalogue({baseUrl,model,modelKey:candidate},async()=>{calls++;return json(200,envelope());});
    assert.equal(ok,false);
    assert.equal(calls,0);
  }
  for(const first of [json(200,envelope()),new Response(null,{status:302,headers:{location:"https://example.invalid/location"}})]){
    let calls=0;
    const ok=await probeBeijingCatalogue({baseUrl:sharedBase,model,modelKey:candidate},async(_url,options)=>{
      calls++;assert.equal(new Headers(options.headers).has("authorization"),false);return first;
    });
    assert.equal(ok,false);assert.equal(calls,1);
  }
  const replies=[json(401,{}),json(200,envelope(model+"-other"))];
  assert.equal(await probeBeijingCatalogue({baseUrl:sharedBase,model,modelKey:candidate},async()=>replies.shift()),false);
});

test("the CLI redacts failure details and the manual workflow binds its protected environment", ()=>{
  const f=fixture("apply");
  const script=fileURLToPath(new URL("../../scripts/run-v2-control-model-secret.mjs",import.meta.url));
  const run=spawnSync(process.execPath,[script],{env:{...f.env,GITHUB_REF:"refs/heads/not-main",PATH:""},encoding:"utf8",timeout:5000});
  assert.equal(run.status,1);
  const text=run.stdout+run.stderr;
  assert.ok(!text.includes(candidate)&&!text.includes(previous)&&!text.includes(unrelatedSecret));
  assert.ok(!text.includes("Error:")&&!text.includes("    at "));
  const workflow=readFileSync(new URL("../../.github/workflows/sync-v2-control-model-secret.yml",import.meta.url),"utf8");
  assert.match(workflow,/workflow_dispatch:/);
  assert.doesNotMatch(workflow,/^\s+(?:push|pull_request|schedule):/m);
  assert.match(workflow,/default: verify/);
  assert.match(workflow,/if: github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1/);
  assert.match(workflow,/v2-staging-control-mutation/);
  assert.match(workflow,/environment: v2-staging\b/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.deepEqual([...workflow.matchAll(/\bsecrets\.(\w+)/g)].map(match=>match[1]),["DASHSCOPE_API_KEY"]);
  assert.match(workflow,/aliyun\/setup-aliyun-cli-action@[a-f0-9]{40}/);
  assert.match(workflow,/aliyun\/configure-aliyun-credentials-action@[a-f0-9]{40}/);
  assert.match(workflow,/run: node scripts\/run-v2-control-model-secret\.mjs$/m);
  const inputCheck=workflow.indexOf("run: node scripts/run-v2-control-model-secret.mjs validate-inputs");
  assert.ok(inputCheck>=0&&inputCheck<workflow.indexOf("aliyun/configure-aliyun-credentials-action@"));
});

test("a failing cloud CLI cannot copy subprocess output into Actions logs", t=>{
  const directory=mkdtempSync(join(tmpdir(),"shuduo-model-sync-child-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const fakeProgram=join(directory,"aliyun");
  const sentinel="synthetic-subprocess-output-must-stay-private";
  writeFileSync(fakeProgram,`#!/bin/sh\ntouch_marker="\${0%/*}/invoked"\n: > "$touch_marker"\nprintf '%s\\n' '${sentinel}'\nprintf '%s\\n' '${sentinel}' >&2\nexit 1\n`,{mode:0o700});
  const {env}=fixture("verify");
  const script=fileURLToPath(new URL("../../scripts/run-v2-control-model-secret.mjs",import.meta.url));
  const r=spawnSync(process.execPath,[script],{env:{...env,PATH:directory,
    ALIBABA_CLOUD_ACCESS_KEY_ID:"synthetic-identity",ALIBABA_CLOUD_ACCESS_KEY_SECRET:"synthetic-cli-secret",
    ALIBABA_CLOUD_SECURITY_TOKEN:"synthetic-cli-session"},encoding:"utf8",timeout:5000});
  assert.equal(r.status,1);
  assert.ok(existsSync(join(directory,"invoked")),"the failure must actually come from the local replacement CLI");
  assert.ok(!(r.stdout+r.stderr).includes(sentinel));
  assert.ok(!(r.stdout+r.stderr).includes(candidate));
});

test("the full runner reconciles a committed body-file PUT with a lost reply without logging or retaining its body", t=>{
  const dir=mkdtempSync(join(tmpdir(),"shuduo-model-lost-reply-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const {env,current}=fixture("apply");
  const sentinel="test-only-lost-update-private-output";
  const identity={AccountId:account,Arn:`acs:ram::${account}:assumed-role/${role}/synthetic-run`};
  writeFileSync(join(dir,"input.json"),JSON.stringify({candidate,previous,unrelatedSecret,identity,sentinel}),{mode:0o600});
  writeFileSync(join(dir,"function.json"),JSON.stringify(current),{mode:0o600});
  const fakeCli=`#!/usr/bin/env node
const fs=require("node:fs"), path=require("node:path");
const filename=name=>path.join(__dirname,name);
const input=JSON.parse(fs.readFileSync(filename("input.json")));
const current=JSON.parse(fs.readFileSync(filename("function.json")));
const args=process.argv.slice(2);
const op=args[0]==="sts" && args[1]==="GetCallerIdentity" ? "STS" : args[0]==="fc" ? args[1] : "INVALID";
const noSecretsInArgs=args.every(arg=>[input.candidate,input.previous,input.unrelatedSecret].every(s=>!arg.includes(s)));
const noModelKeyInEnv=!Object.values(process.env).some(v=>v.includes(input.candidate));
const record={op,noSecretsInArgs,noModelKeyInEnv,noRetries:args.includes("--retry-count") && args[args.indexOf("--retry-count")+1]==="0"};
let patch;
if(op==="PUT"){
  record.bodyFile=args.includes("--body-file") ? args[args.indexOf("--body-file")+1] : "";
  record.bodyMode=record.bodyFile ? fs.statSync(record.bodyFile).mode&0o777 : 0;
  record.directoryMode=record.bodyFile ? fs.statSync(path.dirname(record.bodyFile)).mode&0o777 : 0;
  patch=record.bodyFile ? JSON.parse(fs.readFileSync(record.bodyFile)) : {};
  if(Object.keys(patch).join(",")!=="environmentVariables" || patch.environmentVariables.DASHSCOPE_API_KEY!==input.candidate)process.exit(3);
}
fs.appendFileSync(filename("calls.jsonl"),JSON.stringify(record)+"\\n",{mode:0o600});
if(op==="STS")console.log(JSON.stringify(input.identity));
else if(op==="GET")console.log(JSON.stringify(current));
else if(op==="PUT"){
  fs.writeFileSync(filename("function.json"),JSON.stringify({...current,...patch}),{mode:0o600});
  console.log(input.sentinel, input.candidate);
  console.error(input.sentinel, input.previous, input.unrelatedSecret);
  process.exitCode=1;
}else process.exitCode=2;
`;
  writeFileSync(join(dir,"aliyun"),fakeCli,{mode:0o700});
  const preload=join(dir,"catalogue-fixture.mjs");
  writeFileSync(preload,`globalThis.fetch=async(raw,options)=>{
    if(new URL(raw).href!=="https://dashscope.aliyuncs.com/api/v1/models?model=qwen3.7-plus&page_no=1&page_size=20" ||
        (options.method??"GET")!=="GET" || options.redirect!=="error")throw Error("fixture catalogue only");
    const authorized=new Headers(options.headers).has("authorization");
    return Response.json(authorized ? {success:true,output:{models:[{model:"qwen3.7-plus"}]}} : {},{status:authorized ? 200 : 401});
  };\n`,{mode:0o600});
  const entry=fileURLToPath(new URL("../../scripts/run-v2-control-model-secret.mjs",import.meta.url));
  const r=spawnSync(process.execPath,["--import",pathToFileURL(preload).href,entry],{
    env:{...env,HOME:dir,TMPDIR:dir,PATH:[dir,dirname(process.execPath)].join(delimiter),
      ALIBABA_CLOUD_ACCESS_KEY_ID:"test-only-identity",ALIBABA_CLOUD_ACCESS_KEY_SECRET:"test-only-secret",
      ALIBABA_CLOUD_SECURITY_TOKEN:"test-only-session"},encoding:"utf8",timeout:15000,
  });
  assert.equal(r.status,0);
  for(const sensitive of [sentinel,candidate,previous,unrelatedSecret])assert.ok(!(r.stdout+r.stderr).includes(sensitive));
  assert.equal(r.stderr,"");
  assert.deepEqual(JSON.parse(r.stdout),{ok:true,status:"CONFIG_VERIFIED",putAttempts:1,
    configurationVerified:true,catalogueVerified:true,modelInferenceVerified:false});
  const calls=readFileSync(join(dir,"calls.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
  assert.deepEqual(calls.map(x=>x.op),["STS","GET","GET","PUT","GET"]);
  assert.ok(calls.every(x=>x.noSecretsInArgs&&x.noModelKeyInEnv&&x.noRetries));
  const put=calls.find(x=>x.op==="PUT");
  assert.equal(put.bodyMode,0o600);
  assert.equal(put.directoryMode,0o700);
  assert.ok(!existsSync(put.bodyFile)&&!existsSync(dirname(put.bodyFile)));
  const stored=JSON.parse(readFileSync(join(dir,"function.json")));
  assert.equal(preservedModelConfigDigest(stored),preservedModelConfigDigest(current));
  assert.ok(stored.environmentVariables.DASHSCOPE_API_KEY===candidate);
});
