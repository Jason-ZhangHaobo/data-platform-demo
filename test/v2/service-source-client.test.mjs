import test from 'node:test';
import assert from 'node:assert/strict';
import {serviceSourceReadPath} from '../../src/v2/service-source-request.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {V2Client} from '../../src/v2/client.mjs';
const task='00000000-0000-4000-8000-000000000001',release='00000000-0000-4000-8000-000000000002',digest='a'.repeat(64);
const exact={agentTaskId:task,packageDigest:digest,releaseId:release};
function fixture(){const reads=[];return {reads,client:new V2Client({baseUrl:'https://synthetic.invalid/api/v2',fetchImpl:async(url,options)=>{
 reads.push({url,method:options.method,body:options.body});return new Response(JSON.stringify({synthetic:true}),{headers:{'content-type':'application/json'}});
}})};}
const cli=(args,f)=>runV2Cli(args,{}, {client:f.client,output(){},error(){}});
const mcp=async(name,args,f)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client}));

test('read-only source path preserves old discovery and requires complete exact publication selection',()=>{
 assert.equal(serviceSourceReadPath('sources'),'/data-services/sources');
 assert.equal(serviceSourceReadPath('sources',{agentTaskId:task}),`/data-services/sources?agent_task_id=${task}`);
 for(const kind of ['sources','task-evidence']){
  assert.equal(serviceSourceReadPath(kind,exact),`/data-services/${kind}?agent_task_id=${task}&package_digest=${digest}&release_id=${release}`);
  for(const input of [null,[],{...exact,actorId:'other'},{...exact,releaseId:'unsafe/id'},{...exact,agentTaskId:''},{...exact,packageDigest:'wrong'}])assert.throws(()=>serviceSourceReadPath(kind,input));
 }
 for(const partial of [{packageDigest:digest},{releaseId:release},{agentTaskId:task,packageDigest:digest},{agentTaskId:task,releaseId:release}])assert.throws(()=>serviceSourceReadPath('sources',partial));
 assert.equal(serviceSourceReadPath('task-evidence',{agentTaskId:task,packageDigest:digest}),`/data-services/task-evidence?agent_task_id=${task}&package_digest=${digest}`);
 assert.throws(()=>serviceSourceReadPath('task-evidence',{}));
});

test('CLI and MCP preserve exact release selection and never issue a write or fall back on incomplete inputs',async()=>{
 const f=fixture();
 for(const action of ['sources','task-evidence']){
  const flag=action==='sources'?'--agent-task-id':'--task-id';
  const args=['services',action,flag,task,'--package-digest',digest,'--release-id',release];
  assert.equal(await cli(args,f),0);
  assert.equal((await mcp(action==='sources'?'data_service_sources':'data_service_task_evidence',exact,f)).error,undefined);
  for(const bad of [[...args,'--actor-id','other'],[...args,'--release-id',release],[...args.slice(0,-1),'bad/id']])assert.equal(await cli(bad,f),1);
  assert.ok((await mcp(action==='sources'?'data_service_sources':'data_service_task_evidence',{...exact,actorId:'other'},f)).error);
 }
 assert.equal(f.reads.length,4);assert.ok(f.reads.every(x=>x.method==='GET'&&x.body===undefined));
 for(const read of f.reads)assert.deepEqual(Object.fromEntries(new URL(read.url).searchParams),{agent_task_id:task,package_digest:digest,release_id:release});
 assert.equal(await cli(['services','sources','--agent-task-id',task,'--package-digest',digest],f),1);
 assert.ok((await mcp('data_service_sources',{agentTaskId:task,packageDigest:digest},f)).error);assert.equal(f.reads.length,4);
 assert.equal(await cli(['services','sources'],f),0);
 assert.equal((await mcp('data_service_task_evidence',{agentTaskId:task,packageDigest:digest},f)).error,undefined);
 assert.equal(f.reads.length,6);
});
