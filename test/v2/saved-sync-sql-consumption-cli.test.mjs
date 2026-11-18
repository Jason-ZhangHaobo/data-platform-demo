import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";

test("offline consumption handoff needs both original databases and does not accept report or quality flags", t=>{
  const dir=mkdtempSync(join(tmpdir(),"shuduo-consumption-cli-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=name=>join(dir,name);
  new MetadataStore(path("metadata.sqlite")).close();
  new BusinessQueryStore(path("business.sqlite")).close();
  writeFileSync(path("positions.csv"),"fictional");
  writeFileSync(path("package.json"),"{}");
  const minimal=["--metadata",path("metadata.sqlite"),"--business-snapshots",path("business.sqlite"),
    "--source-csv",path("positions.csv"),"--package-file",path("package.json"),"--release-id","12345678-1234-1234-1234-123456789001",
    "--package-digest","a".repeat(64),"--agent-request-id","original-request"];
  const run=(...args)=>{
    const result=spawnSync(process.execPath,["scripts/verify-saved-sync-sql-lifecycle.mjs",...args],{encoding:"utf8",timeout:10000});
    assert.equal(result.status,1);
    assert.equal(result.stdout,"");
    return JSON.parse(result.stderr).code;
  };
  assert.equal(run("--consumption-only",...minimal),"SYNC_SAVED_RECORD_MISSING");
  assert.equal(run(...minimal),"SYNC_SAVED_ARGUMENTS_REQUIRED");
  assert.equal(run("--consumption-only",...minimal,"--verify-quality"),"SYNC_SAVED_ARGUMENTS_REQUIRED");
  assert.equal(run("--consumption-only",...minimal,"--lineage",path("lineage.json")),"SYNC_SAVED_ARGUMENTS_REQUIRED");
});
