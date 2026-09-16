# V2 API 契约与实现边界

更新：2026-09-15。基础地址为本地开发服务的 `/api/v2`。以下接口已实现；`shuzhan`与`shuzhan-mcp`使用该契约，旧`dataplatform`命令仍是V1模拟，不能作为V2证据。交付包、演练、独立审阅、审批、发布、回滚和监控已补齐CLI/MCP映射；危险动作的MCP说明要求显式确认。

## 权限与请求

本地开发仍只绑定回环地址并绕过登录。公网模式支持匿名只读与受邀会话；写请求要求JSON、已允许Origin、`X-Shuzhan-Client`、会话Cookie、CSRF和项目角色权限。客户端标记本身不是身份。
匿名写入返回401；缺CSRF、跨项目或越权返回403；未知记录返回404；无效参数返回400。公网模型Key写入始终拒绝。
SQL 上限 20,000 字符，请求体上限 100 KB。任务/运行请求必须携带 `Idempotency-Key`。

| 方法与路径 | 输入 / 行为 | 输出 |
|---|---|---|
| GET /status | 配置状态，永不返回密钥 | 模块范围、Spark/模型/元数据/产物/预算状态；接入域返回可用源类型和SERVER_ENV_ONLY凭证模式，不返回连接信息 |
| GET /budget | 无 | 当月模型估算、远程Spark次数/秒数、资源门和账号账单连接状态 |
| GET /cloud/readiness | 本地开发或ADMIN会话 | 只返回脱敏部署门、失败项、生成时间和账单摘要；公开匿名拒绝，绝不返回资源标识或审计原文 |
| GET /auth/session | Cookie可选 | 当前受邀用户、角色、权限和过期时间；匿名返回authenticated=false |
| POST /auth/login | 邮箱/密码 | 建立8小时会话，设置会话/CSRF Cookie；错误不区分用户是否存在 |
| POST /auth/redeem | 一次性邀请码/显示名称/密码 | 创建受邀项目成员、使邀请码失效并登录 |
| POST /auth/logout | Cookie + CSRF | 撤销服务端会话并清除两类Cookie |
| POST /auth/password | 当前密码、新密码 + Cookie/CSRF | 更新scrypt哈希、撤销全部旧会话并签发新会话 |
| GET/POST /auth/invitations | ADMIN会话；创建时邮箱/角色 | 列表不返回哈希；创建邀请码只显示一次、7天到期 |
| POST /settings/model-key | 仅本地开发模式；apiKey | 保存到权限 0600 的 .env.local，只返回 configured；不自动调用模型 |
| GET /contexts | 五组虚构证券输入 | 表结构、口径、参考 SQL；不含独立预期结果 |
| POST /revisions | sql、contextId | 201；不可变版本、SHA-256 |
| GET /revisions | 当前项目版本列表 | 版本、代码、来源和时间 |
| GET /revisions/:id | 指定版本 | 版本详情 |
| POST /runs | revisionId + 幂等键 | 202；后台运行编号 |
| GET /runs | 当前项目历史 | 状态、版本、真实结果、引擎和验证 |
| GET /runs/:id | 查询状态 | 同上 |
| POST /runs/:id/cancel | 取消当前/排队运行 | 明确 CANCELLED；不会随后变为成功 |
| GET /runs/:id/bundle | 仅允许已通过验证的运行 | SQL、结果、断言、引擎和版本；NOT_PUBLISHED |
| POST /agent/tasks | message、sql、contextId + 幂等键 | 202；真实模型任务编号；缺配置返回 503 |
| GET /agent/tasks | 历史委托 | 状态、尝试次数、用量和产物 |
| GET /agent/tasks/:id | 指定委托 | 同上 |
| GET /agent/intents | 受邀用户的跨模块Agent意图记录 | 路由、风险、摘要和模型用量；公网匿名拒绝读取 |
| POST /agent/intents | message + 幂等键 | 202；模型仅从白名单模块推荐下一步，固定NO_EXECUTION，不创建下游任务 |
| GET/POST /agent/intents/:id/handoffs | 只读交接或destinationId + 幂等键 | 仅当前意图所有者或ADMIN可读取；只能交接到已推荐模块，记录草稿交接但不执行下游任务 |
| GET /agent/tasks/:id/journey | 只读指定委托 | 七阶段现有版本/运行/交付/审批/计时批次/监控证据与责任归属；固定非Agent自主E2E、非公网，不返回业务行或原始报错 |
| POST /agent/tasks/:id/prepare-delivery | 空对象 + 幂等键 | 仅对真实模型+Spark独立断言成功任务返回后台交付准备编号；生成不可变调度/部署包并真实文件演练，不审批或发布 |
| GET /agent/deliveries | 可选sourceAgentTaskId | 列出受控准备阶段、包摘要、演练与失败；不返回密码/业务行 |
| GET /agent/deliveries/:id | 无 | 指定准备任务；成功阶段AWAITING_ENGINEER_REVIEW，范围DELIVERY_PREPARATION |
| POST /agent/deliveries/:id/cancel | 空对象 | 取消排队/运行中的文件演练并保留包和运行状态，不会随后变成成功 |
| POST /agent/tasks/:id/cancel | 取消委托及其执行 | CANCELLED |
| GET /delivery/packages | 当前项目交付包摘要列表 | 不返回大段文件正文 |
| POST /delivery/packages | sourceRunId、name + 幂等键 | 当前验证通过版本的不可变文件包；NOT_PUBLISHED |
| GET /delivery/packages/:id | 交付包详情 | manifest、files、digest，可导出JSON |
| POST /delivery/packages/:id/verify | scheduledFor + 幂等键 | 202；本机按文件演练编号，不发布 |
| GET /delivery/reviews | 本机工程师审阅记录 | 只读包摘要、演练编号、逐项确认与身份摘要；不返回业务行 |
| POST /delivery/packages/:id/review | packageDigest、verificationId、reviewNote、四项确认 + 幂等键 | 只在当前包成功按文件演练后保存独立审阅记录；不审批、不发布 |
| GET /delivery/verifications | 当前项目演练历史 | 文件摘要、状态与实际运行证据 |
| GET /delivery/verifications/:id | 指定演练 | 同上 |
| POST /delivery/verifications/:id/cancel | 取消排队/运行中的演练 | CANCELLED |
| GET /release/approvals | 本机审批记录 | 包摘要、源SQL哈希、演练与审阅证据 |
| POST /delivery/packages/:id/approve | packageDigest、reviewId + 幂等键 | 只审批摘要、成功演练和独立审阅记录三者一致的不可变包 |
| GET /releases | 本机发布版本 | 状态、健康度、摘要、审批与批次计数；不返回本机绝对路径 |
| POST /releases | approvalId、1—300秒短周期、2—3批 + 幂等键 | 激活本机版本并持久化计时计划；publicDeployed=false |
| GET /releases/:id | 指定本机发布版本 | 版本、健康、源摘要及批次统计 |
| POST /releases/:id/rollback | 健康历史targetReleaseId、原因、恢复周期 | 回滚并安排两个墙上时钟恢复批次 |
| GET /release/runs | 发布批次历史 | 计划/触发/完成时间、Spark、断言、日志摘要和状态 |
| GET /release/runs/:id | 指定发布批次 | 同上；工作区路径被替换为占位符 |
| GET /monitoring/overview | 本机发布监控 | 当前版本、全局计数、事件、开放/已恢复告警 |
| GET/POST /data-services/dapis | 列表或创建DAPI草稿 | 草稿绑定真实成功发布批次、字段投影、超时和限流 |
| GET/POST /data-services/xapis | 列表或创建XAPI草稿 | 声明式绑定2—5个已发布DAPI精确版本 |
| GET /data-services/{dapis\|xapis}/:id | 服务与版本详情 | 当前、已发布及历史不可变版本 |
| POST /data-services/{dapis\|xapis}/:id/versions | 新版本配置 + 幂等键 | 创建新草稿版本，不影响当前已发布版本 |
| POST /data-services/{dapis\|xapis}/:id/test | clientId/page/pageSize | 实际业务SQLite查询或组合结果，保存结果摘要 |
| POST /data-services/{dapis\|xapis}/:id/publish | 空对象 | 仅发布当前测试通过且摘要一致的版本 |
| POST /data-services/{dapis\|xapis}/:id/activate | versionId | 切换到该服务已测试发布过的历史版本 |
| GET /data-services/{dapis\|xapis}/:id/openapi | 当前或已发布版本 | OpenAPI 3.1、Bearer、参数及错误响应 |
| GET /data-services/calls | 可选service_id | 版本、应用、参数、耗时、结果摘要及结果状态 |
| GET/POST /data-services/applications | 列表或创建 | 列表不返回哈希；创建令牌仅显示一次 |
| POST /data-services/applications/:id/revoke | 空对象 | 立即撤销应用令牌 |
| GET /open/dapis/:slug | Bearer + client_id/page/page_size | 参数化业务查询、分页、限流、超时及调用ID |
| GET /open/xapis/:slug | Bearer + client_id/page/page_size | 固定子版本组合结果及调用ID |
| GET/POST /data-services/agent/plans | 列表或自然语言需求 | 后台真实模型方案，范围为DATA_SERVICE_DESIGN |
| GET /data-services/agent/plans/:id | 方案状态 | 受治理提案、模型用量或明确失败 |
| POST /data-services/agent/plans/:id/apply | 空对象 | 人工应用已验证方案为草稿，不自动发布 |
| GET/POST /sources | 列表或name/sourceType/fileName | 创建仅限合成目录的LOCAL_CSV源及V1版本 |
| GET /sources/:id | 数据源详情 | 当前版本、历史版本、连接测试和元数据版本 |
| POST /sources/:id/test | 空对象 | 真实读取文件并记录摘要、字节、行列数和耗时 |
| POST /sources/:id/metadata | 空对象 | 实际扫描字段类型、可空、基数、结构摘要和变化 |
| POST /sources/:id/revisions | fileName + 幂等键 | 创建不可变源版本；旧测试/元数据不自动复用 |
| GET/POST /sync/tasks | 列表或映射/主键/水位/模式 | 创建绑定源及元数据版本的离线同步任务 |
| GET /sync/tasks/:id | 任务详情 | 配置摘要、状态、水位和全部成功/失败运行 |
| POST /sync/tasks/:id/run | 空对象 + 幂等键 | 执行FULL或INCREMENTAL_UPSERT，返回实际读写与目标摘要 |
| GET /sync/targets/:table/rows | 目标表 | 读取本机落地区实际行；仅用于当前合成验收 |
| GET/POST /sync/agent/plans | 列表或自然语言需求 | 后台真实模型同步方案，范围为OFFLINE_SYNC_DESIGN |
| GET /sync/agent/plans/:id | 方案状态 | 元数据约束提案、模型用量或明确失败 |
| POST /sync/agent/plans/:id/apply | 空对象 | 人工应用已验证方案为READY任务，不自动运行 |
| GET/POST /streams/sources | 列表或name/topic/fileName | 登记仅限合成目录的local-event-log-v1源 |
| POST /streams/sources/:id/revisions | fileName + 幂等键 | 创建事件日志版本，保存行数和内容摘要 |
| GET/POST /streams/jobs | 列表或源/目标/Checkpoint/乱序配置 | 创建版本绑定的实时任务 |
| GET /streams/jobs/:id | 任务详情 | 全部运行、Checkpoint、最新状态和告警 |
| POST /streams/jobs/:id/start | 空对象 + 幂等键 | 后台从offset0逐条处理，立即返回运行号 |
| POST /streams/jobs/:id/recover | sourceRevisionId + 幂等键 | 校验Checkpoint前缀后从下一offset恢复 |
| POST /streams/jobs/:id/stop | 空对象 | 中止本机处理并保留STOPPED运行 |
| GET /streams/jobs/:id/state | 无 | 按证券读取实际最新状态 |
| GET /streams/jobs/:id/checkpoints | 无 | offset、事件数、水位、前缀和状态摘要 |
| GET /streams/monitor | 无 | 任务、吞吐/延迟、成功/失败与告警汇总，并披露Kafka/Flink未连接 |
| GET/POST /streams/agent/plans | 列表或自然语言需求 | 后台真实模型实时方案，范围为REALTIME_SYNC_DESIGN |
| GET /streams/agent/plans/:id | 方案状态 | 受治理提案、模型用量或明确失败 |
| POST /streams/agent/plans/:id/apply | 空对象 | 人工应用已验证方案为READY任务，不自动启动 |
| POST /streams/agent/plans/:id/cancel | 空对象 | 取消排队或运行中的方案并保留记录 |
| GET /assets | q/kind可选 | 搜索从当前实际资源和版本关系投影的逻辑资产目录 |
| GET /assets/:id | 资产编号 | 字段、证据摘要、说明、血缘、指标与标准 |
| POST /assets/:id/annotation | 业务名称/说明/域/负责人/分类/标签 | 保存新的资产说明版本，不覆盖底层证据 |
| GET /assets/:id/lineage | 无 | 上下游版本绑定及同步字段映射；明确SQL字段级解析状态 |
| GET /assets/:id/impact | 无 | 基于有向版本绑定的下游影响范围 |
| GET/POST /metrics | 列表或资产/聚合/字段/分组/口径 | 版本化指标定义；首版只支持实际落地/实时状态行 |
| GET /metrics/:id | 无 | 指标定义与全部实际运行 |
| POST /metrics/:id/run | 空对象 + 幂等键 | 用整数分精确SUM或COUNT执行，保存结果摘要 |
| GET/POST /standards | 列表或资产/字段/语义类型/说明 | 创建版本化数据标准 |
| GET /standards/:id | 无 | 标准定义与全部实际检查 |
| POST /standards/:id/check | 空对象 + 幂等键 | 在实际行上检查；无效值只返回SHA-256 |
| GET/POST /contracts | 列表或名称/代码/资产/兼容策略/责任人/说明/SLO | 从当前资产字段与证据创建契约V1；代码唯一，不接受业务行 |
| GET /contracts/:id | 无 | 当前及历史不可变版本、评估、检查、告警与版本绑定下游影响 |
| POST /contracts/:id/assess | 可选fields + 幂等键 | 对当前版本评估结构差异、兼容性和下游影响；不自动改版本 |
| POST /contracts/:id/versions | assessmentId/acknowledgeBreaking + 幂等键 | 只从未过期评估创建版本；破坏性变更必须明确确认 |
| POST /contracts/:id/check | 空对象 + 幂等键 | 检查实际元数据/可用行、行通过率与新鲜度SLO；PASSED/PARTIAL/FAILED并关联告警恢复 |
| GET/POST /assets/agent/tasks | 列表或自然语言问题 | 真实模型基于资产摘要和版本边找数据、解释口径/影响 |
| GET /assets/agent/tasks/:id | 无 | 受治理回答、资产引用、边界和用量 |
| POST /assets/agent/tasks/:id/cancel | 空对象 | 取消资产问答并保留记录 |
| GET /quality/overview | 无 | 规则健康、实际运行、开放/已恢复告警汇总 |
| GET/POST /quality/rules | 列表或名称/代码/资产/字段/类型/配置 | 创建规则V1，不自动运行 |
| GET /quality/rules/:id | 无 | 当前版本、历史版本、全部运行和告警 |
| POST /quality/rules/:id/versions | 类型/配置/说明 + 幂等键 | 创建新配置版本并退役旧版本，不删除历史 |
| POST /quality/rules/:id/run | 空对象 + 幂等键 | 在实际资产行检测；失败告警，通过可关联恢复 |
| GET/POST /quality/agent/plans | 列表或自然语言需求 | 真实模型基于字段/聚合摘要生成规则方案 |
| GET /quality/agent/plans/:id | 无 | 受治理提案、解释、模型与用量 |
| POST /quality/agent/plans/:id/apply | 空对象 | 人工应用为未运行规则V1 |
| POST /quality/agent/plans/:id/cancel | 空对象 | 取消生成并保留记录 |
| GET /security/overview | 无 | 合成身份、策略、申请、授权和不含业务行的审计汇总 |
| GET /security/personas | 无 | 四个本机虚构身份；authentication=LOCAL_SYNTHETIC_HEADER |
| GET/POST /security/policies | 列表或资产/角色/行范围/字段动作 | 创建策略V1，不自动查询 |
| GET /security/policies/:id | 无 | 当前及历史策略版本 |
| POST /security/policies/:id/versions | 角色/范围/字段动作/说明 | 创建新策略版本并退役旧版本 |
| POST /security/query/:assetId | 空对象；X-Actor-Id | 实际行级过滤、列脱敏或403拒绝，并写安全审计 |
| GET/POST /security/requests | 列表或资产/范围/理由；X-Actor-Id | 创建PENDING临时访问申请，不立即授权 |
| POST /security/requests/:id/review | 决定/时长/意见；DATA_OWNER身份头 | 审批并按需创建1—168小时授权 |
| GET /security/audits | 无 | 允许/拒绝/申请/审批审计，不含业务行 |
| GET/POST /security/agent/plans | 列表或自然语言需求 | 真实模型基于合成身份和字段摘要起草策略 |
| GET /security/agent/plans/:id | 无 | 受治理方案、解释、模型与用量 |
| POST /security/agent/plans/:id/apply | 空对象 | 人工应用为策略V1，不查询或审批 |
| POST /security/agent/plans/:id/cancel | 空对象 | 取消生成并保留记录 |
| GET /reports/overview | 无 | 数据集、就绪快照、报表和实际运行汇总 |
| GET/POST /reports/datasets | 列表或名称/代码/资产/字段 | 创建数据集草稿，不复制业务行 |
| GET /reports/datasets/:id | 无 | 数据集与全部不可变快照摘要 |
| POST /reports/datasets/:id/refresh | 空对象 + 幂等键 | 从实际资产物化独立快照并绑定证据摘要 |
| GET/POST /reports | 列表或名称/代码/数据集/组件/说明 | 创建固定当前快照的报表V1 |
| GET /reports/:id | 无 | 当前/历史版本与全部聚合运行 |
| POST /reports/:id/versions | 组件/说明 + 幂等键 | 创建固定当前数据集快照的新版本 |
| POST /reports/:id/run | 空对象 + 幂等键 | 实际执行KPI/BAR/PIE受限聚合并保存摘要 |
| GET /reports/:id/export | 无 | 导出最后成功运行的聚合CSV，不含明细行 |
| GET/POST /reports/agent/plans | 列表或自然语言需求 | 真实模型基于字段和快照摘要生成报表方案 |
| GET /reports/agent/plans/:id | 无 | 受治理方案、解释、模型与用量 |
| POST /reports/agent/plans/:id/apply | 空对象 | 人工应用为报表草稿，不运行或导出 |
| POST /reports/agent/plans/:id/cancel | 空对象 | 取消生成并保留记录 |
| GET /operations/overview | 无 | 跨模块健康、域计数、事故和最近活动；含外部模型上下文开关 |
| POST /operations/refresh | 空对象 | 扫描实际失败/恢复运行，按源运行幂等生成或更新事故 |
| GET /operations/incidents | 无 | 开放、已确认和已恢复事故 |
| GET /operations/incidents/:id | 无 | 不含业务行的源证据、恢复证据和人工事件 |
| POST /operations/incidents/:id/acknowledge | 操作人/说明 | 记录确认并转ACKNOWLEDGED，不冒充恢复 |
| POST /operations/incidents/:id/resolve | 成功证据类型/ID/说明 | 仅同资源且晚于失败的成功运行可解除 |
| GET/POST /operations/agent/diagnoses | 列表或诊断需求 | 默认外发门关闭；开启后只发送别名化聚合事故证据 |
| GET /operations/agent/diagnoses/:id | 无 | 诊断、建议、证据引用、置信度和不可执行边界 |
| POST /operations/agent/diagnoses/:id/cancel | 空对象 | 取消诊断并保留记录 |
| GET /evaluations/full-lifecycle/latest | 无 | 最新20条本机完整链路、阶段证据、批次和阻塞/取消/救援；固定非公网 |

任务状态：QUEUED、RUNNING、SUCCEEDED、VALIDATION_FAILED、FAILED、CANCELLED、INTERRUPTED。
当前 Agent 任务返回 completionScope=SQL_DEVELOPMENT、fullLifecycleE2E=false；
即使 SUCCEEDED 也只代表代码阶段通过。旧记录缺少范围字段同样不能被计为完整 E2E。
完整 E2E 要求理解需求至上线后监控的全部证据，定义及分阶段门槛见 PRD.md。
数据服务Agent返回completionScope=DATA_SERVICE_DESIGN、fullLifecycleE2E=false；成功只表示方案引用和约束校验通过。
同步Agent返回completionScope=OFFLINE_SYNC_DESIGN、fullLifecycleE2E=false；模型不读取CSV业务行，成功只表示基于当前元数据的草稿方案通过后端校验。
实时Agent返回completionScope=REALTIME_SYNC_DESIGN、fullLifecycleE2E=false；模型只读取源摘要和事件契约，成功或应用均不表示任务已启动、Kafka/Flink已连接或公网已部署。
资产Agent返回completionScope=ASSET_DISCOVERY、fullLifecycleE2E=false；引用必须命中当前目录，模型不读取业务行或修改资产，回答只代表受治理发现与解释。
质量Agent返回completionScope=QUALITY_RULE_DESIGN、fullLifecycleE2E=false；模型不读取业务行或无效样本，方案应用后运行数仍为0，不能代表数据质量已通过。
安全Agent返回completionScope=SECURITY_POLICY_DESIGN、fullLifecycleE2E=false；模型不读取业务行、不执行查询或审批。`X-Actor-Id`仅验证本机策略语义，不能被视为认证凭据。
报表Agent返回completionScope=REPORT_DESIGN、fullLifecycleE2E=false；模型不读取数据集行，应用后运行数为0，不能代表报表结果已验证、导出或公网发布。
运维Agent返回completionScope=OPS_DIAGNOSIS、executable=false、requiresHumanApproval=true；默认不允许把运维摘要发送外部模型。当前真实Qwen调用未获单独授权，因此M4g不能把测试替身记为真实Agent验收。
服务重启会把正在执行的任务标为 INTERRUPTED，保留记录，等待人工重跑；尚未触发的本机发布批次保留SCHEDULED并在服务恢复后重新装载，不能重复执行已经终态的批次。
重复键同输入返回原记录，不重复执行；同键不同输入返回 409。

## 真实执行边界

当前Spark 3.5.9只允许已登记的accounts/positions/cash合成数据视图、单条SELECT/WITH和函数白名单；历史3.5.7运行记录只用于复验既有证据，不再作为新云交付版本。
后端先按上下文裁剪客户范围，再执行 SQL，不依赖 Agent 自觉写权限条件。
执行串行、默认 90 秒超时、返回最多 1,000 行。本地进程不是生产沙箱。
只有真实执行成功且独立业务断言通过，运行才是 SUCCEEDED。
同一 SQL 在标准、现金变更、重复持仓、同额不同持仓、仅有现金客户五套输入上回归；任一失败，整体不得标为通过。
任务/运行绑定 validationContractId；报告包含对应 contractId，范围升级后旧报告需要重验。验证包标记 requiresRevalidation，不覆盖原始历史结果。
独立预期结果来自测试契约，不传给模型；新指标/新口径必须先补充对应契约和断言。

模型适配器使用 HTTPS、禁止重定向、60 秒请求超时、每次委托最多三轮。
总 Token 默认预算 32,000，输出默认上限 6,000；请求前保守估算并缩减输出，缺失/异常用量按剩余额度消耗，不继续调用。
这些是单任务防护，不是已验收的月度云账单硬封顶。
模型密钥入口拒绝换行注入和配置文件符号链接；只记录“已设置”审计事件，不保存密钥到平台元数据。
粘贴密钥会清理首尾空白，但绝不删除内部空白或允许追加环境配置行；保存错误在输入框旁持续显示。
2026-09-14：密钥按不透明凭证处理，移除旧的 243 字符短 Key 上限，允许安全的分隔/编码字符；8192 字符仅为传输与存储安全边界。
空输入、脱敏展示值、云账号 AccessKey ID、错误前缀、中间空白、非法字符及超限分别返回 MODEL_KEY_* 错误码。消息不包含用户输入。
首尾一对普通引号可自动处理；不从整段 JSON、curl 命令或页面文字中猜测/提取密钥，不根据前缀推断套餐或自动切换服务地址。
保存只证明本机持久化成功，不证明供应商鉴权、模型权限或 Base URL 已验证。既有凭证不会被格式错误的输入覆盖。
当前服务成功取得真实模型 SQL 响应后，status.model.connectionVerified 才置 true。更换密钥或重启服务会重置；测试替身不用于证明连接成功。此标记不代表 SQL 业务正确或完整 E2E 完成。

## 尚未开放

真实用户认证、跨用户授权、云端元数据库/OSS、自动恢复、多实例队列、云端审批及发布绑定在后续门槛内。
DAPI/XAPI本机发布与外部调用、V2 CLI/MCP已实现；官方交易日生产调度及公网数据服务尚未实现。
M1验证包不能被称为已部署任务。M2a新增交付包包含实际被解析的部署清单，但仍是本机文件演练，未进行云端部署或发布；详见 [交付规范](m2a-delivery.md)。
M2b/M2c已增加本机摘要审批、短周期墙上时钟发布、监控告警与回滚。其`published=true`仅表示本机测试版本生效，同时固定`publicDeployed=false`和`fullLifecycleE2E=false`；详见[本机发布报告](m2b-m2c-local-release.md)。
