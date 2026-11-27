import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {recoverInvitedSqlStart,submitInvitedSqlStart} from '../../src/v2/invited-sql-start.mjs';

function fixture({saved=false,loseWrite=false,lookupStatus,contextPatch={},statusPatch={},sessionPatch={}}={}){
  const args={message:'统计虚构客户持仓及现金',contextId:'holdings-t1',requestId:randomUUID(),confirm:true};
  const {contextId,message,requestId}=args;
  const taskId=randomUUID(),calls=[];
  const raw={id:taskId,contextId,message,version:1,initialSql:'SELECT 1 AS pending',language:'SPARK_SQL',
    executionMode:'DURABLE_SQL_AGENT_V1',mode:'LIVE_MODEL',attempts:[]};
  const view={status:{projectId:'demo',mode:'PUBLIC_INVITATION',agentDevelopment:{durableEnabled:true,eventBackgroundAvailable:true,invitedSqlStartSupported:true},
    spark:{available:true},model:{configured:true},...statusPatch},session:{authenticated:true,user:{id:'creator',projectId:'demo'},
    role:'ADMIN',permissions:['AGENT'],readOnly:false,developmentOnly:true,developmentStartsAt:new Date(Date.now()-60000).toISOString(),
    developmentExpiresAt:new Date(Date.now()+60000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),...sessionPatch}};
  const client={request:async(path,options)=>{
    calls.push({path,options});
    if(path==='/status?include=session')return view;
    if(path==='/contexts')return [{id:contextId,...contextPatch}];
    if(path==='/agent/requests/'+requestId){
      if(lookupStatus || !saved)throw Object.assign(Error('lookup'),{status:lookupStatus??404});
      return raw;
    }
    if(path==='/agent/tasks'){
      assert.deepEqual(options,{method:'POST',idempotencyKey:requestId,body:{message,sql:'SELECT 1 AS pending',contextId,background:true}});
      saved=true;
      if(loseWrite)throw Error('response lost');
      return raw;
    }
    assert.equal(path,'/agent/tasks/'+taskId+'/chat-context?request_id='+requestId);
    return {protocol:'shuduo-invited-sql-context/v1',scope:'INVITED_TASK_READ_ONLY',readOnly:true,
      fullLifecycleE2E:false,taskId,requestId,contextId,message,taskStatus:'QUEUED',taskStage:'READY_FOR_MODEL',
      attemptCount:0,evidenceState:'PENDING',evidenceSource:'STORED_METADATA'};
  }};
  return {args,client,calls,selection:{taskId,requestId},writes:()=>calls.filter(c=>c.options).length};
}

test('CLI starts the reviewed draft and MCP reuses the identical request without another POST',async()=>{
  const f=fixture(),{message,contextId,requestId}=f.args;
  const flags=['agent','invited-start','--context',contextId,'--message',message,'--request-id',requestId,'--confirm'];
  let result,out;
  const io={client:f.client,output:s=>{out=JSON.parse(s)},error:()=>{}};
  assert.equal(await runV2Cli(flags,{},io),0);assert.deepEqual(out,f.selection);
  const call=async(name,args)=>JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client}));
  result=await call('agent_invited_sql_start',f.args);assert.deepEqual(result.result.structuredContent,f.selection);
  result=await call('agent_invited_sql_start_request',{requestId});assert.deepEqual(result.result.structuredContent,f.selection);
  assert.equal(await runV2Cli(['agent','invited-start-request','--request-id',requestId],{},io),0);assert.deepEqual(out,f.selection);
  assert.equal(f.writes(),1);
  const before=f.calls.length;
  assert.equal(await runV2Cli([...flags,'--request-id',randomUUID()],{},io),1);
  assert.equal(await runV2Cli(flags.slice(0,-1),{},io),1);
  for(const args of [{...f.args,confirm:false},{...f.args,actor:'someone-else'}]){
    result=await call('agent_invited_sql_start',args);assert(result.error||result.result?.isError);
  }
  assert.equal(f.calls.length,before);
});

test('limited, readonly, local, unavailable or already used windows cannot dispatch through an external client',async()=>{
  for(const options of [
    ...[{developmentTaskOnly:true},{developmentRequestOnly:true},{developmentWindowUsed:true},{readOnly:true},
      {developmentExpiresAt:new Date(0).toISOString()},{user:{id:'creator',projectId:'other'}}].map(sessionPatch=>({sessionPatch})),
    ...[{mode:'LOCAL_DEVELOPMENT'},{model:{configured:false}},{spark:{available:false}},
      {agentDevelopment:{durableEnabled:true,eventBackgroundAvailable:false,invitedSqlStartSupported:true}},
      {agentDevelopment:{durableEnabled:true,eventBackgroundAvailable:true}}].map(statusPatch=>({statusPatch})),
    {contextPatch:{capabilities:{scope:'LOCAL_ONLY'}}},{contextPatch:{capabilities:{fundPreparation:true}}},
    {lookupStatus:403},{lookupStatus:503},
  ]){
    const f=fixture(options);await assert.rejects(submitInvitedSqlStart(f.client,f.args));
    assert.equal(f.writes(),0);
  }
});

test('an ambiguous write is only recovered from its original request and mismatched inputs cannot reuse a success',async()=>{
  const f=fixture({loseWrite:true});
  await assert.rejects(submitInvitedSqlStart(f.client,f.args),{code:'INVITED_SQL_START_UNCONFIRMED'});
  assert.deepEqual(await recoverInvitedSqlStart(f.client,{requestId:f.args.requestId}),f.selection);
  for(const patch of [{message:'另一条委托需求'},{contextId:'cash-change'}]){
    await assert.rejects(submitInvitedSqlStart(f.client,{...f.args,...patch}),/不一致/);
  }
  assert.equal(f.writes(),1);
});
