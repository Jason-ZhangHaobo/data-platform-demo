import test from "node:test";
import assert from "node:assert/strict";
import {createScopedWorkbenchApi, workbenchSessionScope} from "../../web/src/workbench-session-boundary.ts";
import {createAssetReader} from "../../web/src/asset-read.ts";

const engineer = {authenticated:true,user:{id:"fictional-engineer"},role:"ENGINEER",permissions:["DELIVERY","ASSETS"]};
const scope = session => workbenchSessionScope("PUBLIC_INVITATION",session);
const deferred = () => { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; };

test("effective identity changes on same-user role and scoped target changes, but equivalent grants keep the view",()=>{
  assert.equal(scope(engineer),scope({...engineer,permissions:["ASSETS","DELIVERY","DELIVERY"]}));
  for(const variation of [
    {user:{id:"another-engineer"}},{role:"VIEWER",permissions:["SESSION"]},{readOnly:true},
    {developmentTaskOnly:true,developmentTaskId:"original-task"},
    {publicationOnly:true,publicationPackageDigest:"different"},
    {consumptionOnly:true,consumptionPilotId:"different"},
    {expiresAt:"2026-11-11T10:00:00.000Z"},{authenticated:false,user:undefined},
  ]) assert.notEqual(scope(engineer),scope({...engineer,...variation}));
});

test("prior scope reads, errors and chained writes are discarded across an account or grant change",async()=>{
  for (const reject of [false,true]) {
    let generation=1,writes=0,failures=0;
    const waiting=deferred();
    const api=createScopedWorkbenchApi((path,body)=>{if(body!==undefined)writes++;return waiting.promise;},1,()=>generation,()=>{failures++;});
    const result=api("/delivery/packages");
    const stopped=assert.rejects(result,{code:"WORKBENCH_SESSION_CHANGED"});
    generation=2;
    if(reject)waiting.reject(Object.assign(Error("old private response"),{status:401}));
    else waiting.resolve({files:["old private response"]});
    await stopped;
    await assert.rejects(api("/revisions",{}),{code:"WORKBENCH_SESSION_CHANGED"});
    assert.equal(writes,0);assert.equal(failures,0);
  }
});

test("scope verification blocks new business writes and rechecks only current authentication or permission failures",async()=>{
  let mayWrite=false;
  const requests=[],rechecks=[];
  const api=createScopedWorkbenchApi(async(path,body)=>{
    requests.push({path,body});
    if(path==="/runs/old")throw Object.assign(Error("denied"),{status:403,code:"DEVELOPMENT_ACCESS_DENIED"});
    if(path==="/assets/missing")throw Object.assign(Error("missing"),{status:404});
    if(path==="/auth/login")throw Object.assign(Error("invalid"),{status:401});
    return {};
  },1,()=>1,kind=>rechecks.push(kind),()=>mayWrite);
  await assert.rejects(api("/runs",{}),/核对当前会话/);
  assert.deepEqual(requests,[]);
  await assert.rejects(api("/runs/old"),/denied/);
  await assert.rejects(api("/assets/missing"),/missing/);
  await assert.rejects(api("/auth/login",{}),/invalid/);
  assert.deepEqual(rechecks,["SCOPE"]);
  mayWrite=true;
  await api("/runs",{});
  assert.equal(requests.at(-1).path,"/runs");
});

test("a revoked asset is removed from the visible cache while a transient failure can retain its verified version",async()=>{
  let error;
  const detail=[];
  const reader=createAssetReader({api:async()=>{if(error)throw error;return {id:"fixture:positions",description:"fictional original"};},
    validAsset:()=>true,validDetail:()=>true,onCatalog(){},onDetail:value=>detail.push(value)});
  await reader.select("fixture:positions");
  error=Error("network unavailable");
  await reader.refreshDetail();
  assert.equal(detail.at(-1).value.description,"fictional original");
  error=Object.assign(Error("revoked"),{status:403});
  await reader.refreshDetail();
  assert.equal(detail.at(-1).state,"ERROR");
  assert.equal(detail.at(-1).value,undefined);
  error=Error("still unavailable");
  await reader.refreshDetail();
  assert.equal(detail.at(-1).value,undefined);
});
