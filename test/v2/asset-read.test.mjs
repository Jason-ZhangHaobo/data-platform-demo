import test from "node:test";
import assert from "node:assert/strict";
import { createAssetReader, assetSummaryValid, assetDetailValid, annotationKey, annotationDirty, annotationTags, annotationReceiptMatches, reconcileAnnotation, rebaseAnnotation } from "../../web/src/asset-read.ts";

const asset = (id="fixture:positions", patch={}) => ({id,kind:"FIXTURE_TABLE",name:id,businessName:"虚构持仓",system:"证券实验室",domain:"财富管理",description:"虚构证券持仓说明",status:"READY",fields:[],tags:["持仓"],evidenceHash:"a".repeat(64),executableMetrics:false,...patch});
const detail = (id="fixture:positions", patch={}) => ({...asset(id),lineage:{focusAssetId:id,nodes:[asset(id)],edges:[]},metrics:[],standards:[],...patch});
const deferred = () => {let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
function fixture(api, initialId) { const catalogs=[],details=[],calls=[]; const reader=createAssetReader({api:(...args)=>{calls.push(args);return api(...args);},initialId,validAsset:assetSummaryValid,validDetail:assetDetailValid,onCatalog:value=>catalogs.push(value),onDetail:value=>details.push(value)});return{reader,catalogs,details,calls}; }
const normal = async path => path.startsWith("/assets/fixture:") ? detail(path.slice("/assets/".length)) : path.startsWith("/assets?") || path==="/assets" ? [asset()] : [];

test("one search reads exactly one catalog group and one canonical detail, with no mutation",async()=>{
 const f=fixture(normal);assert.equal(await f.reader.search({query:" 持仓 ",kind:"FIXTURE_TABLE"}),true);await Promise.resolve();
 assert.deepEqual(f.calls.map(args=>args[0]),["/assets?q=%E6%8C%81%E4%BB%93&kind=FIXTURE_TABLE","/metrics","/standards","/assets/agent/tasks","/assets/fixture:positions"]);
 assert(f.calls.every(args=>args.length===1));assert.deepEqual(f.catalogs.at(-1).criteria,{query:"持仓",kind:"FIXTURE_TABLE"});assert.equal(f.details.at(-1).state,"READY");
});
test("repeated identical in-flight searches share the original read group",async()=>{
 const gate=deferred(),f=fixture(path=>path.startsWith("/assets?")?gate.promise:Promise.resolve([]));
 const first=f.reader.search({query:"same",kind:""}),second=f.reader.search({query:" same ",kind:""});assert.equal(f.calls.length,4);gate.resolve([]);assert.equal(await first,true);assert.equal(await second,true);assert.equal(f.details.at(-1).state,"EMPTY");
});
test("late list responses and failures cannot replace a newer applied query",async()=>{
 const gate=deferred(),f=fixture(path=>path==="/assets?q=old"?gate.promise:normal(path));
 const old=f.reader.search({query:"old",kind:""});await f.reader.search({query:"new",kind:""});gate.reject(Error("旧查询失败"));assert.equal(await old,false);assert.equal(f.catalogs.at(-1).criteria.query,"new");assert.equal(f.catalogs.at(-1).state,"READY");
});
test("a late detail cannot overwrite a newer explicit selection",async()=>{
 const gate=deferred(),f=fixture(path=>path==="/assets/fixture:old"?gate.promise:normal(path));const old=f.reader.select("fixture:old");await f.reader.select("fixture:new");gate.resolve(detail("fixture:old"));assert.equal(await old,false);assert.equal(f.details.at(-1).value.id,"fixture:new");
});
test("a citation chosen during search is retained outside the filtered result",async()=>{
 const gate=deferred(),f=fixture(path=>path==="/assets?q=filter"?gate.promise:normal(path));const pending=f.reader.search({query:"filter",kind:""});await f.reader.select("fixture:cash");gate.resolve([asset()]);await pending;assert.equal(f.details.at(-1).value.id,"fixture:cash");assert.equal(f.calls.filter(args=>args[0]==="/assets/fixture:cash").length,1);
});
test("empty success clears an old selection; failures never masquerade as empty",async()=>{
 let mode="data";const f=fixture(async path=>{if(path==="/assets"){if(mode==="error")throw Object.assign(Error("请登录"),{status:401});if(mode==="empty")return [];}return normal(path);});
 await f.reader.search();mode="error";assert.equal(await f.reader.search(),false);assert.equal(f.catalogs.at(-1).state,"ERROR");assert.equal(f.catalogs.at(-1).loginRequired,true);assert.equal(f.catalogs.at(-1).assets,undefined);mode="empty";await f.reader.search();assert.equal(f.details.at(-1).state,"EMPTY");
});
test("an explicit initial target is read once and never falls back to another asset",async()=>{
 const f=fixture(async path=>{if(path==="/assets/fixture:missing")throw Object.assign(Error("不可见"),{status:404});return normal(path);},"fixture:missing");await f.reader.search();await Promise.resolve();assert.equal(f.details.at(-1).id,"fixture:missing");assert.equal(f.details.at(-1).state,"ERROR");assert.equal(f.calls.filter(args=>args[0]==="/assets/fixture:positions").length,0);
});
test("initial detail restoration is independent of a synchronously failed catalog",async()=>{
 const f=fixture(path=>{if(path==="/assets")throw Error("目录失败");return normal(path);},"fixture:positions");assert.equal(await f.reader.search(),false);await Promise.resolve();assert.equal(f.details.at(-1).state,"READY");assert.equal(f.catalogs.at(-1).state,"ERROR");
});
test("mismatched detail identity cannot replace the last confirmed snapshot",async()=>{
 let invalid=false;const f=fixture(async path=>invalid?detail("fixture:foreign"):normal(path));await f.reader.select("fixture:positions");invalid=true;await f.reader.refreshDetail();assert.equal(f.details.at(-1).state,"ERROR");assert.equal(f.details.at(-1).value.id,"fixture:positions");
});
test("malformed collections stay unknown and closed readers suppress late callbacks",async()=>{
 const bad=fixture(async()=>null);assert.equal(await bad.reader.search(),false);assert.equal(bad.catalogs.at(-1).state,"ERROR");const gate=deferred(),f=fixture(()=>gate.promise);const pending=f.reader.search();f.reader.close();assert.equal(await f.reader.search(),false);gate.resolve([]);await pending;assert.equal(f.catalogs.length,1);assert.equal(f.details.length,0);
});
test("detail validation binds identity, lineage and snapshot structure",()=>{
 assert.equal(assetDetailValid(detail(),"fixture:positions"),true);
 for(const value of [detail("fixture:other"),detail(undefined,{lineage:{focusAssetId:"fixture:other",nodes:[],edges:[]}}),detail(undefined,{evidenceHash:"bad"}),detail(undefined,{tags:null}),detail(undefined,{annotation:{revision:-1}})])assert.equal(assetDetailValid(value,"fixture:positions"),false);
});
test("dirty annotation survives rereads and exposes a changed read baseline",()=>{
 const base=detail(),draft=reconcileAnnotation(undefined,base);draft.values={...draft.values,businessName:"本页新名称"};const latest=detail(undefined,{businessName:"另一读入名称",annotation:{revision:1}});const kept=reconcileAnnotation(draft,latest);assert.equal(kept,draft);assert.equal(kept.values.businessName,"本页新名称");assert.notEqual(kept.key,annotationKey(latest));assert(annotationDirty(kept));
});
test("explicit rebase preserves only user edits and adopts untouched server fields",()=>{
 const draft=reconcileAnnotation(undefined,detail());draft.values={...draft.values,description:"本页新说明"};const latest=detail(undefined,{owner:"虚构新负责人",tags:["新标签"],annotation:{revision:2}});const rebased=rebaseAnnotation(draft,latest);assert.equal(rebased.values.description,"本页新说明");assert.equal(rebased.values.owner,"虚构新负责人");assert.equal(rebased.values.tagText,"新标签");assert.equal(rebased.revision,2);assert.equal(rebased.key,annotationKey(latest));assert.throws(()=>rebaseAnnotation(draft,detail("fixture:other")),/不一致/);
});
test("separate asset drafts remain independent; clean rereads adopt new values",()=>{
 const first=reconcileAnnotation(undefined,detail()),second=reconcileAnnotation(undefined,detail("fixture:cash"));first.values={...first.values,domain:"虚构资管"};const map=new Map([[first.assetId,first],[second.assetId,second]]);assert.equal(reconcileAnnotation(map.get(first.assetId),detail()).values.domain,"虚构资管");assert.equal(reconcileAnnotation(second,detail("fixture:cash",{owner:"新负责人"})).values.owner,"新负责人");assert.equal(reconcileAnnotation(first,detail("fixture:cash")).assetId,"fixture:cash");
});
test("an unconfirmed cached read cannot downgrade a saved baseline",()=>{
 const saved=detail(undefined,{annotation:{revision:2},businessName:"已保存名称"}),draft=reconcileAnnotation(undefined,saved);
 const retained=reconcileAnnotation(draft,detail(),false);assert.equal(retained.key,annotationKey(saved));assert.equal(retained.values.businessName,"已保存名称");
});
test("untouched comma-containing tags round-trip; explicit edits and clears are confirmed",()=>{
 const source=detail(undefined,{tags:["组合,报表","证券"]}),draft=reconcileAnnotation(undefined,source);draft.values={...draft.values,businessName:" 新名称 "};
 assert.deepEqual(annotationTags(draft),["组合,报表","证券"]);assert(annotationReceiptMatches({...source,businessName:"新名称",annotation:{revision:1}},draft));
 draft.values={...draft.values,tagText:""};assert.deepEqual(annotationTags(draft),[]);assert(annotationReceiptMatches({...source,businessName:"新名称",tags:[],annotation:{revision:1}},draft));assert.equal(annotationReceiptMatches({...source,businessName:"新名称",annotation:{revision:1}},draft),false);
});
test("a confirmed mutation receipt supersedes in-flight old reads without retargeting selection",async()=>{
 const gate=deferred();let hold=false;const catalogs=[],details=[];
 const reader=createAssetReader({api:path=>hold&&path==='/assets/fixture:positions'?gate.promise:normal(path),validAsset:assetSummaryValid,validDetail:assetDetailValid,isOlder:(value,known)=>(value.annotation?.revision??0)<(known.annotation?.revision??0),onCatalog:value=>catalogs.push(value),onDetail:value=>details.push(value)});
 await reader.select('fixture:positions');hold=true;const old=reader.refreshDetail();const saved=detail(undefined,{annotation:{revision:2},businessName:'已保存'});assert(reader.confirmDetail('fixture:positions',saved));gate.resolve(detail());assert.equal(await old,false);assert.equal(details.at(-1).value.annotation.revision,2);
 hold=false;await reader.refreshDetail();assert.equal(details.at(-1).state,'ERROR');assert.equal(details.at(-1).value.annotation.revision,2);
 await reader.select('fixture:cash');const before=details.length;assert(reader.confirmDetail('fixture:positions',detail(undefined,{annotation:{revision:3}})));assert.equal(details.length,before);assert.equal(details.at(-1).id,'fixture:cash');assert.equal(reader.confirmDetail('fixture:cash',saved),false);
});
