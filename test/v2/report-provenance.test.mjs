import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {ReportDataStore} from '../../src/v2/reports.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {seedLocalServiceSource} from './fixtures/local-service-sources.mjs';
import {publishedReportHash} from '../../src/v2/published-report-source.mjs';
import {checkedReportProvenance,downloadReportProvenance,readReportProvenance} from '../../src/v2/report-provenance-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

async function fixture(t){
 const store=new MetadataStore(':memory:'),data=new ReportDataStore(),seed=seedLocalServiceSource({store,project:PROJECT});let calls=0;
 const app=createV2Server({store,reportStore:data,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},reportPlanner:async()=>{calls++;return {plan:{kind:'PUBLISHED_REPORT',name:'虚构持仓现金报告',metricIds:['holding_value','available_cash']},model:'SYNTHETIC_PROVENANCE',mode:'TEST_DOUBLE',usage:{total_tokens:50}};},runner:()=>{throw Error('NO_NEW_COMPUTE');}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));data.close();store.close();});
 const client=new V2Client({baseUrl:'http://127.0.0.1:'+app.server.address().port+'/api/v2'}),source={kind:'AGENT',taskId:seed.agent.id,releaseId:seed.release.id,packageDigest:seed.bundle.digest,revisionId:seed.revision.id,runId:seed.codeRun.id,batchId:seed.batches[0].id};
 const first=await client.request('/reports/agent/plans',{method:'POST',body:{message:'分析持仓和现金，不扩大全资产口径',source},idempotencyKey:randomUUID()});let plan;
 for(let i=0;i<100;i++){plan=await client.request('/reports/agent/plans/'+first.id);if(plan.status==='SUCCEEDED')break;await new Promise(r=>setTimeout(r,5));}assert.equal(plan.status,'SUCCEEDED');
 const apply=()=>client.request(`/reports/agent/plans/${plan.id}/apply`,{method:'POST',body:{proposalHash:plan.proposalHash}});
 return {store,data,client,source,plan,apply,calls:()=>calls,origin:'http://127.0.0.1:'+app.server.address().port};
}

test('exact reviewed report freezes once, recovers without recomputation and is shared by HTTP, CLI, MCP and offline verification',async t=>{
 const f=await fixture(t),done=await f.apply(),path=`/reports/${done.reportId}/provenance?run_id=${done.reportRunId}`,e=await f.client.request(path);
 assert.equal(e.review.originalRequest,f.plan.message);assert.equal(e.review.proposalHash,f.plan.proposalHash);assert.equal(e.review.captureMode,'AT_APPLICATION');assert.equal(e.review.provider.mode,'TEST_DOUBLE');assert.equal(e.artifacts.reportVersionId,done.reportVersionId);assert.equal(done.provenanceDigest,e.digest);assert.equal(f.calls(),1);
 assert.equal((await f.apply()).provenanceDigest,e.digest);assert.equal(f.store.list('report_run',PROJECT).length,1);assert.equal(f.store.list('report_provenance',PROJECT).length,1);
 assert.equal((await readReportProvenance(f.client,{reportId:done.reportId,runId:done.reportRunId})).digest,e.digest);
 let cli;await runV2Cli(['reports','provenance','--id',done.reportId,'--run-id',done.reportRunId],{},{client:f.client,output:v=>{cli=JSON.parse(v);},error:v=>{throw Error(v);}});assert.equal(cli.digest,e.digest);
 const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'report_provenance',arguments:{reportId:done.reportId,runId:done.reportRunId}}},{client:f.client}));assert.equal(JSON.parse(mcp.result.content[0].text).digest,e.digest);
 assert.equal((await checkedReportProvenance(e,{reportRunId:done.reportRunId,source:f.source})).digest,e.digest);
 const attachmentUrl = f.origin + '/api/v2' + path + '&download_digest=';
 const downloaded = await fetch(attachmentUrl + e.digest);
 assert.equal(downloaded.status, 200);
 assert.equal(downloaded.headers.get('cache-control'), 'no-store');
 assert.equal(downloaded.headers.get('content-disposition'),
  'attachment; filename="shuduo-report-provenance-' + done.reportRunId.slice(0, 8) + '.json"');
 const originalBytes=Buffer.from(await downloaded.arrayBuffer());
 assert.equal((await checkedReportProvenance(JSON.parse(originalBytes), {
  reportId: done.reportId, reportVersionId: done.reportVersionId, reportRunId: done.reportRunId,
 })).digest, e.digest);
 const directory=mkdtempSync(join(tmpdir(),'shuduo-provenance-cli-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const outputFile=join(directory,'evidence.json'),staleFile=join(directory,'stale.json');
 const args=['reports','provenance','--id',done.reportId,'--run-id',done.reportRunId];
 let cliError;
 const cliOptions={client:f.client,output:value=>{cli=JSON.parse(value);},error:value=>{cliError=value;}};
 const save=[...args,'--download-digest',e.digest,'--out-file',outputFile];
 assert.equal(await runV2Cli(save,{},cliOptions),0);
 assert.deepEqual(cli,{saved:true,digest:e.digest,reportId:done.reportId,runId:done.reportRunId,reportVersionId:done.reportVersionId});
 assert.deepEqual(readFileSync(outputFile),originalBytes);
 assert.equal(statSync(outputFile).mode&0o777,0o600);
 assert.equal(statSync(outputFile).nlink,1);
 assert.equal(await runV2Cli(save,{},cliOptions),1);
 assert.match(cliError,/原文件未覆盖/);
 assert.deepEqual(readFileSync(outputFile),originalBytes);
 assert.equal(await runV2Cli([...args,'--download-digest','f'.repeat(64),'--out-file',staleFile],{},cliOptions),1);
 assert.match(cliError,/重新核对/);
 assert.ok(!existsSync(staleFile));
 assert.deepEqual(readdirSync(directory),['evidence.json']);
 assert.equal(await runV2Cli(['reports','verify-provenance','--file',outputFile],{},cliOptions),0);
 assert.equal(cli.digest,e.digest);
 assert.equal(cli.onlineAuthorityVerified,false);
 const stale = await fetch(attachmentUrl + 'f'.repeat(64));
 assert.equal(stale.status, 409);
 assert.equal(stale.headers.get('content-disposition'), null);
 assert.equal((await fetch(attachmentUrl + 'invalid')).status, 422);
 assert(!JSON.stringify(e).includes('CLIENT-001'));assert(!JSON.stringify(e).includes('local-engineer'));assert(!JSON.stringify(e).includes('rows'));
 const before=publishedReportHash(f.store.list('report_provenance',PROJECT));await f.client.request(path);assert.equal(publishedReportHash(f.store.list('report_provenance',PROJECT)),before);
});

test('report attachment download rejects malformed arguments and substituted or oversized responses',async t=>{
 const f=await fixture(t),done=await f.apply();
 const reportId=done.reportId,runId=done.reportRunId,downloadDigest=done.provenanceDigest;
 const args=['reports','provenance','--id',reportId,'--run-id',runId];
 const noRequest=()=>{assert.fail('invalid CLI arguments must not call the API');};
 let errors=0,requests=0;
 const client={request:()=>{requests++;noRequest();}};
 for (const flags of [
  ['--out-file','never-written.json'],
  ['--download-digest',downloadDigest],
  ['--download-digest','bad','--out-file','never-written.json'],
  ['--download-digest',downloadDigest,'--out-fle','never-written.json'],
 ]) {
  assert.equal(await runV2Cli([...args,...flags],{},{client,output:noRequest,error:()=>{errors++;}}),1);
 }
 assert.equal(errors,4);
 assert.equal(requests,0);
 const filename=`attachment; filename="shuduo-report-provenance-${runId.slice(0,8)}.json"`;
 const headers={'content-type':'application/json','cache-control':'no-store','content-disposition':filename};
 const selected={reportId,runId,downloadDigest};
 const original=await readReportProvenance(f.client,selected);
 const altered=structuredClone(original);
 altered.review.originalRequest+='篡改';
 const mock=(body, responseHeaders=headers)=>new V2Client({fetchImpl:async()=>new Response(body,{headers:responseHeaders})});
 await assert.rejects(downloadReportProvenance(mock(JSON.stringify(altered)),selected),/所选版本不一致/);
 await assert.rejects(downloadReportProvenance(mock(JSON.stringify(original),{...headers,'content-disposition':'inline'}),selected),{
  code:'JSON_ATTACHMENT_REJECTED',
 });
 await assert.rejects(downloadReportProvenance(mock(new Uint8Array(128*1024+1)),selected),{
  code:'JSON_ATTACHMENT_TOO_LARGE',
 });
});

test('historical provenance stays pinned after chat or latest report changes; a new apply still checks the live request',async t=>{
 const f=await fixture(t),done=await f.apply(),path=`/reports/${done.reportId}/provenance?run_id=${done.reportRunId}`,original=await f.client.request(path);
 f.store.update('report_agent_plan',f.plan.id,PROJECT,{message:'已修改的当前聊天'});f.store.update('report',done.reportId,PROJECT,{currentVersionId:randomUUID(),lastRunId:randomUUID()});
 assert.deepEqual(await f.client.request(path),original);await assert.rejects(f.apply(),e=>e.status===409);assert.equal(f.calls(),1);
 await assert.rejects(f.client.request(`/reports/${done.reportId}/provenance`),e=>e.status===422);await assert.rejects(f.client.request(path+'&run_id='+done.reportRunId),e=>e.status===422);await assert.rejects(f.client.request(path.replace(done.reportRunId,randomUUID())),e=>e.status===404);
});

test('rejects altered frozen demand even after local redigest, cross-owner access, changed widgets and corrupted actual snapshot',async t=>{
 const f=await fixture(t),done=await f.apply(),path=`/reports/${done.reportId}/provenance?run_id=${done.reportRunId}`,record=f.store.list('report_provenance',PROJECT)[0],original=structuredClone(record);
 const changed=structuredClone(record.evidence);changed.review.originalRequest='不同口径';const{digest:ignored,...body}=changed;changed.digest=publishedReportHash(body);f.store.update('report_provenance',record.id,PROJECT,{evidence:changed});await assert.rejects(f.client.request(path),e=>e.status===409);f.store.update('report_provenance',record.id,PROJECT,original);
 f.store.update('report_provenance',record.id,PROJECT,{actorId:'other-user'});await assert.rejects(f.client.request(path),e=>e.status===404);f.store.update('report_provenance',record.id,PROJECT,original);
 const run=f.store.get('report_run',done.reportRunId,PROJECT);f.store.update('report_run',run.id,PROJECT,{widgets:[]});await assert.rejects(f.client.request(path),e=>e.status===409);f.store.update('report_run',run.id,PROJECT,run);
 const snap=f.store.get('report_snapshot',done.snapshotId,PROJECT);f.data.db.prepare('UPDATE report_snapshots SET rows_json=? WHERE id=?').run('[]',snap.dataSnapshotId);await assert.rejects(f.client.request(path),e=>e.status===409);assert.equal(f.calls(),1);
});

test('a prior applied report can be explicitly rechecked and frozen without rewriting or executing its artifacts',async t=>{
 const f=await fixture(t),done=await f.client.request('/reports/published',{method:'POST',body:{name:f.plan.proposal.name,metricIds:f.plan.proposal.metricIds,source:f.source},idempotencyKey:f.plan.id});
 f.store.update('report_agent_plan',f.plan.id,PROJECT,{status:'APPLIED',reportId:done.reportId,reportCreation:done,appliedAt:new Date().toISOString()});
 await assert.rejects(readReportProvenance(f.client,{reportId:done.reportId,runId:done.reportRunId}),e=>e.status===404);
 const kinds=['report','report_version','report_run','report_snapshot','report_dataset'],before=publishedReportHash(kinds.map(k=>f.store.list(k,PROJECT))),next=await f.apply();
 assert.equal(next.reportRunId,done.reportRunId);assert.equal(publishedReportHash(kinds.map(k=>f.store.list(k,PROJECT))),before);const e=await readReportProvenance(f.client,{reportId:done.reportId,runId:done.reportRunId});assert.equal(e.review.captureMode,'EXISTING_APPLICATION_RECHECK');assert.equal(f.calls(),1);
 for(const edit of[v=>v.artifacts.reportRunId=randomUUID(),v=>v.review.originalRequest='篡改',v=>v.review.proposalHash='b'.repeat(64),v=>v.agentIndependentE2E=true]){const wrong=structuredClone(e);edit(wrong);await assert.rejects(checkedReportProvenance(wrong));}
 await assert.rejects(checkedReportProvenance(e,{reportRunId:randomUUID()}));
});
