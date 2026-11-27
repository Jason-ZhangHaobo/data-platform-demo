import test from 'node:test';
import assert from 'node:assert/strict';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {publicationSelectorInput,publicationReadPath,publicationHistoryPath,publicationSelectorFromUrl,privatePublicationReadRoute} from '../../src/v2/publication-request.mjs';

const taskId='00000000-0000-4000-8000-000000000001',runId='00000000-0000-4000-8000-000000000002',verificationId='00000000-0000-4000-8000-000000000003',releaseId='00000000-0000-4000-8000-000000000004';
const manual={sourceKind:'MANUAL',sourceRunId:runId,packageDigest:'a'.repeat(64),verificationId};

test('CLI and MCP use the creator’s stored package history without any publication write or Worker reconciliation',async()=>{
  const selection={...manual,sourceKind:'AGENT',releaseId},requests=[];
  const receipt={readMode:'SAVED_HISTORY',release:{id:releaseId},runs:[],alerts:[],events:[]};
  const client={request:async(path,options)=>{requests.push(path);assert.equal(options,undefined);return receipt;}};
  let cli;
  assert.equal(await runV2Cli(['agent','publication-history','--id',taskId,'--source-kind','AGENT',
    '--source-run-id',runId,'--package-digest',selection.packageDigest,'--verification-id',verificationId,'--release-id',releaseId],
    {},{client,output:s=>{cli=JSON.parse(s);},error:()=>{}}),0);
  const call=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',
    params:{name:'agent_publication_history',arguments:{taskId,...selection}}},{client}));
  assert.deepEqual(call.result.structuredContent,cli);assert.deepEqual(cli,receipt);
  assert.deepEqual(requests,Array(2).fill(publicationHistoryPath(taskId,selection)));
});

test('a conversation can read an exact saved package before learning its release ID',()=>{
  const version={...manual,sourceKind:'AGENT'};
  for(const input of [version,{...version,releaseId}]){
    const path=publicationHistoryPath(taskId,input);
    assert.equal(path.split('?')[0],`/agent/tasks/${taskId}/publication/history`);
    assert.deepEqual(publicationSelectorFromUrl(path),input);
  }
  for(const selector of [manual,{}, {...version,verificationId:undefined},{packageDigest:version.packageDigest,releaseId}]){
    assert.throws(()=>publicationHistoryPath(taskId,selector),{code:'PUBLICATION_SELECTOR_INVALID'});
  }
});

test('pure selector syntax preserves legacy omission and round-trips precise manual/agent query keys',()=>{
  assert.deepEqual(publicationSelectorInput(),{});assert.equal(publicationReadPath(taskId),`/agent/tasks/${taskId}/publication`);
  for(const selector of [manual,{...manual,releaseId},{packageDigest:'a'.repeat(64),verificationId},{sourceKind:'AGENT'},{}]){
    const input=structuredClone(selector),path=publicationReadPath(taskId,input);
    assert.deepEqual(publicationSelectorFromUrl(path),selector);assert.deepEqual(input,selector);
    assert.deepEqual(publicationSelectorFromUrl(new URL(path,'https://example.invalid')),selector);
  }
});

test('selector validation rejects missing manual binding, unknown keys, actor override and unsafe values',()=>{
  for(const input of [null,[],true,{actorId:'any'},{...manual,submittedBy:'other'},{source_kind:'MANUAL'},
    {...manual,sourceKind:'manual'}, {...manual,sourceRunId:'../run'}, {...manual,sourceRunId:''},
    {...manual,sourceRunId:'a'.repeat(101)},{...manual,verificationId:undefined},{...manual,packageDigest:'A'.repeat(64)},
    {sourceKind:'MANUAL',sourceRunId:runId},{sourceKind:'MANUAL',packageDigest:'a'.repeat(64),verificationId},
    {releaseId:'id\u0000'},{sourceKind:'AGENT',surprise:'ignored?'}]){
    assert.throws(()=>publicationSelectorInput(input),{code:'PUBLICATION_SELECTOR_INVALID'});
  }
  for(const id of [undefined,'../x','id?actor=other','a'.repeat(101)])assert.throws(()=>publicationReadPath(id,{}));
});

test('URL parser rejects duplicate/unknown keys instead of allowing URLSearchParams last-value override',()=>{
  const path=publicationReadPath(taskId,manual);
  for(const value of [path+'&sourceKind=MANUAL',path+'&source%4bind=MANUAL',path+'&actorId=other',path+'&unknown=1',path+'#ignored',path+'&releaseId=one&releaseId=two',path+'&releaseId=%2F..',undefined,42,{},path+'\\']){
    assert.throws(()=>publicationSelectorFromUrl(value),{code:'PUBLICATION_SELECTOR_INVALID'});
  }
});

test('private read route is exact GET-only UUID syntax bounded to 700 characters and valid selector',()=>{
  const route='/api/v2'+publicationReadPath(taskId,manual);
  assert.equal(privatePublicationReadRoute('GET',route),true);
  assert.equal(privatePublicationReadRoute('GET',`/api/v2/agent/tasks/${taskId}/publication`),true);
  for(const [method,path] of [['POST',route],['get',route],['GET',route+'/cancel'],['GET',route+'#fragment'],['GET',route+'&actorId=other'],
    ['GET',route+'&sourceKind=MANUAL'],['GET',route.replace(taskId,'not-a-uuid')],['GET','https://example.invalid'+route],
    ['GET',route.replace('/agent/','/agent/../agent/')],['GET',route.replace('/agent/','/agent\\')],['GET',route+' '],
    ['GET',route+'&releaseId='+('a'.repeat(701))],['GET',undefined]])assert.equal(privatePublicationReadRoute(method,path),false);
});
