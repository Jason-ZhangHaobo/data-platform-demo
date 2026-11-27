import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
import {assetQueryContract,boundAssetQueryContract} from '../../src/v2/asset-query-contract.mjs';
import {readBatchServiceDocument} from '../../src/v2/batch-service-document.mjs';
import {serviceSourceReadPath} from '../../src/v2/service-source-request.mjs';

function fixture(){
  const args={taskId:randomUUID(),releaseId:randomUUID(),batchId:randomUUID(),packageDigest:'a'.repeat(64),serviceId:randomUUID(),versionId:randomUUID()};
  const service={id:args.serviceId,name:'虚构持仓服务',slug:'fixture-holdings',serviceType:'DAPI',status:'PUBLISHED',publishedVersionId:args.versionId};
  const version={id:args.versionId,serviceId:args.serviceId,serviceType:'DAPI',versionNumber:2,status:'PUBLISHED',scope:'PRIVATE_CLOUD_TEST',
    fields:['client_id','holding_market_value','security_count'],sourceReleaseRunId:args.batchId,configHash:'b'.repeat(64),timeoutMs:1000,rateLimitPerMinute:20};
  const entry={serviceType:'DAPI',serviceId:service.id,versionId:version.id,configHash:version.configHash,name:service.name,releaseId:args.releaseId,
    source:{scope:'PRIVATE_CLOUD_TEST',sourceKind:'AGENT',taskId:args.taskId,sourceReleaseRunId:args.batchId,releaseId:args.releaseId,packageDigest:args.packageDigest},
    sourceVersions:[{serviceId:service.id,versionId:version.id,configHash:version.configHash,
      sourceReleaseRunId:args.batchId,releaseId:args.releaseId,packageDigest:args.packageDigest,fields:version.fields}],
    queryContract:assetQueryContract(service,version,[])};
  const receipt={protocol:'shuduo-private-task-consumption/v1',scope:'PRIVATE_CLOUD_TEST',sourceKind:'AGENT',taskId:args.taskId,
    releaseId:args.releaseId,packageDigest:args.packageDigest,sourceReleaseRunId:args.batchId,services:[entry]};
  const path=serviceSourceReadPath('task-evidence',{agentTaskId:args.taskId,packageDigest:args.packageDigest,releaseId:args.releaseId,batchId:args.batchId});
  const reads=[];
  const client={baseUrl:'https://site.example.invalid/api/v2',request:async(p,options)=>{assert.equal(p,path);assert.equal(options,undefined);reads.push(p);return receipt;}};
  return {args,entry,receipt,client,reads};
}

test('CLI exports a private OpenAPI file and MCP reads the same fixed version without a consumer call',async t=>{
  const {args,client,reads}=fixture();
  const dir=mkdtempSync(join(tmpdir(),'batch-openapi-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const path=join(dir,'holdings.json'),cli=['services','batch-openapi','--task-id',args.taskId,'--release-id',args.releaseId,
    '--batch-id',args.batchId,'--package-digest',args.packageDigest,'--service-id',args.serviceId,'--version-id',args.versionId,'--out-file',path];
  let output;
  const run=()=>runV2Cli(cli,{},{client,output:s=>{output=JSON.parse(s);},error:()=>{}});
  assert.equal(await run(),0);assert.equal(output.saved,true);assert.equal(statSync(path).mode&0o777,0o600);
  const doc=JSON.parse(readFileSync(path,'utf8'));
  assert.equal(doc['x-shuduo-service-version-id'],args.versionId);
  assert.deepEqual(doc.servers,[{url:'https://site.example.invalid'}]);
  const rpc=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'data_service_batch_openapi',arguments:args}},{client}));
  assert.deepEqual(rpc.result.structuredContent,doc);
  assert.equal(await run(),1);assert.equal(reads.length,2);
});

test('stale version, malformed path, mixed batch and unbound fields cannot advertise an active query',async()=>{
  const {args,entry,receipt}=fixture();
  for(const change of [r=>{r.queryContract.slug='unrelated/path';},r=>{r.queryContract.sources[0].batchId=randomUUID();},
    r=>{r.sourceVersions[0].configHash='c'.repeat(64);},r=>{r.queryContract.sources[0].fields=['client_id','total_assets'];},
    r=>{r.queryContract.versionId=randomUUID();},r=>{r.versionStatus='RETIRED';}]){
    const invalid=structuredClone(entry);change(invalid);
    assert.equal(boundAssetQueryContract(invalid,args.batchId),undefined);
  }
  entry.queryContract.current=false;
  assert.equal(boundAssetQueryContract(entry,args.batchId).current,false);
  await assert.rejects(readBatchServiceDocument({request:async()=>receipt},args),/在服/);
});
