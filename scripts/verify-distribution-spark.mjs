#!/usr/bin/env node
// Two local Spark processes, ten literal synthetic scenarios. No model/cloud.
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createV2Server} from '../src/v2/server.mjs';
import {MetadataStore} from '../src/v2/store.mjs';
import {referenceSqlForContext,getContext,validationFamilyForContext} from '../src/v2/context.mjs';
import {verifyOutputRows} from '../src/v2/output-contracts.mjs';
import {runSpark,runtimeConfig} from '../src/v2/spark.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const directory=resolve(root,'.runtime',`distribution-acceptance-${Date.now()}`);
mkdirSync(directory,{recursive:true,mode:0o700});
const store=new MetadataStore(join(directory,'metadata.sqlite'));
let sparks=0,models=0,posts=0,closed=false;
const config=runtimeConfig({V2_ARTIFACT_ROOT:directory},root);
assert(config.available,'Local Java/Python runtime is required; no bootstrap or paid fallback is performed.');
const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},
 runner:async input=>{assert(++sparks<=2,'No automatic extra execution');return runSpark(input,config);},
 generator:async()=>{models++;throw Error('Models are disabled for this acceptance');}});
app.server.on('request',req=>{if(req.method==='POST')posts++;});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${app.server.address().port}`,base=origin+'/api/v2';
const receipt={schema:'shuduo-distribution-local-acceptance/v1',scope:'LOCAL_CLASSIC_SQL_ONLY',fullAgentE2E:false,status:'RUNNING',scenarios:[],startedAt:new Date().toISOString(),directory};
const save=()=>writeFileSync(join(directory,'receipt.json'),JSON.stringify({...receipt,sparks,models,posts},null,2),{mode:0o600});
const close=async()=>{if(closed)return;closed=true;app.server.closeAllConnections();await new Promise(r=>app.server.close(r));store.close();};
const post=async(path,body,key)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json','x-shuduo-client':'workbench','idempotency-key':key},body:JSON.stringify(body)});assert(response.ok,`${path} HTTP ${response.status}`);return response.json();};
try{
 for(const dimension of ['asset-class','industry']){
  const contextId=`holdings-${dimension}-t1`,sql=referenceSqlForContext(contextId);
  const revision=await post('/revisions',{contextId,sql},`distribution-save-${dimension}`);
  const submitted=await post('/runs',{revisionId:revision.id},`distribution-run-${dimension}`);
  let run;const deadline=Date.now()+120000;
  do{run=await(await fetch(base+'/runs/'+submitted.id)).json();if(!['QUEUED','RUNNING'].includes(run.status))break;await new Promise(r=>setTimeout(r,500));}while(Date.now()<deadline);
  assert.equal(run.status,'SUCCEEDED',run.error??run.validation?.issues?.join(';'));
  assert.equal(run.engine,'Apache Spark');assert.equal(run.mainSqlExecuted,true);
  assert.equal(run.revisionId,revision.id);assert.equal(run.revisionHash,revision.hash);
  assert(verifyOutputRows(run.rows,getContext(contextId)));
  const family=validationFamilyForContext(contextId),cases=run.validation.regressions;
  assert.equal(cases.length,5);assert.equal(new Set(cases.map(c=>c.contextId)).size,5);
  assert(family.contextIds.every(id=>cases.some(c=>c.contextId===id&&c.passed&&/^[a-f0-9]{64}$/.test(c.assertionEvidence?.contentHash)&&/^[a-f0-9]{64}$/.test(c.inputEvidence?.inputHash))));
  writeFileSync(join(directory,`${dimension}-run.json`),JSON.stringify(run,null,2),{mode:0o600});
  receipt.scenarios.push({contextId,revisionId:revision.id,revisionHash:revision.hash,runId:run.id,status:run.status,engine:run.engine,engineVersion:run.engineVersion,rows:run.rows.length,regressions:cases.map(c=>({contextId:c.contextId,passed:c.passed,inputHash:c.inputEvidence.inputHash,assertionHash:c.assertionEvidence.contentHash}))});save();
 }
 assert.equal(sparks,2);assert.equal(models,0);assert.equal(posts,4);
 receipt.status='PASSED';receipt.finishedAt=new Date().toISOString();receipt.preview=`${origin}/v2/?module=development`;save();
 console.log(JSON.stringify({status:receipt.status,scope:receipt.scope,sparks,models,regressions:10,receipt:join(directory,'receipt.json'),preview:process.argv.includes('--preview')?receipt.preview:undefined}));
 if(process.argv.includes('--preview')){
  const stop=async()=>{receipt.closedAt=new Date().toISOString();save();await close();process.exit(0);};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);process.stdin.resume();
 }else await close();
}catch(error){receipt.status='FAILED';receipt.errorCode='LOCAL_DISTRIBUTION_ASSERTION_FAILED';save();await close();throw error;}
