import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';

const taskId='00000000-0000-4000-8000-000000000001',runId='00000000-0000-4000-8000-000000000002',verificationId='00000000-0000-4000-8000-000000000003',releaseId='00000000-0000-4000-8000-000000000004';
const manual={sourceKind:'MANUAL',sourceRunId:runId,packageDigest:'a'.repeat(64),verificationId},attestations={code:true,assertions:true,deliveryFiles:true,cloudScope:true};
const flags=['--source-kind','MANUAL','--source-run-id',runId,'--package-digest',manual.packageDigest,'--verification-id',verificationId];
function transport(kind='cli',fail=false){
  const seen=[];
  const client=new V2Client({baseUrl:'https://synthetic.invalid/api/v2',client:kind,fetchImpl:async(url,options)=>{
    seen.push({url,method:options.method,headers:options.headers,body:options.body?JSON.parse(options.body):undefined});
    if(fail)throw Error('synthetic transport outcome unknown');
    return new Response(JSON.stringify({synthetic:true,status:'WAITING_SCHEDULER'}),{status:200,headers:{'content-type':'application/json'}});
  }});
  return {client,seen};
}
function reviewedFile(t,value){const directory=mkdtempSync(join(tmpdir(),'shuduo-publication-cli-')),path=join(directory,'synthetic-review.json');writeFileSync(path,JSON.stringify(value));t.after(()=>rmSync(directory,{recursive:true,force:true}));return path;}
const cli=(args,f)=>runV2Cli(args,{}, {client:f.client,output:()=>{},error:()=>{}});
const mcp=async(name,args,f)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client}));

test('CLI detail and stop send the exact manual selector and keep legacy AGENT omission',async()=>{
  const f=transport();
  assert.equal(await cli(['agent','publication','--id',taskId,...flags,'--release-id',releaseId],f),0);
  const parsed=new URL(f.seen[0].url);assert.deepEqual(Object.fromEntries(parsed.searchParams),{...manual,releaseId});assert.equal(f.seen[0].method,'GET');assert.equal(f.seen[0].body,undefined);
  assert.equal(await cli(['agent','stop-publication','--id',taskId,...flags,'--release-id',releaseId],f),0);
  assert.equal(f.seen[1].url,`https://synthetic.invalid/api/v2/agent/tasks/${taskId}/publication/cancel`);assert.deepEqual(f.seen[1].body,{...manual,releaseId});
  assert.equal(await cli(['agent','publication','--id',taskId],f),0);assert.equal(new URL(f.seen[2].url).search,'');
  assert.equal(await cli(['agent','stop-publication','--id',taskId],f),0);assert.deepEqual(f.seen[3].body,{});
});

test('CLI human-reviewed create sends manual attribution and reuses explicit request id without automatic retry',async t=>{
  const file=reviewedFile(t,{packageDigest:manual.packageDigest,verificationId,attestations}),f=transport();
  const args=['agent','publish','--id',taskId,'--file',file,'--source-kind','MANUAL','--source-run-id',runId,'--request-id','original-reviewed-request'];
  assert.equal(await cli(args,f),0);assert.equal(await cli(args,f),0);
  assert.deepEqual(f.seen[0].body,{...manual,attestations});assert.deepEqual(f.seen[1].body,f.seen[0].body);
  assert.equal(f.seen[0].headers['Idempotency-Key'],'original-reviewed-request');assert.equal(f.seen[1].headers['Idempotency-Key'],'original-reviewed-request');
  assert.equal(f.seen[0].headers['X-Actor-Id'],undefined);
  const failure=transport('cli',true);assert.equal(await cli(args,failure),1);assert.equal(failure.seen.length,1);
});

test('CLI rejects actor injection, duplicate flags, incomplete manual source, conflicting review and absent attestations before transport',async t=>{
  const valid=reviewedFile(t,{...manual,attestations}),actor=reviewedFile(t,{...manual,attestations,actorId:'other'}),noReview=reviewedFile(t,{...manual});
  const f=transport();
  for(const args of [
    ['agent','publication','--id',taskId,...flags,'--actor-id','other'],
    ['agent','publication','--id',taskId,...flags,'--source-kind','MANUAL'],
    ['agent','publication','--id',taskId,'--source-kind','MANUAL'],
    ['agent','stop-publication','--id',taskId,...flags],
    ['agent','publish','--id',taskId,'--file',valid,'--package-digest','b'.repeat(64)],
    ['agent','publish','--id',taskId,'--file',actor],['agent','publish','--id',taskId,'--file',noReview],
    ['agent','publish','--id',taskId,'--file',valid,'--request-id','unsafe/id'],
  ])assert.equal(await cli(args,f),1);
  assert.equal(f.seen.length,0);
});

test('MCP maps all three tools through real V2Client transport without changing actor or approval',async()=>{
  const f=transport('mcp');
  assert.equal((await mcp('agent_publication_detail',{taskId,...manual,releaseId},f)).error,undefined);
  assert.deepEqual(Object.fromEntries(new URL(f.seen[0].url).searchParams),{...manual,releaseId});assert.equal(f.seen[0].method,'GET');
  assert.equal((await mcp('agent_publication_create',{taskId,...manual,attestations,requestId:'same-publish'},f)).error,undefined);
  assert.deepEqual(f.seen[1].body,{...manual,attestations});assert.equal(f.seen[1].headers['Idempotency-Key'],'same-publish');
  assert.equal((await mcp('agent_publication_stop',{taskId,...manual,releaseId},f)).error,undefined);
  assert.deepEqual(f.seen[2].body,{...manual,releaseId});assert.equal(f.seen[2].headers['X-Shuduo-Client'],'mcp');
  assert.equal(f.seen.every(item=>item.headers['X-Actor-Id']===undefined),true);
  const failure=transport('mcp',true);assert.ok((await mcp('agent_publication_create',{taskId,...manual,attestations,requestId:'same-publish'},failure)).error);assert.equal(failure.seen.length,1);
});

test('MCP raw calls reject actor/unknown keys and missing manual/human approval even without JSON schema enforcement',async()=>{
  const f=transport('mcp');
  for(const [name,args] of [
    ['agent_publication_detail',{taskId,...manual,actorId:'other'}],['agent_publication_detail',{taskId,...manual,actor:'other'}],
    ['agent_publication_detail',{taskId,sourceKind:'MANUAL'}],['agent_publication_create',{taskId,...manual}],
    ['agent_publication_create',{taskId,...manual,attestations:{...attestations,cloudScope:false}}],
    ['agent_publication_create',{taskId,...manual,attestations,requestId:'invalid/request'}],
    ['agent_publication_create',{taskId,...manual,attestations,releaseId}],
    ['agent_publication_stop',{taskId,...manual}],['agent_publication_stop',{taskId,...manual,releaseId,submittedBy:'other'}],
  ])assert.ok((await mcp(name,args,f)).error);
  assert.equal(f.seen.length,0);
});

test('MCP schema declares manual bindings and explicit original request id; old AGENT calls remain compatible',async()=>{
  const listed=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'})).result.tools;
  for(const name of ['agent_publication_detail','agent_publication_create','agent_publication_stop']){
    const tool=listed.find(item=>item.name===name);assert.equal(tool.inputSchema.additionalProperties,false);
    assert.deepEqual(tool.inputSchema.properties.sourceKind.enum,['AGENT','MANUAL']);assert.equal(tool.inputSchema.properties.actorId,undefined);
    assert.ok(tool.inputSchema.allOf[0].then.required.includes('sourceRunId'));
  }
  assert.ok(listed.find(item=>item.name==='agent_publication_stop').inputSchema.allOf[0].then.required.includes('releaseId'));
  assert.equal(listed.find(item=>item.name==='agent_publication_create').inputSchema.properties.requestId.pattern,'^[A-Za-z0-9_-]{1,100}$');
  const f=transport('mcp');await mcp('agent_publication_detail',{taskId},f);await mcp('agent_publication_stop',{taskId},f);
  await mcp('agent_publication_create',{taskId,packageDigest:manual.packageDigest,verificationId,attestations},f);
  assert.equal(new URL(f.seen[0].url).search,'');assert.deepEqual(f.seen[1].body,{});assert.equal(f.seen[2].body.sourceKind,undefined);
});
