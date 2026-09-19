#!/usr/bin/env node
import readline from "node:readline";
import { V2Client, V2_OPERATIONS } from "../src/v2/client.mjs";

const tools = [
  { name: "v2_status", description: "读取数舵V2真实/本机/公网能力边界。", inputSchema: { type: "object", properties: {} } },
  { name: "budget_status", description: "读取当月模型估算、远程Spark用量、账号账单连接状态和预算门；未连接账号账单时不代表全站费用。", inputSchema: { type: "object", properties: {} } },
  { name: "agent_intent_list", description: "读取跨模块 Data Agent 的任务理解与受治理路由结果。", inputSchema: { type: "object", properties: {} } },
  { name: "agent_tool_list", description: "读取十个专业Agent域的版本化工具目录、风险、资源路径、前置依赖和批准边界。", inputSchema: { type: "object", properties: {} } },
  { name: "agent_tool_validate", description: "按工具目录版本和摘要校验专业Agent输入；只做契约预检，不创建任务或批准。", inputSchema: { type: "object", properties: { toolId: { type: "string" }, catalogVersion: { type: "string" }, contractDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, input: { type: "object" } }, required: ["toolId", "catalogVersion", "contractDigest", "input"], additionalProperties: false } },
  { name: "agent_tool_invoke", description: "以当前父意图、目录摘要和步骤批准调用一个专业Agent原子能力，并原子绑定任务图；不应用草稿、不发布、不授权。调用前必须取得用户对该步骤的明确批准。", inputSchema: { type: "object", properties: { intentId: { type: "string" }, toolId: { type: "string" }, approvalId: { type: "string" }, catalogVersion: { type: "string" }, contractDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, input: { type: "object" } }, required: ["intentId", "toolId", "approvalId", "catalogVersion", "contractDigest", "input"], additionalProperties: false } },
  { name: "agent_intent_create", description: "理解需求并在受支持模块中推荐下一步；只做路由，不执行同步、查询、审批、发布、发令牌或改权限。", inputSchema: { type: "object", properties: { message: { type: "string", minLength: 4, maxLength: 2000 } }, required: ["message"] } },
  { name: "agent_intent_approval_list", description: "读取一个Data Agent意图中已批准和已绑定的专业步骤；不返回批准者内部标识。", inputSchema: { type: "object", properties: { intentId: { type: "string" } }, required: ["intentId"] } },
  { name: "agent_intent_approval_create", description: "批准REQUEST_APPROVAL任务中的一个精确专业步骤；只生成版本绑定批准，不执行专业任务。调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { intentId: { type: "string" }, destinationId: { type: "string" } }, required: ["intentId", "destinationId"] } },
  { name: "agent_intent_graph", description: "读取意图、逐步批准、专业任务绑定与状态组成的统一任务图；不返回原始任务描述、业务数据或批准者标识。", inputSchema: { type: "object", properties: { intentId: { type: "string" } }, required: ["intentId"] } },
  { name: "agent_intent_cancel", description: "停止父意图的后续编排并撤销未绑定批准；已有专业子任务时拒绝，须分别处理。调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { intentId: { type: "string" } }, required: ["intentId"] } },
  { name: "agent_specialist_cancel", description: "取消父意图中仍在排队或运行的指定专业子任务；保留父意图、批准、交接和取消证据。调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { intentId: { type: "string" }, destinationId: { type: "string" } }, required: ["intentId", "destinationId"] } },
  { name: "agent_intent_handoff_list", description: "读取一个跨模块Agent意图的受控交接记录。", inputSchema: { type: "object", properties: { intentId: { type: "string" } }, required: ["intentId"] } },
  { name: "agent_intent_handoff_create", description: "把一个已完成的Agent意图交接到其推荐链路中的专业模块；只记录交接并预填草稿，不执行下游任务。", inputSchema: { type: "object", properties: { intentId: { type: "string" }, destinationId: { type: "string" } }, required: ["intentId", "destinationId"] } },
  { name: "agent_intent_trace", description: "读取一个Agent意图的路由与专业模块交接轨迹摘要；不返回原始任务描述或业务数据。", inputSchema: { type: "object", properties: { intentId: { type: "string" } }, required: ["intentId"] } },
  { name: "agent_journey", description: "只读串联代码Agent、交付包、审批、计时发布和监控证据；人工步骤不冒充Agent自主E2E。", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "agent_delivery_list", description: "列出代码Agent的后台交付准备、不可变包与文件演练结果。", inputSchema: { type: "object", properties: { sourceAgentTaskId: { type: "string" } } } },
  { name: "agent_delivery_prepare", description: "对真实模型与Spark已核验代码自动生成调度/部署包并实际文件演练；不审批、不发布、不创建公网资源。", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "agent_delivery_detail", description: "读取交付准备任务的阶段、包摘要、演练编号与明确失败。", inputSchema: { type: "object", properties: { deliveryTaskId: { type: "string" } }, required: ["deliveryTaskId"] } },
  { name: "agent_delivery_cancel", description: "取消未完成的交付准备并保留包/演练证据；调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { deliveryTaskId: { type: "string" } }, required: ["deliveryTaskId"] } },
  { name: "release_runs_list", description: "列出真实调度发布批次及验证证据。", inputSchema: { type: "object", properties: {} } },
  { name: "delivery_package_list", description: "列出交付包摘要、源代码版本和发布状态，不返回文件正文。", inputSchema: { type: "object", properties: {} } },
  { name: "delivery_package_detail", description: "读取指定不可变交付包、文件与可信摘要。", inputSchema: { type: "object", properties: { packageId: { type: "string" } }, required: ["packageId"] } },
  { name: "delivery_package_create", description: "从真实Spark且独立断言通过的代码运行生成交付包；只生成文件，不审批或发布。", inputSchema: { type: "object", properties: { sourceRunId: { type: "string" }, name: { type: "string" } }, required: ["sourceRunId", "name"] } },
  { name: "delivery_package_verify", description: "按包内DAG和样例交易日实际执行文件演练；不是发布。", inputSchema: { type: "object", properties: { packageId: { type: "string" }, scheduledFor: { type: "string" } }, required: ["packageId", "scheduledFor"] } },
  { name: "delivery_verification_list", description: "列出交付包文件演练状态与证据。", inputSchema: { type: "object", properties: {} } },
  { name: "delivery_verification_detail", description: "读取指定文件演练的步骤和验证证据。", inputSchema: { type: "object", properties: { verificationId: { type: "string" } }, required: ["verificationId"] } },
  { name: "delivery_verification_cancel", description: "取消未完成的文件演练并保留记录；调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { verificationId: { type: "string" } }, required: ["verificationId"] } },
  { name: "delivery_review_list", description: "列出按包摘要与文件演练绑定的工程师审阅记录。", inputSchema: { type: "object", properties: {} } },
  { name: "delivery_review_create", description: "记录工程师已核对代码、断言、交付文件和本机范围；不审批、不发布。调用前必须完成实际审阅并取得明确确认。", inputSchema: { type: "object", properties: { packageId: { type: "string" }, packageDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, verificationId: { type: "string" }, reviewNote: { type: "string" }, attestations: { type: "object", properties: { code: { type: "boolean", const: true }, assertions: { type: "boolean", const: true }, deliveryFiles: { type: "boolean", const: true }, localScope: { type: "boolean", const: true } }, required: ["code", "assertions", "deliveryFiles", "localScope"], additionalProperties: false } }, required: ["packageId", "packageDigest", "verificationId", "reviewNote", "attestations"] } },
  { name: "release_approval_list", description: "列出绑定交付包摘要的发布审批记录。", inputSchema: { type: "object", properties: {} } },
  { name: "release_approve", description: "审批已成功演练且已有摘要绑定审阅记录的交付包；会授予本机发布资格，调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { packageId: { type: "string" }, packageDigest: { type: "string", pattern: "^[a-f0-9]{64}$" }, reviewId: { type: "string" } }, required: ["packageId", "packageDigest", "reviewId"] } },
  { name: "release_list", description: "列出本机发布版本、健康度和调度状态。", inputSchema: { type: "object", properties: {} } },
  { name: "release_detail", description: "读取指定本机发布版本及批次摘要。", inputSchema: { type: "object", properties: { releaseId: { type: "string" } }, required: ["releaseId"] } },
  { name: "release_create", description: "消费一次审批并激活本机发布、安排两个墙上时钟批次；调用前必须取得用户明确确认，且不代表公网发布。", inputSchema: { type: "object", properties: { approvalId: { type: "string" }, triggerAfterSeconds: { type: "integer", minimum: 1, maximum: 30 }, intervalSeconds: { type: "integer", minimum: 1, maximum: 60 }, runCount: { type: "integer", minimum: 2, maximum: 5 } }, required: ["approvalId"] } },
  { name: "release_rollback", description: "回滚到已有健康本机版本并安排恢复批次；调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { releaseId: { type: "string" }, targetReleaseId: { type: "string" }, triggerAfterSeconds: { type: "integer", minimum: 1, maximum: 30 }, intervalSeconds: { type: "integer", minimum: 1, maximum: 60 }, reason: { type: "string" } }, required: ["releaseId", "targetReleaseId", "reason"] } },
  { name: "release_monitor", description: "读取本机发布批次、告警、恢复和健康度；明确不是公网监控。", inputSchema: { type: "object", properties: {} } },
  { name: "dapi_list", description: "列出版本化DAPI。", inputSchema: { type: "object", properties: {} } },
  { name: "dapi_create", description: "从已验证发布批次创建DAPI草稿，不自动发布。", inputSchema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, sourceReleaseRunId: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["name", "slug", "sourceReleaseRunId"] } },
  { name: "xapi_list", description: "列出版本化XAPI。", inputSchema: { type: "object", properties: {} } },
  { name: "xapi_create", description: "声明式编排2—5个已发布DAPI版本，不自动发布。", inputSchema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { alias: { type: "string" }, dapiId: { type: "string" } }, required: ["alias", "dapiId"], additionalProperties: false } } }, required: ["name", "slug", "steps"] } },
  { name: "data_service_test", description: "实际执行当前DAPI/XAPI版本并保存测试证据。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" }, clientId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_publish", description: "发布已有成功测试证据的当前版本。调用前应向用户展示服务、版本摘要和端点。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_openapi", description: "读取指定DAPI/XAPI的OpenAPI 3.1文档。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_calls", description: "读取数据服务调用日志，可按服务过滤。", inputSchema: { type: "object", properties: { serviceId: { type: "string" } } } },
  { name: "service_application_list", description: "列出调用应用与授权，不返回令牌或令牌哈希。", inputSchema: { type: "object", properties: {} } },
  { name: "service_application_create", description: "创建本机调用应用并仅显示一次令牌。该操作创建持久访问能力，调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { name: { type: "string" }, serviceIds: { type: "array", items: { type: "string" } } }, required: ["name", "serviceIds"] } },
  { name: "service_application_revoke", description: "撤销本机调用应用。该操作会使令牌立即失效，调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] } },
  { name: "data_service_invoke", description: "使用服务器环境中的SHUDUO_APP_TOKEN调用已授权服务；令牌不进入模型参数。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, slug: { type: "string" }, clientId: { type: "string" }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 } }, required: ["type", "slug"] } },
  { name: "source_list", description: "列出V2真实数据源、版本、连接测试和元数据摘要。", inputSchema: { type: "object", properties: {} } },
  { name: "source_create", description: "登记仓库合成目录中的LOCAL_CSV源，不接受任意路径或凭证。", inputSchema: { type: "object", properties: { name: { type: "string" }, fileName: { type: "string" } }, required: ["name", "fileName"] } },
  { name: "source_server_mysql_create", description: "登记服务端环境已配置且白名单允许的合成MySQL表；不接收主机、账号、密码或连接串，首期只支持连接与元数据采集。", inputSchema: { type: "object", properties: { name: { type: "string" }, tableName: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$" } }, required: ["name", "tableName"] } },
  { name: "source_test", description: "真实读取当前CSV版本并记录连接证据。", inputSchema: { type: "object", properties: { sourceId: { type: "string" } }, required: ["sourceId"] } },
  { name: "source_metadata_collect", description: "基于已测试版本扫描字段类型、基数和结构变化。", inputSchema: { type: "object", properties: { sourceId: { type: "string" } }, required: ["sourceId"] } },
  { name: "source_revision_create", description: "为现有数据源创建新的合成CSV版本，不复用旧元数据。", inputSchema: { type: "object", properties: { sourceId: { type: "string" }, fileName: { type: "string" } }, required: ["sourceId", "fileName"] } },
  { name: "sync_task_list", description: "列出V2离线同步任务和全部运行证据。", inputSchema: { type: "object", properties: {} } },
  { name: "sync_task_create", description: "创建绑定源版本和元数据版本的FULL或INCREMENTAL_UPSERT草稿。", inputSchema: { type: "object", properties: { name: { type: "string" }, sourceId: { type: "string" }, targetTable: { type: "string" }, mode: { type: "string", enum: ["FULL", "INCREMENTAL_UPSERT"] }, mapping: { type: "object", additionalProperties: { type: "string" } }, keyFields: { type: "array", items: { type: "string" } }, watermarkField: { type: "string" } }, required: ["name", "sourceId", "targetTable", "mode", "mapping", "keyFields"] } },
  { name: "sync_task_run", description: "实际执行离线同步并返回读写、摘要和水位。", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "sync_target_rows", description: "读取本机合成落地区目标行，用于验收。", inputSchema: { type: "object", properties: { targetTable: { type: "string" } }, required: ["targetTable"] } },
  { name: "ingestion_plan_list", description: "列出受治理的同步Agent方案。", inputSchema: { type: "object", properties: {} } },
  { name: "ingestion_plan_create", description: "让真实模型基于现有元数据生成同步方案，不执行同步。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "ingestion_plan_apply", description: "把已验证的同步Agent方案应用为READY草稿，不自动运行。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
  { name: "stream_source_list", description: "列出本机合成实时源与不可变事件日志版本。", inputSchema: { type: "object", properties: {} } },
  { name: "stream_source_create", description: "登记仓库合成目录中的JSONL实时源；当前不连接Kafka/Flink。", inputSchema: { type: "object", properties: { name: { type: "string" }, topic: { type: "string" }, fileName: { type: "string" } }, required: ["name", "topic", "fileName"] } },
  { name: "stream_source_revision", description: "为实时源登记新的合成事件日志版本。", inputSchema: { type: "object", properties: { sourceId: { type: "string" }, fileName: { type: "string" } }, required: ["sourceId", "fileName"] } },
  { name: "stream_job_list", description: "列出实时任务、运行、Checkpoint、状态和告警。", inputSchema: { type: "object", properties: {} } },
  { name: "stream_job_create", description: "创建绑定源版本的实时任务草稿，不自动启动。", inputSchema: { type: "object", properties: { name: { type: "string" }, sourceId: { type: "string" }, targetTable: { type: "string" }, checkpointEvery: { type: "integer", minimum: 1, maximum: 100 }, maxOutOfOrderSeconds: { type: "integer", minimum: 0, maximum: 300 } }, required: ["name", "sourceId", "targetTable"] } },
  { name: "stream_job_start", description: "启动本机事件日志实际逐事件处理。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "stream_job_stop", description: "停止当前运行中的实时任务并保留终止证据。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "stream_job_recover", description: "校验Checkpoint前缀后从指定修正版本断点恢复。", inputSchema: { type: "object", properties: { jobId: { type: "string" }, sourceRevisionId: { type: "string" } }, required: ["jobId", "sourceRevisionId"] } },
  { name: "stream_job_state", description: "读取实时任务实际物化的最新证券状态。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "stream_job_checkpoints", description: "读取实时任务持久Checkpoint证据。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "stream_monitor", description: "读取延迟、吞吐、运行状态和告警；明确本机适配器边界。", inputSchema: { type: "object", properties: {} } },
  { name: "realtime_plan_list", description: "列出受治理的实时同步Agent方案。", inputSchema: { type: "object", properties: {} } },
  { name: "realtime_plan_create", description: "让真实模型基于实时源契约生成任务草稿，不读取事件行、不启动任务。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "realtime_plan_apply", description: "把已验证实时方案应用为READY草稿，不自动启动。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
  { name: "asset_list", description: "搜索由实际版本绑定生成的数据资产目录。", inputSchema: { type: "object", properties: { query: { type: "string" }, kind: { type: "string" } } } },
  { name: "asset_detail", description: "读取资产字段、证据摘要、指标、标准和血缘。", inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] } },
  { name: "asset_lineage", description: "读取来自同步、发布和数据服务版本绑定的血缘；不是完整SQL字段级解析。", inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] } },
  { name: "asset_impact", description: "读取指定资产的下游版本绑定影响范围。", inputSchema: { type: "object", properties: { assetId: { type: "string" } }, required: ["assetId"] } },
  { name: "asset_annotate", description: "为合成资产保存版本化业务名称、说明、域、负责人和标签。", inputSchema: { type: "object", properties: { assetId: { type: "string" }, businessName: { type: "string" }, description: { type: "string" }, domain: { type: "string" }, owner: { type: "string" }, classification: { type: "string", enum: ["PUBLIC_DEMO", "INTERNAL_DEMO", "RESTRICTED_DEMO"] }, tags: { type: "array", items: { type: "string" } } }, required: ["assetId", "businessName", "description", "domain", "owner"] } },
  { name: "metric_list", description: "列出版本化指标定义及实际运行。", inputSchema: { type: "object", properties: {} } },
  { name: "metric_create", description: "在可执行的落地或实时状态资产上创建SUM/COUNT指标定义。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, aggregation: { type: "string", enum: ["SUM", "COUNT_DISTINCT", "COUNT_ROWS"] }, field: { type: "string" }, groupBy: { type: "string" }, definition: { type: "string" } }, required: ["name", "code", "assetId", "aggregation", "definition"] } },
  { name: "metric_run", description: "对当前资产实际行执行指标并保存摘要。", inputSchema: { type: "object", properties: { metricId: { type: "string" } }, required: ["metricId"] } },
  { name: "standard_list", description: "列出数据标准及实际检查结果。", inputSchema: { type: "object", properties: {} } },
  { name: "standard_create", description: "为可执行资产字段创建受限语义标准。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, field: { type: "string" }, semanticType: { type: "string", enum: ["SECURITY_CODE", "CLIENT_ID", "DECIMAL_18_2", "TRADE_DATE"] }, description: { type: "string" } }, required: ["name", "code", "assetId", "field", "semanticType", "description"] } },
  { name: "standard_check", description: "在实际资产行上检查标准；无效值只返回哈希。", inputSchema: { type: "object", properties: { standardId: { type: "string" } }, required: ["standardId"] } },
  { name: "asset_agent_list", description: "列出受治理的数据资产Agent回答。", inputSchema: { type: "object", properties: {} } },
  { name: "asset_agent_create", description: "让真实模型基于资产摘要和版本绑定血缘找数据、解释口径与影响，不读取业务行。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "contract_list", description: "列出版本化数据契约、兼容策略、检查、告警和下游影响。", inputSchema: { type: "object", properties: {} } },
  { name: "contract_detail", description: "读取一个数据契约的全部不可变版本、评估和检查证据。", inputSchema: { type: "object", properties: { contractId: { type: "string" } }, required: ["contractId"] } },
  { name: "contract_create", description: "从当前实际资产元数据创建契约V1，不修改源资产。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, compatibility: { type: "string", enum: ["BACKWARD", "FULL", "NONE"] }, owner: { type: "string" }, description: { type: "string" }, qualitySlo: { type: "object", properties: { minPassRate: { type: "number", minimum: 0.5, maximum: 1 }, maxFreshnessSeconds: { type: "integer", minimum: 1, maximum: 2678400 } } } }, required: ["name", "code", "assetId", "compatibility", "owner", "description"] } },
  { name: "contract_assess", description: "评估提议字段相对当前契约的兼容性和下游影响，不自动创建版本。", inputSchema: { type: "object", properties: { contractId: { type: "string" }, fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, type: { type: "string" }, nullable: { type: "boolean" }, description: { type: "string" } }, required: ["name", "type", "nullable"], additionalProperties: false } } }, required: ["contractId"] } },
  { name: "contract_version", description: "把已评估方案创建为新契约版本；不兼容变更必须明确acknowledgeBreaking。", inputSchema: { type: "object", properties: { contractId: { type: "string" }, assessmentId: { type: "string" }, acknowledgeBreaking: { type: "boolean" } }, required: ["contractId", "assessmentId", "acknowledgeBreaking"] } },
  { name: "contract_check", description: "以当前真实资产元数据和可用实际行检查契约，失败产生告警。", inputSchema: { type: "object", properties: { contractId: { type: "string" } }, required: ["contractId"] } },
  { name: "quality_overview", description: "读取质量规则健康、运行和告警汇总。", inputSchema: { type: "object", properties: {} } },
  { name: "quality_rule_list", description: "列出版本化质量规则、运行与告警。", inputSchema: { type: "object", properties: {} } },
  { name: "quality_rule_create", description: "在有实际行的合成资产上创建质量规则，不自动运行。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, field: { type: "string" }, type: { type: "string", enum: ["NOT_NULL", "UNIQUE", "VALUE_RANGE", "ALLOWED_VALUES", "FRESHNESS_SECONDS"] }, config: { type: "object" }, description: { type: "string" } }, required: ["name", "code", "assetId", "field", "type", "config", "description"] } },
  { name: "quality_rule_version", description: "创建质量规则新版本并保留旧版本。", inputSchema: { type: "object", properties: { ruleId: { type: "string" }, field: { type: "string" }, type: { type: "string" }, config: { type: "object" }, description: { type: "string" } }, required: ["ruleId", "config", "description"] } },
  { name: "quality_rule_run", description: "在当前资产证据上实际运行质量规则，失败产生告警，通过可关联恢复。", inputSchema: { type: "object", properties: { ruleId: { type: "string" } }, required: ["ruleId"] } },
  { name: "quality_plan_list", description: "列出受治理质量Agent规则方案。", inputSchema: { type: "object", properties: {} } },
  { name: "quality_plan_create", description: "让真实模型基于字段元数据和聚合质量结果生成规则草稿，不读取业务行。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "quality_plan_apply", description: "把已验证质量方案应用为规则草稿，不自动运行或解除告警。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
  { name: "security_overview", description: "读取本机合成身份、策略、申请、授权与审计汇总；不是公网认证。", inputSchema: { type: "object", properties: {} } },
  { name: "security_persona_list", description: "列出本机虚构身份和角色。", inputSchema: { type: "object", properties: {} } },
  { name: "security_policy_list", description: "列出版本化行列权限与脱敏策略。", inputSchema: { type: "object", properties: {} } },
  { name: "security_policy_create", description: "创建绑定实际合成资产的最小权限策略，不自动查询。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, roles: { type: "array", items: { type: "string" } }, rowScope: { type: "string", enum: ["ALL", "ADVISOR_CLIENTS", "DENY"] }, defaultAction: { type: "string", enum: ["ALLOW", "MASK_PARTIAL", "MASK_FULL", "HASH", "DENY"] }, fieldActions: { type: "object", additionalProperties: { type: "string" } }, description: { type: "string" } }, required: ["name", "code", "assetId", "roles", "rowScope", "fieldActions", "description"] } },
  { name: "security_policy_version", description: "创建安全策略新版本并保留旧版本。", inputSchema: { type: "object", properties: { policyId: { type: "string" }, roles: { type: "array", items: { type: "string" } }, rowScope: { type: "string" }, defaultAction: { type: "string" }, fieldActions: { type: "object" }, description: { type: "string" } }, required: ["policyId", "description"] } },
  { name: "security_query", description: "以指定本机合成身份实际执行行过滤和列脱敏，并写审计。", inputSchema: { type: "object", properties: { assetId: { type: "string" }, actorId: { type: "string" } }, required: ["assetId", "actorId"] } },
  { name: "security_request_list", description: "列出权限申请及审批状态。", inputSchema: { type: "object", properties: {} } },
  { name: "security_request_create", description: "以本机合成身份申请临时READ_MASKED或READ_FULL访问。", inputSchema: { type: "object", properties: { actorId: { type: "string" }, assetId: { type: "string" }, scope: { type: "string", enum: ["READ_MASKED", "READ_FULL"] }, reason: { type: "string" } }, required: ["actorId", "assetId", "scope", "reason"] } },
  { name: "security_request_review", description: "由user-data-owner审批权限申请并创建有期限授权。", inputSchema: { type: "object", properties: { actorId: { type: "string" }, requestId: { type: "string" }, decision: { type: "string", enum: ["APPROVE", "REJECT"] }, durationHours: { type: "integer", minimum: 1, maximum: 168 }, reviewNote: { type: "string" } }, required: ["actorId", "requestId", "decision", "reviewNote"] } },
  { name: "security_audit_list", description: "列出不含业务行的安全决策审计。", inputSchema: { type: "object", properties: {} } },
  { name: "security_plan_list", description: "列出受治理安全Agent策略方案。", inputSchema: { type: "object", properties: {} } },
  { name: "security_plan_create", description: "让真实模型基于合成身份和字段元数据生成最小权限草稿，不读取业务行。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "security_plan_apply", description: "把已验证安全方案应用为策略V1，不执行查询或审批。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
  { name: "report_overview", description: "读取报表数据集、报告和实际运行汇总。", inputSchema: { type: "object", properties: {} } },
  { name: "report_dataset_list", description: "列出报表数据集和不可变快照摘要。", inputSchema: { type: "object", properties: {} } },
  { name: "report_dataset_create", description: "从可报表资产创建字段受限数据集草稿，不复制数据。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, assetId: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["name", "code", "assetId", "fields"] } },
  { name: "report_dataset_refresh", description: "将实际资产行物化到独立报表快照库并保存摘要。", inputSchema: { type: "object", properties: { datasetId: { type: "string" } }, required: ["datasetId"] } },
  { name: "report_list", description: "列出版本化报表、聚合组件和运行。", inputSchema: { type: "object", properties: {} } },
  { name: "report_create", description: "创建绑定数据集快照的聚合报表草稿，不自动执行。", inputSchema: { type: "object", properties: { name: { type: "string" }, code: { type: "string" }, datasetId: { type: "string" }, description: { type: "string" }, widgets: { type: "array", items: { type: "object" } } }, required: ["name", "code", "datasetId", "description", "widgets"] } },
  { name: "report_version", description: "创建报表新版本并固定当前数据集快照。", inputSchema: { type: "object", properties: { reportId: { type: "string" }, description: { type: "string" }, widgets: { type: "array", items: { type: "object" } } }, required: ["reportId", "description", "widgets"] } },
  { name: "report_run", description: "对固定快照实际运行KPI/柱状/饼图聚合并保存摘要。", inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] } },
  { name: "report_export", description: "导出最后一次成功聚合结果CSV；不导出业务明细。", inputSchema: { type: "object", properties: { reportId: { type: "string" } }, required: ["reportId"] } },
  { name: "report_plan_list", description: "列出受治理报表Agent方案。", inputSchema: { type: "object", properties: {} } },
  { name: "report_plan_create", description: "让真实模型基于数据集字段和快照摘要生成聚合报表草稿，不读取业务行。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "report_plan_apply", description: "把已验证报表方案应用为草稿，不执行或导出。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
  { name: "ops_overview", description: "读取跨开发、同步、发布、质量、服务、报表和安全审计的本机运行健康。", inputSchema: { type: "object", properties: {} } },
  { name: "ops_refresh", description: "扫描实际失败与恢复证据并幂等归一为运维事故。", inputSchema: { type: "object", properties: {} } },
  { name: "ops_incident_list", description: "列出开放、已确认和已恢复事故。", inputSchema: { type: "object", properties: {} } },
  { name: "ops_incident_detail", description: "读取事故源证据、恢复证据和人工事件，不返回业务行。", inputSchema: { type: "object", properties: { incidentId: { type: "string" } }, required: ["incidentId"] } },
  { name: "ops_incident_acknowledge", description: "确认开放事故并记录操作人和说明；不等于解决。", inputSchema: { type: "object", properties: { incidentId: { type: "string" }, actor: { type: "string" }, note: { type: "string" } }, required: ["incidentId", "note"] } },
  { name: "ops_incident_resolve", description: "仅用同资源、晚于失败的成功运行证据解除事故。", inputSchema: { type: "object", properties: { incidentId: { type: "string" }, actor: { type: "string" }, evidenceKind: { type: "string" }, evidenceId: { type: "string" }, note: { type: "string" } }, required: ["incidentId", "evidenceKind", "evidenceId", "note"] } },
  { name: "ops_diagnosis_list", description: "列出受治理运维Agent诊断。", inputSchema: { type: "object", properties: {} } },
  { name: "ops_diagnosis_create", description: "让真实模型基于事故与聚合证据诊断，不读取业务行、不执行处置。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "full_lifecycle_evaluation_latest", description: "读取最新20条本机完整链路评测、各阶段证据和失败/取消/救援记录；不是公网E2E。", inputSchema: { type: "object", properties: {} } },
];

export const V2_MCP_OPERATIONS = Object.freeze([...V2_OPERATIONS]);
export const V2_MCP_TOOL_NAMES = Object.freeze(tools.map((tool) => tool.name));

const client = new V2Client({
  baseUrl:
    process.env.SHUDUO_V2_API_BASE_URL ??
    "http://127.0.0.1:3100/api/v2",
  client: "mcp",
});
const typePath = (value) => {
  if (!['dapi', 'xapi'].includes(value)) throw new Error("type必须是dapi或xapi");
  return value + "s";
};
async function callTool(name, args = {}) {
  if (name === "v2_status") return client.request("/status");
  if (name === "budget_status") return client.request("/budget");
  if (name === "agent_intent_list") return client.request("/agent/intents");
  if (name === "agent_tool_list") return client.request("/agent/tools");
  if (name === "agent_tool_validate")
    return client.request(
      `/agent/tools/${encodeURIComponent(args.toolId)}/validate`,
      {
        method: "POST",
        body: {
          catalogVersion: args.catalogVersion,
          contractDigest: args.contractDigest,
          input: args.input,
        },
      },
    );
  if (name === "agent_tool_invoke")
    return client.request(
      `/agent/intents/${encodeURIComponent(args.intentId)}/tools/${encodeURIComponent(args.toolId)}/invoke`,
      {
        method: "POST",
        body: {
          catalogVersion: args.catalogVersion,
          contractDigest: args.contractDigest,
          approvalId: args.approvalId,
          input: args.input,
        },
      },
    );
  if (name === "agent_intent_create")
    return client.request("/agent/intents", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "agent_intent_approval_list")
    return client.request(`/agent/intents/${encodeURIComponent(args.intentId)}/approvals`);
  if (name === "agent_intent_approval_create")
    return client.request(
      `/agent/intents/${encodeURIComponent(args.intentId)}/approvals`,
      { method: "POST", body: { destinationId: args.destinationId } },
    );
  if (name === "agent_intent_graph")
    return client.request(`/agent/intents/${encodeURIComponent(args.intentId)}/graph`);
  if (name === "agent_intent_cancel")
    return client.request(
      `/agent/intents/${encodeURIComponent(args.intentId)}/cancel`,
      { method: "POST", body: {} },
    );
  if (name === "agent_specialist_cancel")
    return client.request(
      `/agent/intents/${encodeURIComponent(args.intentId)}/children/${encodeURIComponent(args.destinationId)}/cancel`,
      { method: "POST", body: {} },
    );
  if (name === "agent_intent_handoff_list")
    return client.request(`/agent/intents/${encodeURIComponent(args.intentId)}/handoffs`);
  if (name === "agent_intent_handoff_create")
    return client.request(
      `/agent/intents/${encodeURIComponent(args.intentId)}/handoffs`,
      { method: "POST", body: { destinationId: args.destinationId } },
    );
  if (name === "agent_intent_trace")
    return client.request(`/agent/intents/${encodeURIComponent(args.intentId)}/trace`);
  if (name === "agent_journey")
    return client.request(`/agent/tasks/${encodeURIComponent(args.taskId)}/journey`);
  if (name === "agent_delivery_list")
    return client.request(
      `/agent/deliveries${args.sourceAgentTaskId ? `?sourceAgentTaskId=${encodeURIComponent(args.sourceAgentTaskId)}` : ""}`,
    );
  if (name === "agent_delivery_prepare")
    return client.request(
      `/agent/tasks/${encodeURIComponent(args.taskId)}/prepare-delivery`,
      { method: "POST", body: {} },
    );
  if (name === "agent_delivery_detail")
    return client.request(`/agent/deliveries/${encodeURIComponent(args.deliveryTaskId)}`);
  if (name === "agent_delivery_cancel")
    return client.request(
      `/agent/deliveries/${encodeURIComponent(args.deliveryTaskId)}/cancel`,
      { method: "POST", body: {} },
    );
  if (name === "release_runs_list") return client.request("/release/runs");
  if (name === "delivery_package_list") return client.request("/delivery/packages");
  if (name === "delivery_package_detail")
    return client.request(
      `/delivery/packages/${encodeURIComponent(args.packageId)}`,
    );
  if (name === "delivery_package_create")
    return client.request("/delivery/packages", {
      method: "POST",
      body: { sourceRunId: args.sourceRunId, name: args.name },
    });
  if (name === "delivery_package_verify")
    return client.request(
      `/delivery/packages/${encodeURIComponent(args.packageId)}/verify`,
      { method: "POST", body: { scheduledFor: args.scheduledFor } },
    );
  if (name === "delivery_verification_list")
    return client.request("/delivery/verifications");
  if (name === "delivery_verification_detail")
    return client.request(
      `/delivery/verifications/${encodeURIComponent(args.verificationId)}`,
    );
  if (name === "delivery_verification_cancel")
    return client.request(
      `/delivery/verifications/${encodeURIComponent(args.verificationId)}/cancel`,
      { method: "POST", body: {} },
    );
  if (name === "delivery_review_list")
    return client.request("/delivery/reviews");
  if (name === "delivery_review_create")
    return client.request(
      `/delivery/packages/${encodeURIComponent(args.packageId)}/review`,
      {
        method: "POST",
        body: {
          packageDigest: args.packageDigest,
          verificationId: args.verificationId,
          reviewNote: args.reviewNote,
          attestations: args.attestations,
        },
      },
    );
  if (name === "release_approval_list")
    return client.request("/release/approvals");
  if (name === "release_approve")
    return client.request(
      `/delivery/packages/${encodeURIComponent(args.packageId)}/approve`,
      {
        method: "POST",
        body: {
          packageDigest: args.packageDigest,
          reviewId: args.reviewId,
        },
      },
    );
  if (name === "release_list") return client.request("/releases");
  if (name === "release_detail")
    return client.request(`/releases/${encodeURIComponent(args.releaseId)}`);
  if (name === "release_create")
    return client.request("/releases", {
      method: "POST",
      body: {
        approvalId: args.approvalId,
        triggerAfterSeconds: args.triggerAfterSeconds ?? 5,
        intervalSeconds: args.intervalSeconds ?? 15,
        runCount: args.runCount ?? 2,
      },
    });
  if (name === "release_rollback")
    return client.request(
      `/releases/${encodeURIComponent(args.releaseId)}/rollback`,
      {
        method: "POST",
        body: {
          targetReleaseId: args.targetReleaseId,
          triggerAfterSeconds: args.triggerAfterSeconds ?? 5,
          intervalSeconds: args.intervalSeconds ?? 15,
          reason: args.reason,
        },
      },
    );
  if (name === "release_monitor")
    return client.request("/monitoring/overview");
  if (name === "dapi_list") return client.request("/data-services/dapis");
  if (name === "xapi_list") return client.request("/data-services/xapis");
  if (name === "dapi_create")
    return client.request("/data-services/dapis", { method: "POST", body: args });
  if (name === "xapi_create")
    return client.request("/data-services/xapis", { method: "POST", body: args });
  if (["data_service_test", "data_service_publish", "data_service_openapi"].includes(name)) {
    const action = { data_service_test: "test", data_service_publish: "publish", data_service_openapi: "openapi" }[name],
      path = `/data-services/${typePath(args.type)}/${encodeURIComponent(args.serviceId)}/${action}`;
    return client.request(path, {
      ...(action === "openapi"
        ? {}
        : {
            method: "POST",
            body:
              action === "test"
                ? { clientId: args.clientId, page: 1, pageSize: 20 }
                : {},
          }),
    });
  }
  if (name === "data_service_calls")
    return client.request(
      `/data-services/calls${args.serviceId ? `?service_id=${encodeURIComponent(args.serviceId)}` : ""}`,
    );
  if (name === "service_application_list")
    return client.request("/data-services/applications");
  if (name === "service_application_create")
    return client.request("/data-services/applications", { method: "POST", body: args });
  if (name === "service_application_revoke")
    return client.request(
      `/data-services/applications/${encodeURIComponent(args.applicationId)}/revoke`,
      { method: "POST", body: {} },
    );
  if (name === "data_service_invoke") {
    if (!process.env.SHUDUO_APP_TOKEN)
      throw new Error("MCP服务未配置SHUDUO_APP_TOKEN");
    const query = new URLSearchParams({
      page: String(args.page ?? 1),
      page_size: String(args.pageSize ?? 20),
      ...(args.clientId ? { client_id: args.clientId } : {}),
    });
    return client.request(
      `/open/${typePath(args.type)}/${encodeURIComponent(args.slug)}?${query}`,
      { authorization: `Bearer ${process.env.SHUDUO_APP_TOKEN}` },
    );
  }
  if (name === "source_list") return client.request("/sources");
  if (name === "source_create")
    return client.request("/sources", {
      method: "POST",
      body: { ...args, sourceType: "LOCAL_CSV" },
    });
  if (name === "source_server_mysql_create")
    return client.request("/sources", {
      method: "POST",
      body: { name: args.name, sourceType: "SERVER_MYSQL", tableName: args.tableName },
    });
  if (["source_test", "source_metadata_collect"].includes(name))
    return client.request(
      `/sources/${encodeURIComponent(args.sourceId)}/${name === "source_test" ? "test" : "metadata"}`,
      { method: "POST", body: {} },
    );
  if (name === "source_revision_create")
    return client.request(
      `/sources/${encodeURIComponent(args.sourceId)}/revisions`,
      { method: "POST", body: { fileName: args.fileName } },
    );
  if (name === "sync_task_list") return client.request("/sync/tasks");
  if (name === "sync_task_create")
    return client.request("/sync/tasks", { method: "POST", body: args });
  if (name === "sync_task_run")
    return client.request(`/sync/tasks/${encodeURIComponent(args.taskId)}/run`, {
      method: "POST",
      body: {},
    });
  if (name === "sync_target_rows")
    return client.request(
      `/sync/targets/${encodeURIComponent(args.targetTable)}/rows`,
    );
  if (name === "ingestion_plan_list") return client.request("/sync/agent/plans");
  if (name === "ingestion_plan_create")
    return client.request("/sync/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "ingestion_plan_apply")
    return client.request(
      `/sync/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
  if (name === "stream_source_list") return client.request("/streams/sources");
  if (name === "stream_source_create")
    return client.request("/streams/sources", {
      method: "POST",
      body: { ...args, adapter: "local-event-log-v1" },
    });
  if (name === "stream_source_revision")
    return client.request(
      `/streams/sources/${encodeURIComponent(args.sourceId)}/revisions`,
      { method: "POST", body: { fileName: args.fileName } },
    );
  if (name === "stream_job_list") return client.request("/streams/jobs");
  if (name === "stream_job_create")
    return client.request("/streams/jobs", { method: "POST", body: args });
  if (["stream_job_start", "stream_job_stop"].includes(name))
    return client.request(
      `/streams/jobs/${encodeURIComponent(args.jobId)}/${name === "stream_job_start" ? "start" : "stop"}`,
      { method: "POST", body: {} },
    );
  if (name === "stream_job_recover")
    return client.request(
      `/streams/jobs/${encodeURIComponent(args.jobId)}/recover`,
      {
        method: "POST",
        body: { sourceRevisionId: args.sourceRevisionId },
      },
    );
  if (["stream_job_state", "stream_job_checkpoints"].includes(name))
    return client.request(
      `/streams/jobs/${encodeURIComponent(args.jobId)}/${name === "stream_job_state" ? "state" : "checkpoints"}`,
    );
  if (name === "stream_monitor") return client.request("/streams/monitor");
  if (name === "realtime_plan_list")
    return client.request("/streams/agent/plans");
  if (name === "realtime_plan_create")
    return client.request("/streams/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "realtime_plan_apply")
    return client.request(
      `/streams/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
  if (name === "asset_list") {
    const query = new URLSearchParams({
      ...(args.query ? { q: args.query } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
    });
    return client.request(`/assets${query.size ? `?${query}` : ""}`);
  }
  if (["asset_detail", "asset_lineage", "asset_impact"].includes(name)) {
    const action = {
      asset_detail: "",
      asset_lineage: "/lineage",
      asset_impact: "/impact",
    }[name];
    return client.request(`/assets/${encodeURIComponent(args.assetId)}${action}`);
  }
  if (name === "asset_annotate") {
    const { assetId, ...body } = args;
    return client.request(`/assets/${encodeURIComponent(assetId)}/annotation`, {
      method: "POST",
      body,
    });
  }
  if (name === "metric_list") return client.request("/metrics");
  if (name === "metric_create")
    return client.request("/metrics", { method: "POST", body: args });
  if (name === "metric_run")
    return client.request(`/metrics/${encodeURIComponent(args.metricId)}/run`, {
      method: "POST",
      body: {},
    });
  if (name === "standard_list") return client.request("/standards");
  if (name === "standard_create")
    return client.request("/standards", { method: "POST", body: args });
  if (name === "standard_check")
    return client.request(
      `/standards/${encodeURIComponent(args.standardId)}/check`,
      { method: "POST", body: {} },
    );
  if (name === "asset_agent_list") return client.request("/assets/agent/tasks");
  if (name === "asset_agent_create")
    return client.request("/assets/agent/tasks", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "contract_list") return client.request("/contracts");
  if (name === "contract_detail")
    return client.request(
      `/contracts/${encodeURIComponent(args.contractId)}`,
    );
  if (name === "contract_create")
    return client.request("/contracts", { method: "POST", body: args });
  if (name === "contract_assess") {
    const { contractId, ...body } = args;
    return client.request(
      `/contracts/${encodeURIComponent(contractId)}/assess`,
      { method: "POST", body },
    );
  }
  if (name === "contract_version") {
    const { contractId, ...body } = args;
    return client.request(
      `/contracts/${encodeURIComponent(contractId)}/versions`,
      { method: "POST", body },
    );
  }
  if (name === "contract_check")
    return client.request(
      `/contracts/${encodeURIComponent(args.contractId)}/check`,
      { method: "POST", body: {} },
    );
  if (name === "quality_overview") return client.request("/quality/overview");
  if (name === "quality_rule_list") return client.request("/quality/rules");
  if (name === "quality_rule_create")
    return client.request("/quality/rules", { method: "POST", body: args });
  if (name === "quality_rule_version") {
    const { ruleId, ...body } = args;
    return client.request(
      `/quality/rules/${encodeURIComponent(ruleId)}/versions`,
      { method: "POST", body },
    );
  }
  if (name === "quality_rule_run")
    return client.request(
      `/quality/rules/${encodeURIComponent(args.ruleId)}/run`,
      { method: "POST", body: {} },
    );
  if (name === "quality_plan_list")
    return client.request("/quality/agent/plans");
  if (name === "quality_plan_create")
    return client.request("/quality/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "quality_plan_apply")
    return client.request(
      `/quality/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
  if (name === "security_overview") return client.request("/security/overview");
  if (name === "security_persona_list") return client.request("/security/personas");
  if (name === "security_policy_list") return client.request("/security/policies");
  if (name === "security_policy_create")
    return client.request("/security/policies", { method: "POST", body: args });
  if (name === "security_policy_version") {
    const { policyId, ...body } = args;
    return client.request(
      `/security/policies/${encodeURIComponent(policyId)}/versions`,
      { method: "POST", body },
    );
  }
  if (name === "security_query")
    return client.request(`/security/query/${encodeURIComponent(args.assetId)}`, {
      method: "POST",
      body: {},
      actorId: args.actorId,
    });
  if (name === "security_request_list") return client.request("/security/requests");
  if (name === "security_request_create") {
    const { actorId, ...body } = args;
    return client.request("/security/requests", {
      method: "POST",
      body,
      actorId,
    });
  }
  if (name === "security_request_review") {
    const { actorId, requestId, ...body } = args;
    return client.request(
      `/security/requests/${encodeURIComponent(requestId)}/review`,
      { method: "POST", body, actorId },
    );
  }
  if (name === "security_audit_list") return client.request("/security/audits");
  if (name === "security_plan_list") return client.request("/security/agent/plans");
  if (name === "security_plan_create")
    return client.request("/security/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "security_plan_apply")
    return client.request(
      `/security/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
  if (name === "report_overview") return client.request("/reports/overview");
  if (name === "report_dataset_list") return client.request("/reports/datasets");
  if (name === "report_dataset_create")
    return client.request("/reports/datasets", { method: "POST", body: args });
  if (name === "report_dataset_refresh")
    return client.request(
      `/reports/datasets/${encodeURIComponent(args.datasetId)}/refresh`,
      { method: "POST", body: {} },
    );
  if (name === "report_list") return client.request("/reports");
  if (name === "report_create")
    return client.request("/reports", { method: "POST", body: args });
  if (name === "report_version") {
    const { reportId, ...body } = args;
    return client.request(`/reports/${encodeURIComponent(reportId)}/versions`, {
      method: "POST",
      body,
    });
  }
  if (name === "report_run")
    return client.request(`/reports/${encodeURIComponent(args.reportId)}/run`, {
      method: "POST",
      body: {},
    });
  if (name === "report_export")
    return client.request(`/reports/${encodeURIComponent(args.reportId)}/export`);
  if (name === "report_plan_list") return client.request("/reports/agent/plans");
  if (name === "report_plan_create")
    return client.request("/reports/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "report_plan_apply")
    return client.request(
      `/reports/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
  if (name === "ops_overview") return client.request("/operations/overview");
  if (name === "ops_refresh")
    return client.request("/operations/refresh", { method: "POST", body: {} });
  if (name === "ops_incident_list")
    return client.request("/operations/incidents");
  if (name === "ops_incident_detail")
    return client.request(
      `/operations/incidents/${encodeURIComponent(args.incidentId)}`,
    );
  if (name === "ops_incident_acknowledge") {
    const { incidentId, ...body } = args;
    return client.request(
      `/operations/incidents/${encodeURIComponent(incidentId)}/acknowledge`,
      { method: "POST", body },
    );
  }
  if (name === "ops_incident_resolve") {
    const { incidentId, ...body } = args;
    return client.request(
      `/operations/incidents/${encodeURIComponent(incidentId)}/resolve`,
      { method: "POST", body },
    );
  }
  if (name === "ops_diagnosis_list")
    return client.request("/operations/agent/diagnoses");
  if (name === "ops_diagnosis_create")
    return client.request("/operations/agent/diagnoses", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "full_lifecycle_evaluation_latest")
    return client.request("/evaluations/full-lifecycle/latest");
  throw new Error(`未知V2 MCP工具：${name}`);
}
const response = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const errorResponse = (id, code, message, data) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
export async function handleV2Mcp(message) {
  if (message.method === "initialize")
    return response(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "shuduo-v2-mcp", version: "0.1.0" },
    });
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "tools/list") return response(message.id, { tools });
  if (message.method === "tools/call") {
    try {
      const result = await callTool(
        message.params?.name,
        message.params?.arguments,
      );
      return response(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(message.id, -32000, error.message, {
        status: error.status,
        code: error.code,
      });
    }
  }
  return errorResponse(message.id, -32601, `不支持的方法：${message.method}`);
}

if (process.argv[1] && process.argv[1].endsWith("shuduo-mcp.mjs")) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const output = await handleV2Mcp(JSON.parse(line));
      if (output) process.stdout.write(output + "\n");
    } catch (error) {
      process.stdout.write(errorResponse(null, -32700, error.message) + "\n");
    }
  }
}
