import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createDeliveryPackage} from '../../src/v2/delivery.mjs';
import {comparePublicationFiles} from '../../src/v2/publication-file-comparison.mjs';
import {requirementDeliverySource} from './fixtures/requirement-delivery.mjs';

function archived(t,contextId,project='project-securities-lab'){
  const store=new MetadataStore(':memory:');t.after(()=>store.close());
  const source=requirementDeliverySource(store,project,{contextId});
  return {...createDeliveryPackage(source),id:randomUUID()};
}

test('local review compares all eight original files and identifies precisely which contents changed',async t=>{
  const prior=archived(t,'holdings-t1'),current=archived(t,'stock-cash-t1');
  const same=await comparePublicationFiles(prior,prior);
  assert.equal(same.files.length,8);
  assert.ok(same.files.every(file=>!file.changed));
  const {id,...portable}=prior;
  assert.equal((await comparePublicationFiles(portable,current)).baseline.packageDigest,prior.digest);
  const result=await comparePublicationFiles(prior,current,{baselineDigest:prior.digest,currentDigest:current.digest});
  assert.equal(result.baseline.revisionId,prior.manifest.source.revisionId);
  assert.equal(result.current.runId,current.manifest.source.runId);
  assert.deepEqual(result.files.filter(item=>item.changed).map(item=>item.name).sort(),
    Object.keys(current.files).filter(name=>current.files[name]!==prior.files[name]).sort());
  assert.equal(result.files.find(item=>item.name==='main.sql').changed,true);
  const dir=mkdtempSync(join(tmpdir(),'package-review-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const first=join(dir,'before.json'),second=join(dir,'after.json');
  writeFileSync(first,JSON.stringify(prior));writeFileSync(second,JSON.stringify(current));
  const cli=JSON.parse(execFileSync(process.execPath,['bin/shuduo-package.mjs','compare',second,'--baseline',first,
    '--baseline-digest',prior.digest,'--digest',current.digest],{encoding:'utf8'}));
  assert.deepEqual(cli,result);
});

test('corrupt package bytes, unrelated projects and stale reviewer digests cannot become a comparison',async t=>{
  const current=archived(t,'cash-change'),foreign=archived(t,'cash-change','other-project');
  const edited=structuredClone(current);edited.files['deployment.json']+=' ';
  await assert.rejects(comparePublicationFiles(edited,current),/未能核对/);
  await assert.rejects(comparePublicationFiles(current,edited),/未能核对/);
  await assert.rejects(comparePublicationFiles(foreign,current),/同一项目/);
  await assert.rejects(comparePublicationFiles(current,current,{baselineDigest:'0'.repeat(64)}),/未能核对/);
});
