import {createHash} from 'node:crypto';
import {getContext} from './context.mjs';
import {sqlConditionReferences,unavailableSqlConditionReferences} from './sql-condition-references.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const identifier=v=>typeof v==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(v);
export const sqlLineageSchemaHash=context=>hash({tables:context.tables.map(t=>({name:t.name,columns:t.columns}))});

// Read saved code/analysis only; never execute or reconstruct an old fingerprint.
export function storedRunSqlColumnLineage({run,revision,assetId='run:'+run.id}){
 const unavailable=reason=>({assetId,runId:run.id,status:'UNAVAILABLE',analysis:'STATIC_VALUE_DEPENDENCIES',rowSetImpactAnalyzed:false,fields:[],reason});
 const saved=run.columnLineage;if(!saved)return unavailable('此运行尚未保存字段值来源分析，不按新代码补造历史');
 try{
  if(!revision||run.revisionId!==revision.id||run.revisionHash!==revision.hash||revision.hash!==hash(revision.sql)||run.contextId!==revision.contextId||run.engine!=='Apache Spark'||!['SUCCEEDED','VALIDATION_FAILED'].includes(run.status)||run.mainSqlExecuted!==true)throw Error('SOURCE_MISMATCH');
  const context=getContext(revision.contextId),schema=new Map(context.tables.map(t=>[t.name,new Set(t.columns.map(c=>c[0]))])),outputs=run.columns?.map(c=>Array.isArray(c)?c[0]:c.name);
  if(saved.protocol!=='shuduo-sql-value-lineage/v1'||saved.analysis!=='STATIC_VALUE_DEPENDENCIES'||saved.rowSetImpactAnalyzed!==false||saved.dialect!=='spark'||saved.parser!=='sqlglot'||typeof saved.parserVersion!=='string'||saved.parserVersion.length>40||saved.sourceSqlHash!==revision.hash||saved.contextId!==revision.contextId||saved.schemaHash!==sqlLineageSchemaHash(context)||!['COMPLETE','PARTIAL','UNAVAILABLE'].includes(saved.status)||!Array.isArray(outputs)||outputs.length>200||!outputs.length||new Set(outputs).size!==outputs.length||outputs.some(x=>!identifier(x))||!Array.isArray(saved.fields))throw Error('BINDING_MISMATCH');
  if(saved.status==='UNAVAILABLE'){if(saved.fields.length)throw Error('INCONSISTENT_FIELDS');return unavailable('原SQL或结构的静态分析未完成，不能据此声称字段来源已确认');}
  if(saved.fields.length!==outputs.length||saved.fields.some((f,i)=>!f||f.target!==outputs[i]||!['RESOLVED','CONSTANT','UNRESOLVED'].includes(f.status)||typeof f.expression!=='string'||f.expression.length>1000||!Array.isArray(f.sources)||f.sources.length>150||f.sources.some(s=>!s||!schema.get(s.table)?.has(s.column))||new Set(f.sources.map(s=>s.table+'.'+s.column)).size!==f.sources.length||f.status==='RESOLVED'&&!f.sources.length||f.status==='CONSTANT'&&f.sources.length||f.reason!==undefined&&typeof f.reason!=='string'))throw Error('INVALID_FIELDS');
  if((saved.status==='COMPLETE')!==saved.fields.every(f=>['RESOLVED','CONSTANT'].includes(f.status)))throw Error('INCONSISTENT_COMPLETENESS');
  const binding={sourceSqlHash:revision.hash,schemaHash:saved.schemaHash,tables:context.tables},conditions=saved.conditionReferences===undefined?undefined:sqlConditionReferences(saved.conditionReferences,binding)??unavailableSqlConditionReferences(binding);
  return{assetId,runId:run.id,revisionId:revision.id,sourceSqlHash:revision.hash,schemaHash:saved.schemaHash,status:saved.status,analysis:saved.analysis,rowSetImpactAnalyzed:false,parser:saved.parser,parserVersion:saved.parserVersion,fields:saved.fields.map(f=>({target:f.target,status:f.status,expression:f.expression,sources:f.sources.map(s=>({table:s.table,column:s.column})),...(f.reason?{reason:f.reason.slice(0,300)}:{})})),...(conditions?{conditionReferences:conditions}:{}),notice:'静态值来源与条件引用，不替代Spark执行、独立断言或完整语义影响分析'};
 }catch{return unavailable('分析与原代码、结构或输出字段不一致，未采用其他版本的来源');}
}

export function publishedSqlColumnLineage({store,project,run,assetId='dataset:customer_assets_t1'}){
 const unavailable=reason=>({assetId,runId:run.id,status:'UNAVAILABLE',analysis:'STATIC_VALUE_DEPENDENCIES',rowSetImpactAnalyzed:false,fields:[],reason});
 if(!run.columnLineage)return unavailable('此发布批次尚未保存字段值来源分析；保留版本绑定血缘，不按新代码补造历史');
 const release=store.get('release',run.releaseId,project),source=run.source,revision=source&&store.get('revision',source.revisionId,project);
 if(run.status!=='SUCCEEDED'||!run.published||!run.schedulerTriggered||!run.validation?.passed||!run.testSqlValidation?.passed||!release||release.sourceRevisionId!==source?.revisionId||!revision||source.sqlHash!==revision.hash||source.contextId!==revision.contextId||(release.sourceCodeHash??release.sourceSqlHash)!==revision.hash||run.revisionId!==undefined&&run.revisionId!==revision.id||run.revisionHash!==undefined&&run.revisionHash!==revision.hash||run.contextId!==undefined&&run.contextId!==revision.contextId)return unavailable('分析与原发布代码、结构或输出字段不一致，未采用其他版本的字段来源');
 return storedRunSqlColumnLineage({run:{...run,revisionId:revision.id,revisionHash:revision.hash,contextId:revision.contextId},revision,assetId});
}
