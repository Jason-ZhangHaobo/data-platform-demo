import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {V2Client} from '../../src/v2/client.mjs';

async function listen(app){await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${app.server.address().port}/api/v2`;}
async function call(base,path,body,cookie){
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':'original-agent-request',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
}
test('lookup survives metadata reopen and never recreates or reruns the original task',async()=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-agent-request-')),path=join(root,'platform.sqlite');let modelCalls=0;
 let store=new MetadataStore(path),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:async()=>{modelCalls++;throw Error('controlled synthetic failure');},runner:async()=>{throw Error('must not execute');}}),base=await listen(app);
 let created;
 try{
  created=await call(base,'/agent/tasks',{message:'虚构证券客户资产加工',sql:'SELECT client_id FROM accounts',contextId:'holdings-t1'});assert.equal(created.status,202);
  for(let i=0;i<10;i++){const result=await call(base,`/agent/tasks/${created.body.id}`);if(result.body.status==='FAILED')break;await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal((await call(base,'/agent/requests/original-agent-request')).body.id,created.body.id);
  let recovered;
  assert.equal(await runV2Cli(['agent','request','--request-id','original-agent-request'],{}, {client:new V2Client({baseUrl:base}),output:value=>{recovered=JSON.parse(value);},error:()=>{}}),0);
  assert.equal(recovered.id,created.body.id);
  const oldBase=process.env.SHUDUO_V2_API_BASE_URL,oldSession=process.env.SHUDUO_V2_SESSION_FILE;
  try{
   process.env.SHUDUO_V2_API_BASE_URL=base;delete process.env.SHUDUO_V2_SESSION_FILE;
   const {handleV2Mcp}=await import('../../bin/shuduo-mcp.mjs?agent-request-recovery');
   const listing=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'}));
   assert.equal(listing.result.tools.find(tool=>tool.name==='agent_request_lookup').annotations.readOnlyHint,true);
   const reply=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'agent_request_lookup',arguments:{requestId:'original-agent-request'}}}));
   assert.equal(reply.result.structuredContent.id,created.body.id);
  }finally{if(oldBase===undefined)delete process.env.SHUDUO_V2_API_BASE_URL;else process.env.SHUDUO_V2_API_BASE_URL=oldBase;if(oldSession===undefined)delete process.env.SHUDUO_V2_SESSION_FILE;else process.env.SHUDUO_V2_SESSION_FILE=oldSession;}
  assert.equal(modelCalls,1);assert.equal((await call(base,'/agent/requests/other-request')).status,404);
 }finally{await new Promise(resolve=>app.server.close(resolve));store.close();}
 store=new MetadataStore(path);app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'}});base=await listen(app);
 try{const restored=await call(base,'/agent/requests/original-agent-request');assert.equal(restored.status,200);assert.equal(restored.body.id,created.body.id);assert.equal(store.list('agent',PROJECT).length,1);assert.equal(modelCalls,1);}
 finally{await new Promise(resolve=>app.server.close(resolve));store.close();}
});
test('invited request lookup is scoped to the creator and rejects anonymous or another project',async()=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-agent-request-owner-')),store=new MetadataStore(':memory:'),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true'}}),base=await listen(app);
 const password='SyntheticPassword!2026';
 const owner=app.auth.bootstrapAdmin({email:'owner@example.invalid',password,displayName:'测试创建者'});
 app.auth.bootstrapAdmin({email:'other@example.invalid',password,displayName:'测试其他人'});
 const task=store.deduplicate(`${PROJECT}:durable-agent:${owner.id}:original-agent-request`,'fixture',()=>store.create('agent',PROJECT,{executionMode:'DURABLE_SQL_AGENT_V1',submittedBy:owner.id,status:'QUEUED',attempts:[]}));
 const login=async email=>(await call(base,'/auth/login',{email,password})).cookies.map(value=>value.split(';')[0]).join('; ');
 try{
  assert.equal((await call(base,'/agent/requests/original-agent-request')).status,403);
  const ownerCookie=await login('owner@example.invalid'),otherCookie=await login('other@example.invalid');
  assert.equal((await call(base,'/agent/requests/original-agent-request',undefined,ownerCookie)).body.id,task.id);
  assert.equal((await call(base,'/agent/requests/original-agent-request',undefined,otherCookie)).status,404);
  const wrong=await fetch(base+'/agent/requests/original-agent-request',{headers:{cookie:ownerCookie,'x-project-id':'other-project'}});assert.equal(wrong.status,403);
  assert.equal(store.list('agent',PROJECT).length,1);
 }finally{await new Promise(resolve=>app.server.close(resolve));store.close();}
});
