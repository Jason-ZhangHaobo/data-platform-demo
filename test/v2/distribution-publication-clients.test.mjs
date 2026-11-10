import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{runV2Cli}from'../../bin/shuduo.mjs';import{handleV2Mcp}from'../../bin/shuduo-mcp.mjs';import{V2Client}from'../../src/v2/client.mjs';
const releaseId='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
const consent={scope:'LOCAL_TEST_RELEASE',packageDigest:'a'.repeat(64),verificationId:releaseId,metadataHash:'b'.repeat(64),scheduleSpec:{triggerAfterSeconds:5,intervalSeconds:30,runCount:2},confirmFrozenFictionalData:true};
function fixture(){const seen=[];const client=new V2Client({baseUrl:'https://synthetic.invalid/api/v2',fetchImpl:async(url,options)=>{seen.push({url,body:options.body?JSON.parse(options.body):undefined,headers:options.headers});return new Response(JSON.stringify({id:releaseId,status:'synthetic'}),{status:200,headers:{'content-type':'application/json'}});}});return{client,seen};}
function file(t,value){const dir=mkdtempSync(join(tmpdir(),'distribution-consent-')),path=join(dir,'reviewed.json');writeFileSync(path,JSON.stringify(value));t.after(()=>rmSync(dir,{recursive:true,force:true}));return path;}
test('CLI forwards reviewed distribution consent, frozen timing, stop digest and rollback request identity without auto-confirmation',async t=>{
 const f=fixture(),path=file(t,consent),cli=args=>runV2Cli(args,{}, {client:f.client,output:()=>{},error:()=>{}});
 assert.equal(await cli(['releases','approve','--package-id','pkg','--package-digest',consent.packageDigest,'--review-id','review','--distribution-consent',path]),0);assert.deepEqual(f.seen[0].body.distributionConsent,consent);
 assert.equal(await cli(['releases','publish','--approval-id','approved','--distribution-consent',path]),0);assert.equal(f.seen[1].body.intervalSeconds,30);
 assert.equal(await cli(['releases','cancel','--id',releaseId,'--package-digest',consent.packageDigest]),0);assert.deepEqual(f.seen[2].body,{packageDigest:consent.packageDigest});
 const rollback={scope:'LOCAL_TEST_RELEASE',targetPackageDigest:consent.packageDigest,metadataHash:consent.metadataHash,confirmFrozenFictionalData:true};
 assert.equal(await cli(['releases','rollback','--id',releaseId,'--target-release-id',requestId,'--reason','合成测试恢复','--distribution-consent',file(t,rollback),'--request-id',requestId]),0);assert.deepEqual(f.seen[3].body.distributionRollback,rollback);assert.equal(f.seen[3].body.intervalSeconds,undefined);assert.equal(f.seen[3].headers['Idempotency-Key'],requestId);
});
test('MCP exposes closed consent schema and forwards the same stop/rollback contracts',async()=>{
 const f=fixture(),mcp=(name,args)=>handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}},{client:f.client});
 const list=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/list'},{client:f.client})).result.tools;
 assert.equal(list.find(t=>t.name==='release_approve').inputSchema.properties.distributionConsent.additionalProperties,false);assert(list.some(t=>t.name==='release_cancel'));
 await mcp('release_approve',{packageId:'pkg',packageDigest:consent.packageDigest,reviewId:'review',distributionConsent:consent});assert.deepEqual(f.seen[0].body.distributionConsent,consent);
 await mcp('release_cancel',{releaseId,packageDigest:consent.packageDigest});assert.equal(f.seen[1].body.packageDigest,consent.packageDigest);
 const rollback={scope:'LOCAL_TEST_RELEASE',targetPackageDigest:consent.packageDigest,metadataHash:consent.metadataHash,confirmFrozenFictionalData:true};
 await mcp('release_rollback',{releaseId,targetReleaseId:requestId,reason:'合成恢复',distributionRollback:rollback,requestId});assert.deepEqual(f.seen[2].body.distributionRollback,rollback);assert.equal(f.seen[2].body.intervalSeconds,undefined);assert.equal(f.seen[2].headers['Idempotency-Key'],requestId);
});
