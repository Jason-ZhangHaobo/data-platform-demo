import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID,createHash} from 'node:crypto';
import ts from 'typescript';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {getContext,referenceSql} from '../../src/v2/context.mjs';import {appendSqlClarification} from '../../src/v2/sql-clarification-snapshot.mjs';
import {clarificationAttribution,clarificationReplyReason} from '../../src/v2/sql-clarification-contract.mjs';import {sqlRequirementReport,bindSqlRequirementRevision} from '../../src/v2/sql-requirements.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';
async function component(name){let source=ts.transpileModule(readFileSync(`web/src/${name}.tsx`,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const dependency of ['react','react/jsx-runtime','lucide-react','../../src/v2/sql-requirement-contract.mjs','../../src/v2/output-contract-metadata.mjs','../../src/v2/fund-requirement-contract.mjs'])source=source.replaceAll(`from '${dependency}'`,`from ${JSON.stringify(import.meta.resolve(dependency))}`).replaceAll(`from "${dependency}"`,`from ${JSON.stringify(import.meta.resolve(dependency))}`);
 return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[name];}
const AgentClarificationReply=await component('AgentClarificationReply'),AgentRequirementUnderstanding=await component('AgentRequirementUnderstanding');
test('reply form is explicit, bounded and disabled in readonly/busy scope; rendering never submits or enables background silently',()=>{
 let replies=0,backgroundChanges=0;const props={answer:'先计算五项',disabled:false,onChange:()=>{},onReply:()=>{replies++;},background:{checked:false,onChange:()=>{backgroundChanges++;}}};
 const tree=AgentClarificationReply(props),html=renderToStaticMarkup(tree);assert.equal(replies,0);assert.equal(backgroundChanges,0);
 assert.match(html,/提交答复并继续开发/);assert.match(html,/maxLength="1000"/);assert.match(html,/不计直接自主完成/);assert.match(html,/type="checkbox"/);
 tree.props.onSubmit({preventDefault(){}});assert.equal(replies,1);
 AgentClarificationReply({...props,disabled:true}).props.onSubmit({preventDefault(){}});AgentClarificationReply({...props,answer:' '}).props.onSubmit({preventDefault(){}});assert.equal(replies,1);
 const readonly=renderToStaticMarkup(React.createElement(AgentClarificationReply,{...props,disabled:true}));assert.match(readonly,/disabled=""/);
});
test('current and frozen requirement views preserve original request/questions/answers and distinguish historical token occupancy',()=>{
 const parent={id:randomUUID(),message:'虚构证券原需求 <img src=x onerror=unsafe>',contextId:'holdings-t1',usedTokens:20,attempts:[{usageEstimated:false}]};
 const source={binding:{evidenceDigest:'a'.repeat(64)},sql:referenceSql,question:'先按当前五项指标计算？'},c=appendSqlClarification(parent,source,'是'),ctx=getContext();
 const task={id:randomUUID(),message:'是',contextId:ctx.id,initialSql:referenceSql,sql:referenceSql,revisionId:randomUUID(),clarification:c,...clarificationAttribution({clarification:c}),attempts:[{attempt:1,model:'TEST_DOUBLE'}]};
 task.attempts[0].revisionId=task.revisionId;task.requirements=bindSqlRequirementRevision(sqlRequirementReport({task,message:task.message,context:ctx,generated:{model:'TEST_DOUBLE',...syntheticSqlRequirement({message:task.message,context:ctx,clarification:c})},attempt:1}),{id:task.revisionId,hash:createHash('sha256').update(referenceSql).digest('hex')});
 for(const frozen of [false,true]){
  const html=renderToStaticMarkup(React.createElement(AgentRequirementUnderstanding,{task,dirty:false,frozen}));
  assert.match(html,/原需求与1轮问答/);assert.match(html,/历史占用 20 Token/);assert.match(html,/先按当前五项指标计算/);assert.match(html,/不计直接自主完成/);assert.match(html,/查看原任务/);
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/&lt;img/);
 }
});
test('unavailable source kinds, missing original input and exhausted question depth do not offer a misleading reply action',()=>{
 const root={stage:'REQUIREMENT_CLARIFICATION_REQUIRED',initialSql:referenceSql};assert.equal(clarificationReplyReason(root),undefined);
 for(const patch of [{sourceKind:'MANUAL'},{derivedFrom:{}},{initialSql:undefined},{clarification:{depth:3}}])assert.equal(typeof clarificationReplyReason({...root,...patch}),'string');
});
