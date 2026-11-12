#!/usr/bin/env node
import { submitFundPreparation, readFundPreparation, executeFundPreparation, readFundExecutionPreflight } from "../src/v2/fund-preparation-client.mjs";
import { recheckFundRehearsal } from "../src/v2/fund-rehearsal-recheck.mjs";
import { assetResourcePath } from "../src/v2/asset-resource-path.mjs";
import { submitAssetAnnotation, readAssetAnnotationRequest } from "../src/v2/asset-annotation-client.mjs";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { V2Client, V2_OPERATIONS } from "../src/v2/client.mjs";
import{readSqlRunComparison,readRunComparisonCandidates}from'../src/v2/run-comparison-client.mjs';
import {submitPublishedReport,lookupPublishedReport,resumePublishedReport,readPublishedReportResult,readPublishedReportLineage,readPublishedReportDevelopment,readPublishedReportConsumption} from '../src/v2/published-report-client.mjs';
import {readReportProvenance,checkedReportProvenance} from '../src/v2/report-provenance-client.mjs';
import { readFundReportQuality, runFundReportQuality } from '../src/v2/fund-report-quality-client.mjs';
import { readWealthConsumption } from '../src/v2/wealth-report-consumption-client.mjs';
import {checkedPrivateBatchReport, readPrivateBatchSummary} from "../src/v2/private-batch-report-client.mjs";
import {checkedBatchArchive, prepareBatchArchive, readBatchArchive, submitBatchArchive} from "../src/v2/private-batch-archive-client.mjs";
import{submitServiceGateWrite,lookupServiceGateWrite}from'../src/v2/service-contract-gate-client.mjs';
import {agentReviewEvidencePath,publicationSelectorInput,publicationPreflightPath,publicationReadPath} from "../src/v2/publication-request.mjs";
import {readCloudV3Review} from "../src/v2/cloud-v3-review.mjs";
import {advanceCloudV3Rehearsal,bindCloudV3Consumption,continueCloudV3Start,exportCloudV3PublicationReview,exportCloudV3SourceReview,inspectCloudV3Execution,prepareCloudV3Delivery,prepareCloudV3Start,rebindCloudV3PreparedSource,submitCloudV3Publication} from "../scripts/start-cloud-v3-case.mjs";
import {firstCloudCheckpointBinding} from "../scripts/first-cloud-v3-window.mjs";
import {agentExecutionEvidencePath} from "../src/v2/agent-execution-evidence.mjs";
import {serviceSourceReadPath} from "../src/v2/service-source-request.mjs";
import {createContextDerivedTask} from "../src/v2/agent-derivation-client.mjs";
import {readRepairComparisonBasis,createComparisonRepairTask} from '../src/v2/repair-comparison-client.mjs';
import {readManualDeliveryWorkflow,prepareManualDelivery} from '../src/v2/manual-delivery-client.mjs';
import {readAssistedContinuation,createAssistedContinuation} from '../src/v2/assisted-continuation-client.mjs';
import {readManualContinuation,createManualContinuation} from '../src/v2/manual-continuation-client.mjs';
import {readSqlClarification,createSqlClarification} from '../src/v2/sql-clarification-client.mjs';
import {readStandaloneWorkflow,readStandaloneDetail,prepareStandaloneManual,mutateStandaloneManual} from '../src/v2/standalone-manual-client.mjs';
import {readStandalonePublication,publishStandaloneManual,cancelStandalonePublication} from '../src/v2/standalone-manual-publication-client.mjs';
import {callServicePlan} from '../src/v2/service-plan-client.mjs';
import {readServiceAgentContext} from '../src/v2/service-agent-context-client.mjs';

const HELP = `数舵 V2 CLI · 与GUI/MCP共用 /api/v2

用法：
  shuduo agent clarification --id TASK_ID
  shuduo agent clarify --id TASK_ID --evidence-digest SHA256 --answer "对原问题的回答" --request-id UUID --confirm
  shuduo status
  shuduo sql compare-candidates --run-id RUN_ID
  shuduo sql compare-runs --run-id RUN_ID --baseline-run-id RUN_ID
  shuduo budget
  shuduo manual publication --source-run-id RUN_ID --id MANUAL_DELIVERY_ID --package-digest SHA256 --verification-id ID [--release-id ID]
  shuduo manual publish --source-run-id RUN_ID --id MANUAL_DELIVERY_ID --package-digest SHA256 --verification-id ID --file REVIEW_JSON --request-id UUID --confirm
  shuduo manual stop-publication --source-run-id RUN_ID --id MANUAL_DELIVERY_ID --package-digest SHA256 --verification-id ID --release-id ID --confirm
    发布仅在确切版本的有效独立窗口内允许；REVIEW_JSON含人工逐项attestations，不自动批准或安装定时器。
  shuduo manual workflow --source-run-id RUN_ID
  shuduo manual prepare --source-run-id RUN_ID --request-id UUID --confirm
  shuduo manual detail --source-run-id RUN_ID --id MANUAL_DELIVERY_ID
  shuduo manual advance|cancel --source-run-id RUN_ID --id MANUAL_DELIVERY_ID --version N --confirm
    独立手工文件与演练不调用模型、不创建Agent、不发布。未知回执先读取workflow/detail，保留原编号。
  shuduo agent intents
  shuduo agent prepare-fund --context-id ID --trade-date YYYY-MM-DD --message "需求" --metrics FIELD_LIST --request-id UUID
  shuduo agent fund-preparation --request-id UUID
  shuduo agent execute-fund --request-id UUID --basis-digest SHA256 --confirm
  shuduo agent fund-execution-preflight --task-id UUID --request-id UUID --revision-id UUID --run-id UUID --basis-digest SHA256
  shuduo agent tools
  shuduo agent validate-tool --tool MODULE_ID --catalog-version VERSION --contract-digest SHA256 --input-json '{"message":"任务目标"}'
  shuduo agent invoke-tool --id INTENT_ID --tool MODULE_ID --approval-id APPROVAL_ID --catalog-version VERSION --contract-digest SHA256 --input-json '{"message":"已批准目标"}'
  shuduo agent understand --message "理解需求并推荐中台模块"
  shuduo agent approvals --id INTENT_ID
  shuduo agent approve --id INTENT_ID --destination MODULE_ID
  shuduo agent graph --id INTENT_ID
  shuduo agent cancel-intent --id INTENT_ID
  shuduo agent cancel-child --id INTENT_ID --destination MODULE_ID
  shuduo agent handoffs --id INTENT_ID
  shuduo agent handoff --id INTENT_ID --destination MODULE_ID
  shuduo agent trace --id INTENT_ID
  shuduo agent journey --id AGENT_TASK_ID
  shuduo agent review-evidence --id AGENT_TASK_ID --delivery-id ID --request-sha256 SHA256
  shuduo agent execution-evidence --request-id ORIGINAL_REQUEST_ID
  shuduo agent v3-inspect --checkpoint ABSOLUTE_PATH
  shuduo agent v3-prepare-delivery --checkpoint ABSOLUTE_PATH --bill-file ABSOLUTE_PATH --confirm
  shuduo agent v3-rehearse --checkpoint ABSOLUTE_PATH --bill-file ABSOLUTE_PATH --confirm
  shuduo agent v3-rehearse --checkpoint ABSOLUTE_PATH --settle
  shuduo agent v3-publication-review --checkpoint ABSOLUTE_PATH --out-file ABSOLUTE_PATH
  shuduo agent v3-publish --checkpoint ABSOLUTE_PATH --review-file ABSOLUTE_PATH --bill-file ABSOLUTE_PATH --confirm
  shuduo agent v3-publish --checkpoint ABSOLUTE_PATH --reconcile
  shuduo agent v3-consumption --checkpoint ABSOLUTE_PATH --batch-id ID --out-file ABSOLUTE_PATH
  shuduo agent v3-consumption --checkpoint ABSOLUTE_PATH --plan ABSOLUTE_PATH --call-id-digest SHA256
  shuduo agent v3-review --checkpoint ABSOLUTE_PATH
  shuduo agent v3-start --checkpoint ABSOLUTE_PATH --source-revision SHA
  shuduo agent v3-start --checkpoint ABSOLUTE_PATH --window-binding
  shuduo agent v3-start --checkpoint ABSOLUTE_PATH --window-file ABSOLUTE_PATH --application-file ABSOLUTE_PATH --bill-file ABSOLUTE_PATH --confirm
  shuduo agent v3-start --checkpoint ABSOLUTE_PATH --reconcile
  shuduo agent v3-rebind-source --checkpoint ABSOLUTE_PATH --source-revision SHA --out-file ABSOLUTE_PATH
  shuduo agent v3-rebind-source --checkpoint ABSOLUTE_PATH --review-file ABSOLUTE_PATH --review-digest SHA256
  shuduo agent workflow --id AGENT_TASK_ID
  shuduo agent request --request-id ORIGINAL_REQUEST_ID
  shuduo agent manual-continuation --source-run-id RUN_ID
  shuduo agent continue-manual --source-run-id RUN_ID --message "优化已核验的手工SQL" --request-id UUID --confirm
  shuduo agent continuation --id TASK_ID
  shuduo agent continue-version --id TASK_ID --message "基于成功版本继续修改" --request-id UUID --confirm
  shuduo agent repair-basis --source-run-id FAILED_RUN_ID --baseline-run-id SUCCEEDED_RUN_ID
  shuduo agent repair-compare --source-run-id FAILED_RUN_ID --baseline-run-id SUCCEEDED_RUN_ID --message "参考基线修正" --request-id UUID --confirm
  shuduo agent derive --task-id TASK_ID --revision-id REVISION_ID --run-id RUN_ID --revision-hash SHA256 --context stock-cash-t1 --message "改为股票持仓和现金口径" --request-id UUID --confirm
    从原成功版本创建独立任务，可能执行模型与Spark；原批准不继承。未知结果先用 agent request 查询，不换请求编号重试。
  shuduo services task-evidence [--task-id AGENT_TASK_ID | --manual-delivery-task-id MANUAL_DELIVERY_ID] --package-digest SHA256 [--release-id RELEASE_ID [--call-id-digest SHA256]]
  shuduo agent deliveries [--source-id AGENT_TASK_ID]
  shuduo agent prepare-delivery --id AGENT_TASK_ID
  shuduo agent prepare-delivery --id TASK_ID --source-kind MANUAL --source-run-id RUN_ID --request-id UUID --confirm
  shuduo agent delivery --id DELIVERY_TASK_ID
  shuduo agent recheck-delivery-receipt --id DELIVERY_TASK_ID --version CURRENT_VERSION
  shuduo agent advance-delivery --id DELIVERY_TASK_ID --version CURRENT_VERSION
  shuduo agent background --id TASK_ID
  shuduo agent enable-background --id TASK_ID --version CURRENT_VERSION --confirm
  shuduo agent resume-background --id TASK_ID --version CURRENT_VERSION --confirm [--confirm-model-retry]
  shuduo agent stop-background --id TASK_ID --confirm
  shuduo agent publication --id AGENT_TASK_ID [--source-kind AGENT|MANUAL --source-run-id RUN_ID --package-digest SHA256 --verification-id ID --release-id ID]
  shuduo agent publication-preflight --id AGENT_TASK_ID --source-kind AGENT --source-run-id RUN_ID --package-digest SHA256 --verification-id ID
  shuduo agent publish --id AGENT_TASK_ID --file REVIEW_JSON [--source-kind MANUAL --source-run-id RUN_ID --package-digest SHA256 --verification-id ID --request-id ORIGINAL_REQUEST_ID]
  shuduo agent stop-publication --id AGENT_TASK_ID [--source-kind MANUAL --source-run-id RUN_ID --package-digest SHA256 --verification-id ID --release-id ID]
    人工来源必须指定运行、包摘要和演练；停止还须指定发布编号。四项审阅来自 REVIEW_JSON，不自动批准或重试；发布重试沿用 --request-id。
  shuduo agent cancel-delivery --id DELIVERY_TASK_ID
  shuduo python revisions
  shuduo python create --context holdings-t1 --file transform.py
  shuduo python runs
  shuduo python run --id REVISION_ID
  shuduo python show --id RUN_ID
  shuduo python cancel --id RUN_ID
  shuduo release-runs list
  shuduo delivery packages
  shuduo delivery show --id PACKAGE_ID
  shuduo delivery create --source-run-id RUN_ID --name "客户资产 T+1"
  shuduo delivery verify --id PACKAGE_ID --scheduled-for 2026-09-11T09:00:00+08:00
  shuduo delivery verifications
  shuduo delivery verification --id VERIFICATION_ID
  shuduo delivery cancel --id VERIFICATION_ID
  shuduo delivery reviews
  shuduo delivery review --id PACKAGE_ID --package-digest SHA256 --verification-id VERIFICATION_ID --note "已核对" --attest-code --attest-assertions --attest-delivery-files --attest-local-scope
  分布批准/回滚需 --distribution-consent 已审阅确认JSON文件；读取不自动确认。
  shuduo releases approvals
  shuduo releases approve --package-id PACKAGE_ID --package-digest SHA256 --review-id REVIEW_ID
  基金 Agent 本机批准和激活使用 --fund-consent 已明确确认的预检JSON文件。
  shuduo releases list
  shuduo releases show --id RELEASE_ID
  shuduo releases publish --approval-id APPROVAL_ID [--trigger-after-seconds 5 --interval-seconds 15 --run-count 2]
  shuduo releases cancel --id RELEASE_ID --package-digest SHA256
  shuduo releases rollback --id RELEASE_ID --target-release-id RELEASE_ID --reason "恢复稳定版本"
  shuduo releases monitor
  shuduo services list [--type dapi|xapi]
  shuduo services plan --message "生成当前发布批次的持仓DAPI" --request-id UUID [--task-id UUID | --manual-delivery-task-id UUID] --package-digest SHA256 --release-id UUID --source-run-id UUID
  shuduo services plans [--task-id UUID | --manual-delivery-task-id UUID] --package-digest SHA256 --release-id UUID --source-run-id UUID
  shuduo services plan-context [--task-id UUID | --manual-delivery-task-id UUID] --package-digest SHA256 --release-id UUID --source-run-id UUID
  shuduo services plan-detail|apply-plan|cancel-plan --id PLAN_UUID
  shuduo services plan-request --request-id ORIGINAL_UUID
  shuduo services advance-plan --id PLAN_UUID --expected-version N [--confirm-model-retry true]
    规划可能调用付费模型；应用仅创建原方案草稿，不测试、发布或发凭证。未知结果先查询原编号。
  shuduo services create-dapi --name 名称 --slug path --source-run-id ID [--fields a,b]
  shuduo services create-xapi --name 名称 --slug path --steps alias:DAPI_ID,alias:DAPI_ID
  shuduo services test --type dapi|xapi --id ID [--client-id CLIENT-001 | --portfolio-id ID --trade-date YYYY-MM-DD --asset-class 类别] [--page N --page-size N]
  shuduo services publish --type dapi|xapi --id ID [--config-hash SHA256]
  shuduo services sources [--agent-task-id ID | --manual-delivery-task-id ID] [--package-digest SHA256 --release-id RELEASE_ID]
  shuduo services openapi --type dapi|xapi --id ID
  shuduo services recovery --type dapi|xapi --id ID
  shuduo services show|history --type dapi|xapi --id ID
  shuduo services new-version --type dapi|xapi --id ID [--source-run-id ID] [--fields client_id,total_assets] [--rate-limit 60] [--timeout 1500]
  shuduo services activate --type dapi|xapi --id ID --version-id VERSION --expected-version LIVE_VERSION --config-hash SHA256 --request-id KEY --confirm
  shuduo services calls [--id ID]
  shuduo services invoke --type dapi|xapi --slug path [--client-id CLIENT-001 | --portfolio-id ID --trade-date YYYY-MM-DD --asset-class 类别] [--page N --page-size N]
  shuduo apps list
  shuduo apps create --name 名称 --service-ids ID,ID
  shuduo apps revoke --id ID
  shuduo sources list
  shuduo sources create --name 名称 --file positions_baseline.csv
  shuduo sources create-server-mysql --name 名称 --table synthetic_positions
  shuduo sources test|metadata --id ID
  shuduo sources revision --id ID --file positions_schema_change.csv
  shuduo sync list
  shuduo sync create --name 名称 --source-id ID --target-table raw_positions --mode full|incremental --mapping from:to,... --keys position_id [--watermark trade_date]
  shuduo sync run --id ID
  shuduo sync rows --table raw_positions
  shuduo sync plan --message "同步需求"
  shuduo sync apply-plan --id PLAN_ID
  shuduo streams sources
  shuduo streams create-source --name 名称 --topic market.quotes.demo --file quotes_fault.jsonl
  shuduo streams revision --source-id ID --file quotes_recovered.jsonl
  shuduo streams jobs
  shuduo streams create-job --name 名称 --source-id ID --target-table realtime_quotes [--checkpoint-every 2] [--max-out-of-order-seconds 2]
  shuduo streams start|stop --id JOB_ID
  shuduo streams recover --id JOB_ID --revision-id REVISION_ID
  shuduo streams state|checkpoints --id JOB_ID
  shuduo streams monitor
  shuduo streams plan --message "实时同步需求"
  shuduo streams plans
  shuduo streams apply-plan --id PLAN_ID
  shuduo assets list [--query 持仓] [--kind LANDING_TABLE]
  shuduo assets show|lineage|impact --id ASSET_ID
  shuduo assets annotate --id ASSET_ID --business-name 名称 --description 说明 --domain 财富管理 --owner 负责人 [--tags 持仓,T+1]
  shuduo assets annotation-submit --id ASSET_ID --file 完整标注请求.json
  shuduo assets annotation-request --id ASSET_ID --request-id UUID
  shuduo assets agent --message "找出持仓市值资产并解释来源"
  shuduo assets agents
  shuduo contracts list
  shuduo contracts show --id CONTRACT_ID
  shuduo contracts create --name 名称 --code positions_contract --asset-id landing:raw_positions --compatibility BACKWARD --owner 负责人 --description "契约说明"
  shuduo contracts assess-current --id CONTRACT_ID
  shuduo contracts apply-version --id CONTRACT_ID --assessment-id ASSESSMENT_ID [--acknowledge-breaking]
  shuduo contracts check --id CONTRACT_ID
  shuduo contracts service-gates --service-id SERVICE_ID [--version-id VERSION_ID]
  shuduo contracts bind-service --service-id SERVICE_ID --file binding.json --request-id UUID
  shuduo contracts gate-version --service-id SERVICE_ID --binding-id BINDING_ID --file change.json --request-id UUID
  shuduo contracts gate-request --service-id SERVICE_ID --request-id UUID
  shuduo metrics list
  shuduo metrics create --name 持仓市值 --code holding_market_value --asset-id landing:raw_positions --aggregation SUM --field market_value --group-by asset_class --definition "按资产类别汇总持仓，不含现金"
  shuduo metrics run --id METRIC_ID
  shuduo standards list
  shuduo standards create --name 证券代码格式 --code security_code_format --asset-id landing:raw_positions --field security_code --semantic-type SECURITY_CODE --description "使用SEC前缀"
  shuduo standards check --id STANDARD_ID
  shuduo quality overview|list
  shuduo quality create --name 名称 --code holding_value_range --asset-id landing:raw_positions --field market_value --type value-range --min 0.00 --max 5000.00 --description "持仓市值范围"
  shuduo quality version --id RULE_ID --type value-range --min 0.00 --max 10000.00 --description "校准范围"
  shuduo quality run --id RULE_ID
  shuduo quality plan --message "为证券代码生成非空规则"
  shuduo quality plans
  shuduo quality apply-plan --id PLAN_ID
  shuduo security overview|personas|policies|requests|audits
  shuduo security create-policy --name 名称 --code advisor_positions --asset-id landing:raw_positions --roles WEALTH_ADVISOR --row-scope ADVISOR_CLIENTS --actions position_id:MASK_FULL,client_id:MASK_PARTIAL,security_code:ALLOW,market_value:ALLOW --description "顾问最小权限"
  shuduo security version --id POLICY_ID --roles WEALTH_ADVISOR --row-scope ADVISOR_CLIENTS --actions client_id:HASH,security_code:ALLOW --description "策略V2"
  shuduo security query --asset-id landing:raw_positions --actor-id user-wealth-advisor
  shuduo security request --asset-id landing:raw_positions --scope READ_MASKED --reason "安全验收" --actor-id user-auditor
  shuduo security review --id REQUEST_ID --decision APPROVE --duration-hours 24 --note "仅限合成数据" --actor-id user-data-owner
  shuduo security plan --message "为财富顾问生成持仓最小权限策略"
  shuduo security plans
  shuduo security apply-plan --id PLAN_ID
  shuduo reports overview|datasets|list
  shuduo reports create-dataset --name 名称 --code holdings_dataset --asset-id landing:raw_positions --fields client_id,security_code,asset_class,industry,market_value,trade_date
  shuduo reports result|lineage|development|consumption --request-id UUID [--source-file published-source.json]
  shuduo reports quality --request-id UUID
  shuduo reports quality-run --request-id UUID --snapshot-id UUID --basis-digest SHA256 --confirm
  shuduo reports from-publication --name 财富顾问报告 --source-file published-source.json --request-id UUID
  shuduo reports clarification --id PLAN_ID
  shuduo reports clarify --id PLAN_ID --evidence-digest SHA256 --answer "回答" --request-id UUID
  shuduo reports resume-plan --id PLAN_ID
  shuduo reports request --request-id UUID
  shuduo reports resume --id CREATION_ID
  shuduo reports refresh-dataset --id DATASET_ID
  shuduo reports create --name 持仓结构报告 --code holdings_structure --dataset-id DATASET_ID --preset holdings --description "持仓指标与分布"
  shuduo reports version --id REPORT_ID --preset holdings --description "报表V2"
  shuduo reports run|export --id REPORT_ID
  shuduo reports provenance --id REPORT_ID --run-id RUN_ID
  shuduo reports wealth-consumption --id REPORT_ID --run-id RUN_ID
  shuduo reports verify-provenance --file evidence.json
  shuduo reports batch-summary --source-file source.json [--download-digest SHA256 --out-file batch.json]
  shuduo reports verify-batch-summary --file batch.json
  shuduo reports prepare-batch-archive --file draft.json
  shuduo reports archive-batch --file reviewed.json --request-id UUID --confirm
  shuduo reports batch-archive --request-id UUID [--download-digest SHA256 --out-file archive.json]
  shuduo reports verify-batch-archive --file archive.json
  shuduo reports plan --message "生成持仓结构报告"
  shuduo reports plans
  shuduo reports apply-plan --id PLAN_ID
  shuduo ops overview|refresh|incidents
  shuduo ops show --id INCIDENT_ID
  shuduo ops acknowledge --id INCIDENT_ID --note "已确认"
  shuduo ops resolve --id INCIDENT_ID --evidence-kind offline_sync_run --evidence-id RUN_ID --note "新批次已成功"
  shuduo ops diagnose --message "诊断当前事故"
  shuduo ops diagnoses
  shuduo evaluations full-lifecycle

环境变量：
  SHUDUO_V2_API_BASE_URL  默认 http://127.0.0.1:3100/api/v2
  SHUDUO_APP_TOKEN        调用已发布服务；不建议通过命令参数传递令牌

旧 dataplatform 命令仍对应V1模拟接口，不能作为V2验收证据。`;

function parse(argv) {
  const positionals = [],
    options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll("-", "_") ,
      next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else options[key] = true;
  }
  return { positionals, options };
}
const required = (options, key) => {
  if (typeof options[key] !== "string" || !options[key].trim())
    throw new Error(`缺少 --${key.replaceAll("_", "-")}`);
  return options[key].trim();
};
const jsonObject = (value, name) => {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name}必须是JSON对象`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${name}必须是JSON对象`);
  return parsed;
};
const publicationCliFields={source_kind:"sourceKind",source_run_id:"sourceRunId",package_digest:"packageDigest",verification_id:"verificationId",release_id:"releaseId"};
function publicationCliOptions(argv,options,action){
  const allowed=new Set(["id","base_url","help",...Object.keys(publicationCliFields),...(action==="publish"?["file","request_id"]:[])]),seen=new Set();
  for(const token of argv.filter(value=>value.startsWith("--"))){
    const key=token.slice(2).replaceAll("-","_");
    if(!allowed.has(key)||seen.has(key))throw Error("发布命令包含未知或重复参数；不能指定执行者或覆盖审阅范围");
    seen.add(key);
  }
  const selected={};for(const [flag,key]of Object.entries(publicationCliFields))if(Object.hasOwn(options,flag))selected[key]=options[flag];
  return selected;
}
function reviewedPublication(input){
  if(!input||typeof input!=="object"||Array.isArray(input))throw Error("发布审阅必须为JSON对象");
  const {attestations,...selector}=input;
  const required=["code","assertions","deliveryFiles","cloudScope"];
  if(!attestations||typeof attestations!=="object"||Array.isArray(attestations)||Object.keys(attestations).length!==required.length||!required.every(key=>attestations[key]===true))throw Error("必须逐项确认代码、断言、交付文件和云端测试范围，不自动代批");
  const selected=publicationSelectorInput(selector);
  if(!selected.packageDigest||!selected.verificationId||selected.releaseId)throw Error("发布必须绑定包摘要和演练，不能提供已有发布编号");
  return {...selected,attestations:Object.fromEntries(required.map(key=>[key,true]))};
}
function serviceQueryOptions(options) {
  const flags = ["client_id", "portfolio_id", "trade_date", "asset_class", "page", "page_size"];
  return Object.fromEntries(flags.filter(flag => options[flag] !== undefined).map(flag => [flag, required(options, flag)]));
}
function serviceReadCliOptions(argv,options,action){
  const taskFlag=action==='sources'?'agent_task_id':'task_id',fields={[taskFlag]:'agentTaskId',manual_delivery_task_id:'manualDeliveryTaskId',package_digest:'packageDigest',release_id:'releaseId',...(action==='task-evidence'?{call_id_digest:'callIdDigest'}:{})},
    allowed=new Set(['base_url','help',...Object.keys(fields)]),seen=new Set();
  for(const token of argv.filter(value=>value.startsWith('--'))){
    const key=token.slice(2).replaceAll('-','_');
    if(!allowed.has(key)||seen.has(key))throw Error('来源读取命令包含未知或重复参数，不允许覆盖执行者或回退其他结果');
    seen.add(key);
  }
  return Object.fromEntries(Object.entries(fields).filter(([key])=>Object.hasOwn(options,key)).map(([key,name])=>[name,options[key]]));
}
const typePath = (value) => {
  if (!['dapi', 'xapi'].includes(value)) throw new Error("--type必须是dapi或xapi");
  return value + "s";
};
const list = (value, name) => {
  const items = required({ value }, "value")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length || new Set(items).size !== items.length)
    throw new Error(`${name}不能为空或重复`);
  return items;
};
const steps = (value) =>
  list(value, "--steps").map((item) => {
    const separator = item.indexOf(":");
    if (separator < 1 || separator === item.length - 1)
      throw new Error("--steps格式为alias:DAPI_ID,alias:DAPI_ID");
    return { alias: item.slice(0, separator), dapiId: item.slice(separator + 1) };
  });
const mapping = (value) =>
  Object.fromEntries(
    list(value, "--mapping").map((item) => {
      const separator = item.indexOf(":");
      if (separator < 1 || separator === item.length - 1)
        throw new Error("--mapping格式为源字段:目标字段,源字段:目标字段");
      return [item.slice(0, separator), item.slice(separator + 1)];
    }),
  );
const qualityType = (value) => {
  const normalized = required({ value }, "value").replaceAll("-", "_").toUpperCase();
  if (
    ![
      "NOT_NULL",
      "UNIQUE",
      "VALUE_RANGE",
      "ALLOWED_VALUES",
      "FRESHNESS_SECONDS",
    ].includes(normalized)
  )
    throw new Error("--type不受支持");
  return normalized;
};
const qualityConfig = (options, type) => {
  if (["NOT_NULL", "UNIQUE"].includes(type)) return {};
  if (type === "VALUE_RANGE")
    return {
      min: required(options, "min"),
      max: required(options, "max"),
    };
  if (type === "ALLOWED_VALUES")
    return { values: list(required(options, "values"), "--values") };
  return {
    maxAgeSeconds: Number(required(options, "max_age_seconds")),
  };
};
const reportWidgets = (preset) => {
  if (preset === "holdings")
    return [
      { id: "holding_value", type: "KPI", title: "持仓市值", aggregation: "SUM", field: "market_value" },
      { id: "security_count", type: "KPI", title: "证券数量", aggregation: "COUNT_DISTINCT", field: "security_code" },
      { id: "asset_class_distribution", type: "PIE", title: "资产类别分布", aggregation: "SUM", field: "market_value", dimension: "asset_class" },
      { id: "industry_distribution", type: "BAR", title: "行业分布", aggregation: "SUM", field: "market_value", dimension: "industry" },
    ];
  if (preset === "customer-assets")
    return [
      { id: "total_assets", type: "KPI", title: "客户总资产", aggregation: "SUM", field: "total_assets" },
      { id: "client_assets", type: "BAR", title: "客户资产分布", aggregation: "SUM", field: "total_assets", dimension: "client_id" },
    ];
  throw new Error("--preset必须是holdings或customer-assets");
};

export const V2_CLI_OPERATIONS = Object.freeze([...V2_OPERATIONS]);

function validateManualDeliveryFlags(parsed,argv){
  const keys=['source_kind','source_run_id','request_id','confirm'];
  if(!keys.some(k=>parsed.options[k]!==undefined))return;
  if(!['AGENT','MANUAL'].includes(parsed.options.source_kind)||parsed.options.source_kind!=='MANUAL'&&keys.slice(1).some(k=>parsed.options[k]!==undefined))throw Error('人工辅助交付需明确 MANUAL 来源，不混用其他来源参数');
  const allowed=new Set(['id','source_kind','source_run_id','request_id','confirm','base_url','help']),seen=new Set();
  if(parsed.positionals.length!==2)throw Error('交付命令包含额外参数');
  for(const token of argv.filter(v=>v.startsWith('--'))){const k=token.slice(2).replaceAll('-','_');if(!allowed.has(k)||seen.has(k))throw Error('交付命令包含未知或重复参数');seen.add(k);}
}
export async function runV2Cli(argv, env = process.env, options = {}) {
  const parsed = parse(argv),
    [resource, action] = parsed.positionals,
    out = options.output ?? console.log,
    err = options.error ?? console.error,
    client =
      options.client ??
      new V2Client({
        baseUrl:
          parsed.options.base_url ??
          env.SHUDUO_V2_API_BASE_URL ??
          "http://127.0.0.1:3100/api/v2",
        client: "cli",
        sessionFile: env.SHUDUO_V2_SESSION_FILE,
      });
  try {
    if (!resource || resource === "help" || parsed.options.help) {
      out(HELP);
      return 0;
    }
    let result;
    if(resource==='manual'&&['publication','publish','stop-publication'].includes(action)){
      const common=['source_run_id','id','package_digest','verification_id'],fields=action==='publication'?[...common,'release_id']:action==='publish'?[...common,'request_id','file','confirm']:[...common,'release_id','confirm'],allowed=new Set([...fields,'base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('手工发布命令包含额外参数');for(const token of argv.filter(v=>v.startsWith('--'))){const flag=token.slice(2).replaceAll('-','_');if(!allowed.has(flag)||seen.has(flag))throw Error('手工发布命令包含未知或重复参数');seen.add(flag);}
      const selected={sourceRunId:required(parsed.options,'source_run_id'),taskId:required(parsed.options,'id'),packageDigest:required(parsed.options,'package_digest'),verificationId:required(parsed.options,'verification_id'),...(parsed.options.release_id?{releaseId:parsed.options.release_id}:{})};
      if(action==='publish'){const review=jsonObject(readFileSync(required(parsed.options,'file'),'utf8'),'审阅文件');if(Object.keys(review).length!==1||!review.attestations)throw Error('审阅文件仅接受逐项attestations，不自动填写批准');result=await publishStandaloneManual(client,{...selected,requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm,attestations:review.attestations});}
      else result=action==='publication'?await readStandalonePublication(client,selected):await cancelStandalonePublication(client,{...selected,confirm:parsed.options.confirm});
    }
    else if(resource==='manual'&&['workflow','prepare','detail','advance','cancel'].includes(action)){
      const fields=action==='workflow'?['source_run_id']:action==='prepare'?['source_run_id','request_id','confirm']:action==='detail'?['source_run_id','id']:['source_run_id','id','version','confirm'],allowed=new Set([...fields,'base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('手工交付命令包含额外参数');
      for(const token of argv.filter(v=>v.startsWith('--'))){const flag=token.slice(2).replaceAll('-','_');if(!allowed.has(flag)||seen.has(flag))throw Error('手工交付命令包含未知或重复参数');seen.add(flag);}
      const sourceRunId=required(parsed.options,'source_run_id');
      if(['advance','cancel'].includes(action)&&parsed.options.confirm!==true)throw Error('须明确确认本次演练或停止操作');
      result=action==='workflow'?await readStandaloneWorkflow(client,{sourceRunId}):action==='prepare'?await prepareStandaloneManual(client,{sourceRunId,requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm}):action==='detail'?await readStandaloneDetail(client,{sourceRunId,taskId:required(parsed.options,'id')}):await mutateStandaloneManual(client,{sourceRunId,taskId:required(parsed.options,'id'),expectedVersion:Number(required(parsed.options,'version')),operation:action,confirm:true});
    }
    else if (resource === "status") result = await client.request("/status");
    else if(resource==='sql'&&action==='compare-candidates')result=await readRunComparisonCandidates(client,{runId:required(parsed.options,'run_id')});
    else if(resource==='sql'&&action==='compare-runs')result=await readSqlRunComparison(client,{runId:required(parsed.options,'run_id'),baselineRunId:required(parsed.options,'baseline_run_id')});
    else if (resource === "budget" && !action)
      result = await client.request("/budget");
    else if(resource==='services'&&['plan','plans','plan-context','plan-detail','plan-request','apply-plan','cancel-plan','advance-plan'].includes(action)){
      const sourceFlags=['task_id','manual_delivery_task_id','package_digest','release_id','source_run_id'],fields=action==='plan'?['message','request_id',...sourceFlags]:['plans','plan-context'].includes(action)?sourceFlags:action==='advance-plan'?['id','expected_version','confirm_model_retry']:action==='plan-request'?['request_id']:['id'],
        allowed=new Set([...fields,'base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('规划命令包含额外参数');
      for(const token of argv.filter(value=>value.startsWith('--'))){const key=token.slice(2).replaceAll('-','_');if(!allowed.has(key)||seen.has(key))throw Error('规划命令包含未知或重复参数');seen.add(key);}
      if(parsed.options.manual_delivery_task_id!==undefined&&parsed.options.task_id!==undefined)throw Error('任务与独立手工来源不能混用');
      const sourceBinding=['plan','plans','plan-context'].includes(action)?{...(parsed.options.manual_delivery_task_id!==undefined?{manualDeliveryTaskId:required(parsed.options,'manual_delivery_task_id')}:{taskId:required(parsed.options,'task_id')}),packageDigest:required(parsed.options,'package_digest'),releaseId:required(parsed.options,'release_id'),sourceReleaseRunId:required(parsed.options,'source_run_id')}:undefined;
      const operation={plan:'create',plans:'list','plan-detail':'detail','plan-request':'request','apply-plan':'apply','cancel-plan':'cancel','advance-plan':'advance'}[action];
      if(action==='advance-plan'&&parsed.options.confirm_model_retry!==undefined&&!['true','false'].includes(parsed.options.confirm_model_retry))throw Error('confirm-model-retry必须显式为true或false');
      result=action==='plan-context'?await readServiceAgentContext(client,{sourceBinding}):await callServicePlan(client,operation,action==='plan'?{sourceBinding,message:required(parsed.options,'message'),requestId:required(parsed.options,'request_id')}:action==='plans'?{sourceBinding}:
        action==='plan-request'?{requestId:required(parsed.options,'request_id')}:action==='advance-plan'?{planId:required(parsed.options,'id'),expectedVersion:Number(required(parsed.options,'expected_version')),
          ...(parsed.options.confirm_model_retry===undefined?{}:{confirmModelRetry:parsed.options.confirm_model_retry==='true'})}:{planId:required(parsed.options,'id')});
    }
    else if (resource === "agent" && action === "prepare-fund")
      result = await submitFundPreparation(client, { contextId: required(parsed.options, "context_id"),
        businessDate: required(parsed.options, "trade_date"), message: required(parsed.options, "message"),
        metrics: list(required(parsed.options, "metrics"), "--metrics") }, required(parsed.options, "request_id"));
    else if (resource === "agent" && action === "fund-preparation")
      result = await readFundPreparation(client, required(parsed.options, "request_id"));
    else if (resource === "agent" && action === "execute-fund")
      result = await executeFundPreparation(client, { requestId: required(parsed.options, "request_id"),
        basisDigest: required(parsed.options, "basis_digest"), confirm: parsed.options.confirm === true });
    else if (resource === "agent" && action === "fund-execution-preflight")
      result = await readFundExecutionPreflight(client, { taskId: required(parsed.options, "task_id"),
        requestId: required(parsed.options, "request_id"), revisionId: required(parsed.options, "revision_id"),
        runId: required(parsed.options, "run_id"), basisDigest: required(parsed.options, "basis_digest") });
    else if (resource === "agent" && action === "intents")
      result = await client.request("/agent/intents");
    else if (resource === "agent" && action === "tools")
      result = await client.request("/agent/tools");
    else if (resource === "agent" && action === "validate-tool")
      result = await client.request(
        `/agent/tools/${encodeURIComponent(required(parsed.options, "tool"))}/validate`,
        {
          method: "POST",
          body: {
            catalogVersion: required(parsed.options, "catalog_version"),
            contractDigest: required(parsed.options, "contract_digest"),
            input: jsonObject(
              required(parsed.options, "input_json"),
              "--input-json",
            ),
          },
        },
      );
    else if (resource === "agent" && action === "invoke-tool") {
      const intentId = required(parsed.options, "id"),
        toolId = required(parsed.options, "tool");
      result = await client.request(
        `/agent/intents/${encodeURIComponent(intentId)}/tools/${encodeURIComponent(toolId)}/invoke`,
        {
          method: "POST",
          body: {
            catalogVersion: required(parsed.options, "catalog_version"),
            contractDigest: required(parsed.options, "contract_digest"),
            approvalId: required(parsed.options, "approval_id"),
            input: jsonObject(
              required(parsed.options, "input_json"),
              "--input-json",
            ),
          },
        },
      );
    }
    else if (resource === "agent" && action === "understand")
      result = await client.request("/agent/intents", {
        method: "POST",
        body: { message: required(parsed.options, "message"),...(parsed.options.report_source_file?{reportSource:jsonObject(readFileSync(parsed.options.report_source_file,'utf8'),'报表发布上下文')}:{}) },
      });
    else if (resource === "agent" && action === "approvals")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/approvals`,
      );
    else if (resource === "agent" && action === "approve")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/approvals`,
        {
          method: "POST",
          body: { destinationId: required(parsed.options, "destination") },
        },
      );
    else if (resource === "agent" && action === "graph")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/graph`,
      );
    else if (resource === "agent" && action === "cancel-intent")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "agent" && action === "cancel-child")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/children/${encodeURIComponent(required(parsed.options, "destination"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "agent" && action === "handoffs")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/handoffs`,
      );
    else if (resource === "agent" && action === "handoff")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/handoffs`,
        {
          method: "POST",
          body: { destinationId: required(parsed.options, "destination") },
        },
      );
    else if (resource === "agent" && action === "trace")
      result = await client.request(
        `/agent/intents/${encodeURIComponent(required(parsed.options, "id"))}/trace`,
      );
    else if (resource === "agent" && action === "journey")
      result = await client.request(
        `/agent/tasks/${encodeURIComponent(required(parsed.options, "id"))}/journey`,
      );
    else if (resource === "agent" && action === "review-evidence")
      result = await client.request(agentReviewEvidencePath({taskId:required(parsed.options,"id"),
        deliveryId:required(parsed.options,"delivery_id"),requestSha256:required(parsed.options,"request_sha256")}));
    else if (resource === "agent" && action === "execution-evidence")
      result = await client.request(agentExecutionEvidencePath(required(parsed.options,"request_id")));
    else if (resource === "agent" && ["v3-review","v3-inspect"].includes(action)) {
      const flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      if(parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
         flags.some(flag=>!["checkpoint","base_url"].includes(flag)))throw Error("评测证据读取仅接受原检查点和原入口");
      const checkpoint=required(parsed.options,"checkpoint");
      result=await (action==="v3-review"?readCloudV3Review:inspectCloudV3Execution)(checkpoint,client);
    }
    else if (resource === "agent" && action === "v3-start") {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      const mode=Object.hasOwn(args,"reconcile")?"reconcile":Object.hasOwn(args,"confirm")?"confirm":Object.hasOwn(args,"window_binding")?"window_binding":"prepare";
      const allowed=["checkpoint","base_url",...(mode==="reconcile"?["reconcile"]:mode==="confirm"?["confirm","bill_file","window_file","application_file"]:
        mode==="window_binding"?["window_binding"]:["source_revision"])];
      if(parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
         flags.some(flag=>!allowed.includes(flag)) || (mode!=="prepare" && args[mode]!==true))
        throw Error("首例启动仅接受准备、导出窗口绑定、明确提交或原回执对账的一种操作");
      const checkpoint=required(args,"checkpoint");
      result=mode==="prepare"?prepareCloudV3Start(checkpoint,client,required(args,"source_revision")):
        mode==="window_binding"?firstCloudCheckpointBinding(checkpoint):
          await continueCloudV3Start(checkpoint,client,mode==="reconcile"?{reconcile:true}:{billPath:required(args,"bill_file"),
            ...(Object.hasOwn(args,"window_file")?{windowPath:required(args,"window_file")}:{}),
            ...(Object.hasOwn(args,"application_file")?{applicationPath:required(args,"application_file")}:{})});
    }
    else if (resource === "agent" && action === "v3-rebind-source") {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      const applying=Object.hasOwn(args,"review_file");
      const allowed=["checkpoint",...(applying?["review_file","review_digest"]:["source_revision","out_file"])];
      if(parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
          flags.some(flag=>!allowed.includes(flag)))
        throw Error("首例源码换绑须选择导出审阅或按已确认摘要应用");
      const checkpoint=required(args,"checkpoint");
      result=applying?await rebindCloudV3PreparedSource(checkpoint,required(args,"review_file"),required(args,"review_digest")):
        exportCloudV3SourceReview(checkpoint,required(args,"source_revision"),required(args,"out_file"));
    }
    else if (resource === "agent" && action === "v3-prepare-delivery") {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      if (parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
          flags.some(flag=>!["checkpoint","bill_file","base_url","confirm"].includes(flag)) || args.confirm!==true)
        throw Error("仅在有效开发窗口按原检查点明确确认交付准备");
      result=await prepareCloudV3Delivery(required(args,"checkpoint"),client,required(args,"bill_file"));
    }
    else if (resource === "agent" && action === "v3-rehearse") {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      const settle=args.settle===true, allowed=["checkpoint","base_url",...(settle?["settle"]:["bill_file","confirm"])];
      if (parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
          flags.some(flag=>!allowed.includes(flag)) || (!settle && args.confirm!==true))
        throw Error("须选择提交一次原包演练，或核对同一演练批次");
      const checkpoint=required(args,"checkpoint");
      result=await advanceCloudV3Rehearsal(checkpoint,client,settle?{settle:true}:{billPath:required(args,"bill_file")});
    }
    else if (resource === "agent" && ["v3-publication-review","v3-publish"].includes(action)) {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      const exporting=action==="v3-publication-review", reconcile=!exporting && args.reconcile===true;
      const allowed=["checkpoint","base_url",...(exporting?["out_file"]:reconcile?["reconcile"]:["review_file","bill_file","confirm"])];
      if (parsed.positionals.length!==2 || new Set(flags).size!==flags.length ||
          flags.some(flag=>!allowed.includes(flag)) || (!exporting && !reconcile && args.confirm!==true))
        throw Error("须选择导出确切审阅、明确提交已审阅版本或核对原发布回执");
      const checkpoint=required(args,"checkpoint");
      result=exporting?await exportCloudV3PublicationReview(checkpoint,client,required(args,"out_file")):
        await submitCloudV3Publication(checkpoint,client,reconcile?{reconcile:true}:{reviewPath:required(args,"review_file"),
          billPath:required(args,"bill_file")});
    }
    else if (resource === "agent" && action === "v3-consumption") {
      const args=parsed.options, flags=argv.filter(value=>value.startsWith("--")).map(value=>value.slice(2).replaceAll("-","_"));
      const exporting=Object.hasOwn(args,"out_file");
      const allowed=["checkpoint","base_url",...(exporting?["out_file","batch_id"]:["plan","call_id_digest"])];
      if (parsed.positionals.length!==2 || new Set(flags).size!==flags.length || flags.some(flag=>!allowed.includes(flag)))
        throw Error("消费核验仅接受原批次导出或原报告与调用摘要");
      result=await bindCloudV3Consumption(required(args,"checkpoint"),client,exporting?
        {batchId:required(args,"batch_id"),outFile:required(args,"out_file")}:
        {planPath:required(args,"plan"),callIdDigest:required(args,"call_id_digest")});
    }
    else if (resource === "agent" && action === "request") {
      const key=required(parsed.options,"request_id");
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(key))throw Error("原请求编号格式不合法");
      result=await client.request(`/agent/requests/${encodeURIComponent(key)}`);
    }
    else if(resource==='agent'&&['repair-basis','repair-compare'].includes(action)){
      const allowed=new Set(['source_run_id','baseline_run_id','message','request_id','confirm','base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('对照修正命令包含额外参数');
      for(const token of argv.filter(value=>value.startsWith('--'))){const key=token.slice(2).replaceAll('-','_');if(!allowed.has(key)||seen.has(key))throw Error('对照修正命令包含未知或重复参数');seen.add(key);}
      const selection={sourceRunId:required(parsed.options,'source_run_id'),baselineRunId:required(parsed.options,'baseline_run_id')};
      result=action==='repair-basis'?await readRepairComparisonBasis(client,selection):await createComparisonRepairTask(client,{...selection,message:required(parsed.options,'message'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm});
    }
    else if(resource==='agent'&&['clarification','clarify'].includes(action)){
      const allowed=new Set(['id','answer','evidence_digest','request_id','confirm','base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('澄清命令包含额外参数');
      for(const token of argv.filter(v=>v.startsWith('--'))){const k=token.slice(2).replaceAll('-','_');if(!allowed.has(k)||seen.has(k))throw Error('澄清命令包含未知或重复参数');seen.add(k);}
      const taskId=required(parsed.options,'id');result=action==='clarification'?await readSqlClarification(client,{taskId}):await createSqlClarification(client,{taskId,answer:required(parsed.options,'answer'),evidenceDigest:required(parsed.options,'evidence_digest'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm});
    }
    else if(resource==='agent'&&['manual-continuation','continue-manual'].includes(action)){
      const allowed=new Set(['source_run_id','message','request_id','confirm','base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('手工续改命令包含额外参数');
      for(const token of argv.filter(v=>v.startsWith('--'))){const key=token.slice(2).replaceAll('-','_');if(!allowed.has(key)||seen.has(key))throw Error('手工续改命令包含未知或重复参数');seen.add(key);}
      const sourceRunId=required(parsed.options,'source_run_id');result=action==='manual-continuation'?await readManualContinuation(client,{sourceRunId}):await createManualContinuation(client,{sourceRunId,message:required(parsed.options,'message'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm});
    }
    else if(resource==='agent'&&['continuation','continue-version'].includes(action)){
      const allowed=new Set(['id','message','request_id','confirm','base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('续改命令包含额外参数');
      for(const token of argv.filter(v=>v.startsWith('--'))){const key=token.slice(2).replaceAll('-','_');if(!allowed.has(key)||seen.has(key))throw Error('续改命令包含未知或重复参数');seen.add(key);}
      const taskId=required(parsed.options,'id');result=action==='continuation'?await readAssistedContinuation(client,{taskId}):await createAssistedContinuation(client,{taskId,message:required(parsed.options,'message'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm});
    }
    else if(resource==='agent'&&action==='derive'){
      const allowed=new Set(['task_id','revision_id','run_id','revision_hash','context','message','request_id','confirm','base_url','help']),seen=new Set();
      if(parsed.positionals.length!==2)throw Error('口径变更命令包含额外参数');
      for(const token of argv.filter(value=>value.startsWith('--'))){const key=token.slice(2).replaceAll('-','_');if(!allowed.has(key)||seen.has(key))throw Error('口径变更命令包含未知或重复参数');seen.add(key);}
      result=await createContextDerivedTask(client,{derivation:{kind:'REGISTERED_CONTEXT_CHANGE',taskId:required(parsed.options,'task_id'),revisionId:required(parsed.options,'revision_id'),runId:required(parsed.options,'run_id'),revisionHash:required(parsed.options,'revision_hash')},
        contextId:required(parsed.options,'context'),message:required(parsed.options,'message'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm});
    }
    else if (resource === "agent" && action === "workflow") {
      validateManualDeliveryFlags(parsed,argv);
      result = parsed.options.source_kind==='MANUAL'?await readManualDeliveryWorkflow(client,{taskId:required(parsed.options,'id'),sourceRunId:required(parsed.options,'source_run_id')}):await client.request(`/agent/tasks/${encodeURIComponent(required(parsed.options, "id"))}/workflow`);
    }
    else if (resource === "agent" && ["publication","publication-preflight","publish","stop-publication"].includes(action)) {
      const flags=publicationCliOptions(argv,parsed.options,action),taskId=required(parsed.options,"id");
      if(action==="publication")result=await client.request(publicationReadPath(taskId,publicationSelectorInput(flags)));
      else if(action==="publication-preflight")result=await client.request(publicationPreflightPath(taskId,publicationSelectorInput(flags)));
      else if(action==="stop-publication"){
        const selector=publicationSelectorInput(flags);
        if(Object.keys(selector).length&&!selector.releaseId)throw Error("停止指定版本必须提供 --release-id，不选择其他历史发布");
        result=await client.request(publicationReadPath(taskId)+"/cancel",{method:"POST",body:selector});
      }else{
        const reviewed=jsonObject(readFileSync(required(parsed.options,"file"),"utf8"),"发布审阅");
        for(const[key,value]of Object.entries(flags)){
          if(Object.hasOwn(reviewed,key)&&reviewed[key]!==value)throw Error("命令参数与审阅文件不一致，不能覆盖已审阅版本");
        }
        const body=reviewedPublication({...reviewed,...flags}),requestId=parsed.options.request_id;
        if(requestId!==undefined&&(typeof requestId!=="string"||!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)))throw Error("原发布请求编号不合法");
        result=await client.request(publicationReadPath(taskId),{method:"POST",body,...(requestId===undefined?{}:{idempotencyKey:requestId})});
      }
    }
    else if (resource === "agent" && action === "deliveries") {
      const sourceId = parsed.options.source_id;
      result = await client.request(
        `/agent/deliveries${sourceId ? `?sourceAgentTaskId=${encodeURIComponent(sourceId)}` : ""}`,
      );
    }
    else if (resource === "agent" && action === "prepare-delivery") {
      validateManualDeliveryFlags(parsed,argv);
      result = parsed.options.source_kind==='MANUAL'?await prepareManualDelivery(client,{taskId:required(parsed.options,'id'),sourceRunId:required(parsed.options,'source_run_id'),requestId:required(parsed.options,'request_id'),confirm:parsed.options.confirm}):await client.request(
        `/agent/tasks/${encodeURIComponent(required(parsed.options, "id"))}/prepare-delivery`,
        { method: "POST", body: {} },
      );
    }
    else if (resource === "agent" && action === "delivery")
      result = await client.request(
        `/agent/deliveries/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "agent" && action === "advance-delivery")
      result = await client.request(`/agent/deliveries/${encodeURIComponent(required(parsed.options, "id"))}/advance`, { method: "POST", body: { expectedVersion: Number(required(parsed.options, "version")) } });
    else if (resource === "agent" && action === "recheck-delivery-receipt")
      result = await recheckFundRehearsal(client, { deliveryTaskId: required(parsed.options, "id"),
        expectedVersion: Number(required(parsed.options, "version")) });
    else if(resource==="agent"&&action==="background")result=await client.request(`/agent/tasks/${encodeURIComponent(required(parsed.options,"id"))}/background`);
    else if(resource==="agent"&&action==="enable-background"){
      if(parsed.options.confirm!==true)throw new Error("云后台可能调用模型和Spark，须先确认范围并提供--confirm");
      result=await client.request(`/agent/tasks/${encodeURIComponent(required(parsed.options,"id"))}/background`,{method:"POST",body:{expectedVersion:Number(required(parsed.options,"version"))}});
    }
    else if(resource==="agent"&&action==="resume-background"){
      if(parsed.options.confirm!==true)throw new Error("恢复原任务须审阅剩余次数与预算并提供--confirm；未知模型结果另须--confirm-model-retry");
      result=await client.request(`/agent/tasks/${encodeURIComponent(required(parsed.options,"id"))}/background/resume`,{method:"POST",body:{expectedVersion:Number(required(parsed.options,"version")),confirmModelRetry:parsed.options["confirm-model-retry"]===true}});
    }
    else if(resource==="agent"&&action==="stop-background"){
      if(parsed.options.confirm!==true)throw new Error("停止后续云后台推进须提供--confirm");
      result=await client.request(`/agent/tasks/${encodeURIComponent(required(parsed.options,"id"))}/background/cancel`,{method:"POST",body:{}});
    }
    else if (resource === "agent" && action === "cancel-delivery")
      result = await client.request(
        `/agent/deliveries/${encodeURIComponent(required(parsed.options, "id"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "python" && action === "revisions")
      result = await client.request("/python/revisions");
    else if (resource === "python" && action === "create")
      result = await client.request("/python/revisions", {
        method: "POST",
        body: {
          contextId: required(parsed.options, "context"),
          code: readFileSync(required(parsed.options, "file"), "utf8"),
        },
      });
    else if (resource === "python" && action === "runs")
      result = await client.request("/python/runs");
    else if (resource === "python" && action === "run")
      result = await client.request("/python/runs", {
        method: "POST",
        body: { revisionId: required(parsed.options, "id") },
      });
    else if (resource === "python" && action === "show")
      result = await client.request(
        `/python/runs/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "python" && action === "cancel")
      result = await client.request(
        `/python/runs/${encodeURIComponent(required(parsed.options, "id"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "release-runs" && action === "list")
      result = await client.request("/release/runs");
    else if (resource === "delivery" && action === "packages")
      result = await client.request("/delivery/packages");
    else if (resource === "delivery" && action === "show")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "delivery" && action === "create")
      result = await client.request("/delivery/packages", {
        method: "POST",
        body: {
          sourceRunId: required(parsed.options, "source_run_id"),
          name: required(parsed.options, "name"),
        },
      });
    else if (resource === "delivery" && action === "verify")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "id"))}/verify`,
        {
          method: "POST",
          body: {
            scheduledFor: required(parsed.options, "scheduled_for"),
          },
        },
      );
    else if (resource === "delivery" && action === "verifications")
      result = await client.request("/delivery/verifications");
    else if (resource === "delivery" && action === "verification")
      result = await client.request(
        `/delivery/verifications/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "delivery" && action === "cancel")
      result = await client.request(
        `/delivery/verifications/${encodeURIComponent(required(parsed.options, "id"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "delivery" && action === "reviews")
      result = await client.request("/delivery/reviews");
    else if (resource === "delivery" && action === "review")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "id"))}/review`,
        {
          method: "POST",
          body: {
            packageDigest: required(parsed.options, "package_digest"),
            verificationId: required(parsed.options, "verification_id"),
            reviewNote: required(parsed.options, "note"),
            attestations: {
              code: parsed.options.attest_code === true,
              assertions: parsed.options.attest_assertions === true,
              deliveryFiles: parsed.options.attest_delivery_files === true,
              localScope: parsed.options.attest_local_scope === true,
            },
          },
        },
      );
    else if (resource === "releases" && action === "approvals")
      result = await client.request("/release/approvals");
    else if (resource === "releases" && action === "approve")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "package_id"))}/approve`,
        {
          method: "POST",
          body: {
            packageDigest: required(parsed.options, "package_digest"),
            reviewId: required(parsed.options, "review_id"),
            ...(parsed.options.distribution_consent?{distributionConsent:jsonObject(readFileSync(parsed.options.distribution_consent,"utf8"),"分布发布批准")} : {}),
            ...(parsed.options.fund_consent?{fundConsent:jsonObject(readFileSync(parsed.options.fund_consent,"utf8"),"基金发布批准")} : {}),
          },
        },
      );
    else if (resource === "releases" && action === "list")
      result = await client.request("/releases");
    else if (resource === "releases" && action === "show")
      result = await client.request(
        `/releases/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "releases" && action === "publish")
      result = await client.request("/releases", {
        method: "POST",
        body: {
          approvalId: required(parsed.options, "approval_id"),
          ...(parsed.options.fund_consent ? jsonObject(readFileSync(parsed.options.fund_consent,"utf8"),"基金发布批准").scheduleSpec :
            parsed.options.distribution_consent ? jsonObject(readFileSync(parsed.options.distribution_consent,"utf8"),"分布发布批准").scheduleSpec :
            {triggerAfterSeconds:Number(parsed.options.trigger_after_seconds??5),intervalSeconds:Number(parsed.options.interval_seconds??15),runCount:Number(parsed.options.run_count??2)}),
        },
      });
    else if (resource === "releases" && action === "cancel")
      result=await client.request(`/releases/${encodeURIComponent(required(parsed.options,"id"))}/cancel`,{method:"POST",body:{packageDigest:required(parsed.options,"package_digest")}});
    else if (resource === "releases" && action === "rollback")
      result = await client.request(
        `/releases/${encodeURIComponent(required(parsed.options, "id"))}/rollback`,
        {
          method: "POST",
          ...(parsed.options.request_id?{idempotencyKey:parsed.options.request_id}:{}),
          body: {
            targetReleaseId: required(parsed.options, "target_release_id"),
            ...(parsed.options.distribution_consent?{distributionRollback:jsonObject(readFileSync(parsed.options.distribution_consent,"utf8"),"分布回滚确认")}:{triggerAfterSeconds:Number(parsed.options.trigger_after_seconds??5),intervalSeconds:Number(parsed.options.interval_seconds??15)}),
            reason: required(parsed.options, "reason"),
          },
        },
      );
    else if (resource === "releases" && action === "monitor")
      result = await client.request("/monitoring/overview");
    else if (resource === "services" && ["sources","task-evidence"].includes(action))
      result=await client.request(serviceSourceReadPath(action,serviceReadCliOptions(argv,parsed.options,action)));
    else if (resource === "services" && action === "list") {
      const type = parsed.options.type;
      if (type) result = await client.request(`/data-services/${typePath(type)}`);
      else {
        const [dapis, xapis] = await Promise.all([
          client.request("/data-services/dapis"),
          client.request("/data-services/xapis"),
        ]);
        result = { dapis, xapis };
      }
    } else if (resource === "services" && action === "create-dapi") {
      result = await client.request("/data-services/dapis", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          slug: required(parsed.options, "slug"),
          sourceReleaseRunId: required(parsed.options, "source_run_id"),
          ...(parsed.options.fields
            ? { fields: list(parsed.options.fields, "--fields") }
            : {}),
          ...(parsed.options.timeout_ms
            ? { timeoutMs: Number(parsed.options.timeout_ms) }
            : {}),
          ...(parsed.options.rate_limit
            ? { rateLimitPerMinute: Number(parsed.options.rate_limit) }
            : {}),
        },
      });
    } else if (resource === "services" && action === "create-xapi") {
      result = await client.request("/data-services/xapis", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          slug: required(parsed.options, "slug"),
          steps: steps(required(parsed.options, "steps")),
        },
      });
    } else if (
      resource === "services" &&
      ["test", "publish", "openapi", "recovery"].includes(action)
    ) {
      const path = `/data-services/${typePath(required(parsed.options, "type"))}/${encodeURIComponent(required(parsed.options, "id"))}/${action}`;
      result = await client.request(path, {
        ...(["openapi", "recovery"].includes(action)
          ? {}
          : {
              method: "POST",
              body:
                action === "test"
                  ? serviceQueryOptions(parsed.options)
                  : {configHash:required(parsed.options,"config_hash")},
            }),
      });
    } else if(resource === "services" && ["show","history"].includes(action)){
      result=await client.request(`/data-services/${typePath(required(parsed.options,"type"))}/${encodeURIComponent(required(parsed.options,"id"))}${action==="history"?"/history":""}`);
    } else if(resource === "services" && action==="new-version"){
      const type=required(parsed.options,"type");
      const body={...(type==="dapi"?{sourceReleaseRunId:required(parsed.options,"source_run_id")}:{}),
        ...(parsed.options.fields?{fields:list(parsed.options.fields,"--fields")} : {}),
        ...(parsed.options.rate_limit?{rateLimitPerMinute:Number(parsed.options.rate_limit)}:{}),
        ...(parsed.options.timeout?{timeoutMs:Number(parsed.options.timeout)}:{})};
      result=await client.request(`/data-services/${typePath(type)}/${encodeURIComponent(required(parsed.options,"id"))}/versions`,{method:"POST",body});
    } else if(resource === "services" && action==="activate"){
      if(parsed.options.confirm!==true)throw new Error("切换/回滚会影响查询端点，需审阅线上版本与目标摘要并提供--confirm");
      result=await client.request(`/data-services/${typePath(required(parsed.options,"type"))}/${encodeURIComponent(required(parsed.options,"id"))}/activate`,{method:"POST",idempotencyKey:required(parsed.options,"request_id"),body:{
        versionId:required(parsed.options,"version_id"),expectedPublishedVersionId:required(parsed.options,"expected_version"),configHash:required(parsed.options,"config_hash")}});
    } else if (resource === "services" && action === "calls") {
      result = await client.request(
        `/data-services/calls${parsed.options.id ? `?service_id=${encodeURIComponent(parsed.options.id)}` : ""}`,
      );
    } else if (resource === "services" && action === "invoke") {
      const token = env.SHUDUO_APP_TOKEN;
      if (!token) throw new Error("缺少环境变量 SHUDUO_APP_TOKEN");
      const query = new URLSearchParams(serviceQueryOptions(parsed.options));
      result = await client.request(
        `/open/${typePath(required(parsed.options, "type"))}/${encodeURIComponent(required(parsed.options, "slug"))}?${query}`,
        { authorization: `Bearer ${token}` },
      );
    } else if (resource === "apps" && action === "list")
      result = await client.request("/data-services/applications");
    else if (resource === "apps" && action === "create")
      result = await client.request("/data-services/applications", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          serviceIds: list(
            required(parsed.options, "service_ids"),
            "--service-ids",
          ),
        },
      });
    else if (resource === "apps" && action === "revoke")
      result = await client.request(
        `/data-services/applications/${encodeURIComponent(required(parsed.options, "id"))}/revoke`,
        { method: "POST", body: {} },
      );
    else if (resource === "sources" && action === "list")
      result = await client.request("/sources");
    else if (resource === "sources" && action === "create")
      result = await client.request("/sources", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceType: "LOCAL_CSV",
          fileName: required(parsed.options, "file"),
        },
      });
    else if (resource === "sources" && action === "create-server-mysql")
      result = await client.request("/sources", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceType: "SERVER_MYSQL",
          tableName: required(parsed.options, "table"),
        },
      });
    else if (
      resource === "sources" &&
      ["test", "metadata"].includes(action)
    )
      result = await client.request(
        `/sources/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        { method: "POST", body: {} },
      );
    else if (resource === "sources" && action === "revision")
      result = await client.request(
        `/sources/${encodeURIComponent(required(parsed.options, "id"))}/revisions`,
        {
          method: "POST",
          body: { fileName: required(parsed.options, "file") },
        },
      );
    else if (resource === "sync" && action === "list")
      result = await client.request("/sync/tasks");
    else if (resource === "sync" && action === "create") {
      const mode = required(parsed.options, "mode");
      if (!["full", "incremental"].includes(mode))
        throw new Error("--mode必须是full或incremental");
      result = await client.request("/sync/tasks", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceId: required(parsed.options, "source_id"),
          targetTable: required(parsed.options, "target_table"),
          mode: mode === "full" ? "FULL" : "INCREMENTAL_UPSERT",
          mapping: mapping(required(parsed.options, "mapping")),
          keyFields: list(required(parsed.options, "keys"), "--keys"),
          ...(parsed.options.watermark
            ? { watermarkField: parsed.options.watermark }
            : {}),
        },
      });
    } else if (resource === "sync" && action === "run")
      result = await client.request(
        `/sync/tasks/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "sync" && action === "rows")
      result = await client.request(
        `/sync/targets/${encodeURIComponent(required(parsed.options, "table"))}/rows`,
      );
    else if (resource === "sync" && action === "plan")
      result = await client.request("/sync/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "sync" && action === "plans")
      result = await client.request("/sync/agent/plans");
    else if (resource === "sync" && action === "apply-plan")
      result = await client.request(
        `/sync/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "streams" && action === "sources")
      result = await client.request("/streams/sources");
    else if (resource === "streams" && action === "create-source")
      result = await client.request("/streams/sources", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          adapter: "local-event-log-v1",
          topic: required(parsed.options, "topic"),
          fileName: required(parsed.options, "file"),
        },
      });
    else if (resource === "streams" && action === "revision")
      result = await client.request(
        `/streams/sources/${encodeURIComponent(required(parsed.options, "source_id"))}/revisions`,
        {
          method: "POST",
          body: { fileName: required(parsed.options, "file") },
        },
      );
    else if (resource === "streams" && action === "jobs")
      result = await client.request("/streams/jobs");
    else if (resource === "streams" && action === "create-job")
      result = await client.request("/streams/jobs", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceId: required(parsed.options, "source_id"),
          targetTable: required(parsed.options, "target_table"),
          ...(parsed.options.checkpoint_every
            ? { checkpointEvery: Number(parsed.options.checkpoint_every) }
            : {}),
          ...(parsed.options.max_out_of_order_seconds
            ? {
                maxOutOfOrderSeconds: Number(
                  parsed.options.max_out_of_order_seconds,
                ),
              }
            : {}),
        },
      });
    else if (
      resource === "streams" &&
      ["start", "stop"].includes(action)
    )
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        { method: "POST", body: {} },
      );
    else if (resource === "streams" && action === "recover")
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/recover`,
        {
          method: "POST",
          body: {
            sourceRevisionId: required(parsed.options, "revision_id"),
          },
        },
      );
    else if (
      resource === "streams" &&
      ["state", "checkpoints"].includes(action)
    )
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
      );
    else if (resource === "streams" && action === "monitor")
      result = await client.request("/streams/monitor");
    else if (resource === "streams" && action === "plan")
      result = await client.request("/streams/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "streams" && action === "plans")
      result = await client.request("/streams/agent/plans");
    else if (resource === "streams" && action === "apply-plan")
      result = await client.request(
        `/streams/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "assets" && action === "list") {
      const query = new URLSearchParams({
        ...(parsed.options.query ? { q: parsed.options.query } : {}),
        ...(parsed.options.kind ? { kind: parsed.options.kind } : {}),
      });
      result = await client.request(`/assets${query.size ? `?${query}` : ""}`);
    } else if (
      resource === "assets" &&
      ["show", "lineage", "impact"].includes(action)
    ) {
      result = await client.request(
        assetResourcePath(required(parsed.options, "id"), action === "show" ? undefined : action),
      );
    } else if (resource === "assets" && action === "annotation-submit")
      result = await submitAssetAnnotation(client, required(parsed.options,"id"), jsonObject(readFileSync(required(parsed.options,"file"),"utf8"),"标注请求"));
    else if (resource === "assets" && action === "annotation-request")
      result = await readAssetAnnotationRequest(client, required(parsed.options,"id"), required(parsed.options,"request_id"));
    else if (resource === "assets" && action === "annotate")
      result = await client.request(
        assetResourcePath(required(parsed.options, "id"), "annotation"),
        {
          method: "POST",
          body: {
            businessName: required(parsed.options, "business_name"),
            description: required(parsed.options, "description"),
            domain: required(parsed.options, "domain"),
            owner: required(parsed.options, "owner"),
            classification:
              parsed.options.classification ?? "INTERNAL_DEMO",
            ...(parsed.options.tags
              ? { tags: list(parsed.options.tags, "--tags") }
              : {}),
          },
        },
      );
    else if (resource === "assets" && action === "agent")
      result = await client.request("/assets/agent/tasks", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "assets" && action === "agents")
      result = await client.request("/assets/agent/tasks");
    else if(resource==='contracts'&&action==='service-gates')result=await client.request(`/data-services/${encodeURIComponent(required(parsed.options,'service_id'))}/contract-gates${parsed.options.version_id?'?version_id='+encodeURIComponent(parsed.options.version_id):''}`);
    else if(resource==='contracts'&&['bind-service','gate-version'].includes(action))result=await submitServiceGateWrite(client,{serviceId:required(parsed.options,'service_id'),...(action==='gate-version'?{bindingId:required(parsed.options,'binding_id')}:{}),input:jsonObject(readFileSync(required(parsed.options,'file'),'utf8'),'门禁配置'),requestId:required(parsed.options,'request_id')});
    else if(resource==='contracts'&&action==='gate-request')result=await lookupServiceGateWrite(client,{serviceId:required(parsed.options,'service_id'),requestId:required(parsed.options,'request_id')});
    else if (resource === "contracts" && action === "list")
      result = await client.request("/contracts");
    else if (resource === "contracts" && action === "show")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "contracts" && action === "create")
      result = await client.request("/contracts", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          compatibility: required(parsed.options, "compatibility"),
          owner: required(parsed.options, "owner"),
          description: required(parsed.options, "description"),
          qualitySlo: {
            minPassRate: Number(parsed.options.min_pass_rate ?? 0.99),
            maxFreshnessSeconds: Number(
              parsed.options.max_freshness_seconds ?? 86400,
            ),
          },
        },
      });
    else if (resource === "contracts" && action === "assess-current")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/assess`,
        { method: "POST", body: {} },
      );
    else if (resource === "contracts" && action === "apply-version")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            assessmentId: required(parsed.options, "assessment_id"),
            acknowledgeBreaking:
              parsed.options.acknowledge_breaking === true,
          },
        },
      );
    else if (resource === "contracts" && action === "check")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/check`,
        { method: "POST", body: {} },
      );
    else if (resource === "metrics" && action === "list")
      result = await client.request("/metrics");
    else if (resource === "metrics" && action === "create")
      result = await client.request("/metrics", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          aggregation: required(parsed.options, "aggregation").toUpperCase(),
          ...(parsed.options.field ? { field: parsed.options.field } : {}),
          ...(parsed.options.group_by ? { groupBy: parsed.options.group_by } : {}),
          definition: required(parsed.options, "definition"),
        },
      });
    else if (resource === "metrics" && action === "run")
      result = await client.request(
        `/metrics/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "standards" && action === "list")
      result = await client.request("/standards");
    else if (resource === "standards" && action === "create")
      result = await client.request("/standards", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          field: required(parsed.options, "field"),
          semanticType: required(parsed.options, "semantic_type").toUpperCase(),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "standards" && action === "check")
      result = await client.request(
        `/standards/${encodeURIComponent(required(parsed.options, "id"))}/check`,
        { method: "POST", body: {} },
      );
    else if (resource === "quality" && action === "overview")
      result = await client.request("/quality/overview");
    else if (resource === "quality" && action === "list")
      result = await client.request("/quality/rules");
    else if (resource === "quality" && action === "create") {
      const type = qualityType(required(parsed.options, "type"));
      result = await client.request("/quality/rules", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          field: required(parsed.options, "field"),
          type,
          config: qualityConfig(parsed.options, type),
          description: required(parsed.options, "description"),
        },
      });
    } else if (resource === "quality" && action === "version") {
      const type = qualityType(required(parsed.options, "type"));
      result = await client.request(
        `/quality/rules/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            type,
            config: qualityConfig(parsed.options, type),
            description: required(parsed.options, "description"),
          },
        },
      );
    } else if (resource === "quality" && action === "run")
      result = await client.request(
        `/quality/rules/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "quality" && action === "plan")
      result = await client.request("/quality/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "quality" && action === "plans")
      result = await client.request("/quality/agent/plans");
    else if (resource === "quality" && action === "apply-plan")
      result = await client.request(
        `/quality/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "security" && action === "overview")
      result = await client.request("/security/overview");
    else if (resource === "security" && action === "personas")
      result = await client.request("/security/personas");
    else if (resource === "security" && action === "policies")
      result = await client.request("/security/policies");
    else if (resource === "security" && action === "create-policy")
      result = await client.request("/security/policies", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          roles: list(required(parsed.options, "roles"), "--roles"),
          rowScope: required(parsed.options, "row_scope").toUpperCase(),
          defaultAction: (parsed.options.default_action ?? "DENY").toUpperCase(),
          fieldActions: Object.fromEntries(
            Object.entries(
              mapping(required(parsed.options, "actions")),
            ).map(([field, value]) => [field, value.toUpperCase()]),
          ),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "security" && action === "version")
      result = await client.request(
        `/security/policies/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            roles: list(required(parsed.options, "roles"), "--roles"),
            rowScope: required(parsed.options, "row_scope").toUpperCase(),
            defaultAction: (parsed.options.default_action ?? "DENY").toUpperCase(),
            fieldActions: Object.fromEntries(
              Object.entries(
                mapping(required(parsed.options, "actions")),
              ).map(([field, value]) => [field, value.toUpperCase()]),
            ),
            description: required(parsed.options, "description"),
          },
        },
      );
    else if (resource === "security" && action === "query")
      result = await client.request(
        `/security/query/${encodeURIComponent(required(parsed.options, "asset_id"))}`,
        {
          method: "POST",
          body: {},
          actorId: required(parsed.options, "actor_id"),
        },
      );
    else if (resource === "security" && action === "requests")
      result = await client.request("/security/requests");
    else if (resource === "security" && action === "request")
      result = await client.request("/security/requests", {
        method: "POST",
        actorId: required(parsed.options, "actor_id"),
        body: {
          assetId: required(parsed.options, "asset_id"),
          scope: required(parsed.options, "scope").toUpperCase(),
          reason: required(parsed.options, "reason"),
        },
      });
    else if (resource === "security" && action === "review")
      result = await client.request(
        `/security/requests/${encodeURIComponent(required(parsed.options, "id"))}/review`,
        {
          method: "POST",
          actorId: required(parsed.options, "actor_id"),
          body: {
            decision: required(parsed.options, "decision").toUpperCase(),
            reviewNote: required(parsed.options, "note"),
            ...(parsed.options.duration_hours
              ? { durationHours: Number(parsed.options.duration_hours) }
              : {}),
          },
        },
      );
    else if (resource === "security" && action === "audits")
      result = await client.request("/security/audits");
    else if (resource === "security" && action === "plan")
      result = await client.request("/security/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "security" && action === "plans")
      result = await client.request("/security/agent/plans");
    else if (resource === "security" && action === "apply-plan")
      result = await client.request(
        `/security/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if(resource==='reports'&&action==='from-publication')
      result=await submitPublishedReport(client,{name:required(parsed.options,'name'),source:jsonObject(readFileSync(required(parsed.options,'source_file'),'utf8'),'报表发布来源'),requestId:required(parsed.options,'request_id'),...(parsed.options.metric_ids?{metricIds:list(parsed.options.metric_ids,'--metric-ids')}:{})});
    else if(resource==='reports'&&action==='request')result=await lookupPublishedReport(client,{requestId:required(parsed.options,'request_id')});
    else if (resource === 'reports' && action === 'quality')
      result = await readFundReportQuality(client, { requestId: required(parsed.options, 'request_id') });
    else if (resource === 'reports' && action === 'quality-run')
      result = await runFundReportQuality(client, { requestId: required(parsed.options, 'request_id'),
        snapshotId: required(parsed.options, 'snapshot_id'), basisDigest: required(parsed.options, 'basis_digest'),
        confirm: parsed.options.confirm === true });
    else if(resource==='reports'&&['result','lineage','development','consumption'].includes(action))
      result=await ({result:readPublishedReportResult,lineage:readPublishedReportLineage,development:readPublishedReportDevelopment,consumption:readPublishedReportConsumption}[action])(client,{requestId:required(parsed.options,'request_id'),
        ...(parsed.options.source_file?{source:jsonObject(readFileSync(required(parsed.options,'source_file'),'utf8'),'报表发布来源')}:{})});
    else if(resource==='reports'&&action==='resume')result=await resumePublishedReport(client,{id:required(parsed.options,'id')});
    else if (resource === "reports" && action === "overview")
      result = await client.request("/reports/overview");
    else if (resource === "reports" && action === "datasets")
      result = await client.request("/reports/datasets");
    else if (resource === "reports" && action === "create-dataset")
      result = await client.request("/reports/datasets", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          fields: list(required(parsed.options, "fields"), "--fields"),
        },
      });
    else if (resource === "reports" && action === "refresh-dataset")
      result = await client.request(
        `/reports/datasets/${encodeURIComponent(required(parsed.options, "id"))}/refresh`,
        { method: "POST", body: {} },
      );
    else if (resource === "reports" && action === "list")
      result = await client.request("/reports");
    else if (resource === "reports" && action === "create")
      result = await client.request("/reports", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          datasetId: required(parsed.options, "dataset_id"),
          widgets: reportWidgets(required(parsed.options, "preset")),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "reports" && action === "version")
      result = await client.request(
        `/reports/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            widgets: reportWidgets(required(parsed.options, "preset")),
            description: required(parsed.options, "description"),
          },
        },
      );
    else if(resource==='reports'&&action==='provenance')result=await readReportProvenance(client,{reportId:required(parsed.options,'id'),runId:required(parsed.options,'run_id')});
    else if(resource==='reports'&&action==='wealth-consumption')result=await readWealthConsumption(client,{reportId:required(parsed.options,'id'),runId:required(parsed.options,'run_id')});
    else if(resource==='reports'&&action==='verify-provenance'){const evidence=await checkedReportProvenance(JSON.parse(readFileSync(required(parsed.options,'file'),'utf8')));result={passed:true,digest:evidence.digest,artifacts:evidence.artifacts,integrity:evidence.integrity,onlineAuthorityVerified:false,agentIndependentE2E:false};}
    else if (resource === "reports" && action === "batch-summary") {
      const source = jsonObject(readFileSync(required(parsed.options, "source_file"), "utf8"), "批次报表来源");
      const outFile = parsed.options.out_file, downloadDigest = parsed.options.download_digest;
      if (Boolean(outFile) !== Boolean(downloadDigest)) throw Error("下载需要同时提供 --download-digest 和 --out-file");
      result = await readPrivateBatchSummary(client, {source, downloadDigest});
      if (outFile) writeFileSync(outFile, JSON.stringify(result), {mode:0o600, flag:"wx"});
    }
    else if (resource === "reports" && action === "verify-batch-summary") {
      const evidence = await checkedPrivateBatchReport(JSON.parse(readFileSync(required(parsed.options, "file"), "utf8")));
      result = {passed:true, digest:evidence.digest, batchId:evidence.source.batchId, onlineAuthorityVerified:false};
    }
    else if (resource === "reports" && action === "prepare-batch-archive")
      result = await prepareBatchArchive(jsonObject(readFileSync(required(parsed.options, "file"), "utf8"), "报表归档方案"));
    else if (resource === "reports" && action === "archive-batch") {
      if (parsed.options.confirm !== true) throw Error("请审阅原方案后使用 --confirm 提交");
      const reviewed = jsonObject(readFileSync(required(parsed.options, "file"), "utf8"), "报表归档审阅");
      result = await submitBatchArchive(client, {...reviewed, requestId:required(parsed.options, "request_id")});
    }
    else if (resource === "reports" && action === "batch-archive") {
      const outFile = parsed.options.out_file, downloadDigest = parsed.options.download_digest;
      if (Boolean(outFile) !== Boolean(downloadDigest)) throw Error("下载需要同时提供 --download-digest 和 --out-file");
      result = await readBatchArchive(client, {requestId:required(parsed.options, "request_id"), downloadDigest});
      if (outFile) writeFileSync(outFile, JSON.stringify(result), {mode:0o600, flag:"wx"});
    }
    else if (resource === "reports" && action === "verify-batch-archive") {
      const evidence = await checkedBatchArchive(JSON.parse(readFileSync(required(parsed.options, "file"), "utf8")));
      result = {passed:true, digest:evidence.digest, reportVersion:evidence.reportVersion, onlineAuthorityVerified:false};
    }
    else if (resource === "reports" && ["run", "export"].includes(action))
      result = await client.request(
        `/reports/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        action === "run" ? { method: "POST", body: {} } : {},
      );
    else if (resource === "reports" && action === "plan")
      result = await client.request("/reports/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message"),...(parsed.options.source_file?{source:jsonObject(readFileSync(parsed.options.source_file,'utf8'),'报表发布来源')}:{}) },
        ...(parsed.options.request_id?{idempotencyKey:parsed.options.request_id}:{}),
      });
    else if(resource==='reports'&&action==='clarification')result=await client.request('/reports/agent/plans/'+encodeURIComponent(required(parsed.options,'id'))+'/clarification');
    else if(resource==='reports'&&action==='clarify')result=await client.request('/reports/agent/plans/'+encodeURIComponent(required(parsed.options,'id'))+'/clarify',{method:'POST',body:{evidenceDigest:required(parsed.options,'evidence_digest'),answer:required(parsed.options,'answer')},idempotencyKey:required(parsed.options,'request_id')});
    else if(resource==='reports'&&action==='resume-plan')result=await client.request('/reports/agent/plans/'+encodeURIComponent(required(parsed.options,'id'))+'/resume',{method:'POST',body:{}});
    else if(resource==='reports'&&action==='plan-request')result=await client.request('/reports/agent/requests/'+encodeURIComponent(required(parsed.options,'request_id')));
    else if (resource === "reports" && action === "plans")
      result = await client.request('/reports/agent/plans'+(parsed.options.source_batch_id?'?source_batch_id='+encodeURIComponent(parsed.options.source_batch_id):''));
    else if (resource === "reports" && action === "apply-plan")
      result = await client.request(
        `/reports/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body:parsed.options.proposal_hash?{proposalHash:parsed.options.proposal_hash}:{} },
      );
    else if (resource === "ops" && action === "overview")
      result = await client.request("/operations/overview");
    else if (resource === "ops" && action === "refresh")
      result = await client.request("/operations/refresh", {
        method: "POST",
        body: {},
      });
    else if (resource === "ops" && action === "incidents")
      result = await client.request("/operations/incidents");
    else if (resource === "ops" && action === "show")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "ops" && action === "acknowledge")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}/acknowledge`,
        {
          method: "POST",
          body: {
            actor: parsed.options.actor ?? "local-operator",
            note: required(parsed.options, "note"),
          },
        },
      );
    else if (resource === "ops" && action === "resolve")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}/resolve`,
        {
          method: "POST",
          body: {
            actor: parsed.options.actor ?? "local-operator",
            evidenceKind: required(parsed.options, "evidence_kind"),
            evidenceId: required(parsed.options, "evidence_id"),
            note: required(parsed.options, "note"),
          },
        },
      );
    else if (resource === "ops" && action === "diagnose")
      result = await client.request("/operations/agent/diagnoses", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "ops" && action === "diagnoses")
      result = await client.request("/operations/agent/diagnoses");
    else if (resource === "evaluations" && action === "full-lifecycle")
      result = await client.request("/evaluations/full-lifecycle/latest");
    else throw new Error(`不支持的V2命令：${parsed.positionals.join(" ")}`);
    out(JSON.stringify(result, null, 2));
    if(resource==='assets'&&action==='annotation-submit'&&result?.protocol==='shuduo-asset-annotation-result/v2'&&result.receipt.outcome==='REJECTED')return 2;
    return 0;
  } catch (error) {
    err(`错误：${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await runV2Cli(process.argv.slice(2));
