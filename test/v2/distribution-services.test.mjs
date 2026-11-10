import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';
import{MetadataStore}from'../../src/v2/store.mjs';import{BusinessQueryStore,DataServiceManager,serviceVersionConfigValid}from'../../src/v2/data-services.mjs';
import{getContext}from'../../src/v2/context.mjs';import{distributionMetadataForContext}from'../../src/v2/output-contract-metadata.mjs';import{normalizedDistributionRows}from'../../src/v2/distribution-services.mjs';
function fixture(t,id='holdings-asset-class-t1'){
 const root=mkdtempSync(join(tmpdir(),'distribution-service-')),store=new MetadataStore(':memory:'),businessStore=new BusinessQueryStore(join(root,'business.sqlite')),c=getContext(id),metadata=distributionMetadataForContext(id),run={id:'synthetic-release-run',releaseId:'synthetic-release',packageDigest:'a'.repeat(64),status:'SUCCEEDED',published:true,schedulerTriggered:true,publicDeployed:false,mainSqlExecuted:true,engine:'Apache Spark',engineVersion:'3.5.9',testSqlValidation:{passed:true},validation:{passed:true},rows:c.expected};
 const manager=new DataServiceManager({store,businessStore,project:'synthetic-project',releaseRunFor:()=>run,distributionSourceFor:()=>({outputContractId:metadata.id,sourceEvidence:{modelClassification:'SYNTHETIC_UPSTREAM',engineClassification:'TEST_HARNESS',agentIndependentE2E:false}})});
 t.after(()=>{businessStore.close();store.close();rmSync(root,{recursive:true,force:true});});
 async function dapi(slug,fields){const s=manager.createDapi({name:'合成分布查询 '+slug,slug,sourceReleaseRunId:run.id,fields});await manager.test(s.id);manager.publish(s.id);return manager.detail(s.id);}
 return{manager,store,businessStore,c,metadata,run,dapi,root};
}
test('distribution snapshots have immutable composite keys, exact decimal strings and stable row pagination across reopening',t=>{
 const f=fixture(t),id='snapshot:distribution';const first=f.businessStore.materialize(id,f.c.expected,'2026-09-10',f.metadata.id);
 assert.equal(first.rowCount,3);assert.equal(f.businessStore.snapshotEvidence(id).integrityVerified,true);
 const rows=[1,2,3].flatMap(page=>f.businessStore.queryAssets(id,{page,pageSize:1}).rows);
 assert.deepEqual(rows.map(r=>[r.client_id,r.asset_class]),[['CLIENT-001','债券'],['CLIENT-001','股票'],['CLIENT-002','股票']]);assert.equal(new Set(rows.map(r=>JSON.stringify([r.client_id,r.trade_date,r.asset_class]))).size,3);
 assert.equal(f.businessStore.queryAssets(id,{clientId:'CLIENT-003'}).rows.length,0);
 const reopened=new BusinessQueryStore(join(f.root,'business.sqlite'));assert.equal(reopened.snapshotEvidence(id).contentHash,first.contentHash);assert.equal(reopened.queryAssets(id,{page:2,pageSize:1}).rows[0].market_value_ratio,'0.666667');reopened.close();
 assert.throws(()=>f.businessStore.materialize(id,[{...f.c.expected[0],market_value_ratio:'0.000000'},...f.c.expected.slice(1)],'2026-09-10',f.metadata.id));
});
test('source rows reject duplicate keys, extra fields, bad precision/ranges and hidden identifiers; missing snapshot data never passes integrity',t=>{
 const f=fixture(t);
 for(const change of [r=>r.push({...r[0]}),r=>r[0].market_value_ratio='0.6666671',r=>r[0].market_value_ratio=true,r=>r[0].market_value_ratio='1.1',r=>r[0].available_cash='300.00',r=>r[0].security_count='1.5']){const rows=structuredClone(f.c.expected);change(rows);assert.throws(()=>normalizedDistributionRows(rows,f.metadata.id));}
 f.businessStore.materialize('snapshot:broken',f.c.expected,'2026-09-10',f.metadata.id);f.businessStore.db.prepare('UPDATE service_distribution_snapshots SET rows_json=? WHERE snapshot_id=?').run('[]','snapshot:broken');assert.equal(f.businessStore.snapshotEvidence('snapshot:broken').integrityVerified,false);
});
test('DAPI projections retain all grain keys and XAPI paginates whole customer arrays instead of overwriting or truncating category rows',async t=>{
 const f=fixture(t),a=await f.dapi('group-values',['holding_market_value','security_count']),b=await f.dapi('group-ratios',['market_value_ratio']);
 assert.deepEqual(a.currentVersion.fields,['client_id','trade_date','asset_class','holding_market_value','security_count']);assert.equal(serviceVersionConfigValid(a.currentVersion),true);
 const x=f.manager.createXapi({name:'合成客户持仓配置组合',slug:'group-composite',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]});
 const first=(await f.manager.test(x.id,{page:1,pageSize:1})).response,second=(await f.manager.test(x.id,{page:2,pageSize:1})).response;
 assert.equal(first.pagination.total,2);assert.equal(first.data[0].client_id,'CLIENT-001');assert.equal(first.data[0].distributions.length,2);assert.equal(first.data[0].distributions[0].allocation.market_value_ratio,'0.333333');assert.equal(second.data[0].client_id,'CLIENT-002');assert.equal(second.data[0].distributions.length,1);assert.equal(first.resultContract.paginationUnit,'CLIENT_DATE_GROUPS');assert.equal(first.sourceEvidence.children[0].modelClassification,'SYNTHETIC_UPSTREAM');
});
test('application grants, revocation and call evidence use the same real SQLite distribution result',async t=>{
 const f=fixture(t),s=await f.dapi('authorized-groups',['market_value_ratio']),other=await f.dapi('ungranted-groups',['holding_market_value']);
 const app=f.manager.createApplication({name:'合成只读分布调用方',serviceIds:[s.id]});
 const token=app.token??app.credential;
 assert.equal(typeof token,'string');const value=await f.manager.invoke('DAPI',s.slug,'Bearer '+token,{page:1,page_size:1});assert.equal(value.data.length,1);assert.equal(value.scope,'LOCAL_TEST_ONLY');
 await assert.rejects(f.manager.invoke('DAPI',other.slug,'Bearer '+token,{}),e=>e.status===403);
 f.manager.revokeApplication(app.application.id);await assert.rejects(f.manager.invoke('DAPI',s.slug,'Bearer '+token,{}),e=>e.status===401);assert(f.manager.listCalls(s.id).some(c=>c.resultHash));
});

test('industry distribution uses its registered grain and rejects mixed batches/contracts and implicit legacy grain switches',async t=>{
 const f=fixture(t,'holdings-industry-t1'),a=await f.dapi('industry-values',['holding_market_value']),b=await f.dapi('industry-ratios',['market_value_ratio']);
 const x=f.manager.createXapi({name:'行业分布组合',slug:'industry-overview',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]});
 const result=await f.manager.test(x.id);assert.equal(result.response.data[0].distributions[0].industry!==undefined,true);assert.equal(result.response.data[0].distributions[0].asset_class,undefined);
 assert.throws(()=>f.manager.createDapiVersion(a.id,{sourceReleaseRunId:f.run.id,fields:['available_cash']}));
 const changed=f.manager.createDapiVersion(a.id,{sourceReleaseRunId:f.run.id,fields:['market_value_ratio']});assert(changed.fields.includes('industry'));await f.manager.test(a.id);f.manager.publish(a.id);
 assert.equal(f.manager.detail(x.id).currentVersion.steps[0].dapiVersionId,a.currentVersion.id,'XAPI retains frozen child version');
 const oldSnapshot=f.businessStore.snapshotEvidence(a.currentVersion.snapshotId);assert.equal(oldSnapshot.integrityVerified,true);
 const original=f.store.get('data_service_version',b.currentVersion.id,'synthetic-project');assert(original);
 f.store.update('data_service_version',original.id,'synthetic-project',{sourceReleaseRunId:'another-batch'});
 assert.throws(()=>f.manager.createXapi({name:'错批次组合',slug:'wrong-batch',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]}));
});

test('XAPI pulls every bounded child page before grouping and fails on incomplete or mismatched groups',async t=>{
 const f=fixture(t),a=await f.dapi('paged-values',['holding_market_value']),b=await f.dapi('paged-ratios',['market_value_ratio']);
 const x=f.manager.createXapi({name:'分页分布组合',slug:'paged-distribution',steps:[{alias:'holdings',dapiId:a.id},{alias:'allocation',dapiId:b.id}]});
 const execute=f.manager.executeDapi;
 f.manager.executeDapi=async(version,query)=>{const result=await execute(version,query);return version.id===b.currentVersion.id?{...result,rows:result.rows.slice(1)}:result;};
 await assert.rejects(f.manager.test(x.id),e=>e.code==='INVALID_RESULT');
 f.manager.executeDapi=async(version,query)=>{const result=await execute(version,query);return{...result,pagination:{...result.pagination,total:1001}};};
 await assert.rejects(f.manager.test(x.id),e=>e.code==='INVALID_RESULT');
});
