# V2 API 契约与实现边界

更新：2026-09-14。基础地址为本地开发服务的 `/api/v2`。以下接口已实现；旧 CLI/MCP 仍使用旧版 API，不能用其测试证明 V2 多端一致。

## 权限与请求

当前仅支持回环地址上的单项目开发会话，不是受邀用户登录系统。
写请求要求 JSON 对象和 `X-Shuzhan-Client: workbench`；这一标记只用于本地请求来源防护，不能作为公网身份。
公开只读模式拒绝全部写入。跨项目请求返回 403；未知记录返回 404；无效参数返回 400。
SQL 上限 20,000 字符，请求体上限 100 KB。任务/运行请求必须携带 `Idempotency-Key`。

| 方法与路径 | 输入 / 行为 | 输出 |
|---|---|---|
| GET /status | 配置状态，永不返回密钥 | 模块范围、Spark/模型/元数据状态 |
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
| POST /agent/tasks/:id/cancel | 取消委托及其执行 | CANCELLED |
| GET /delivery/packages | 当前项目交付包摘要列表 | 不返回大段文件正文 |
| POST /delivery/packages | sourceRunId、name + 幂等键 | 当前验证通过版本的不可变文件包；NOT_PUBLISHED |
| GET /delivery/packages/:id | 交付包详情 | manifest、files、digest，可导出JSON |
| POST /delivery/packages/:id/verify | scheduledFor + 幂等键 | 202；本机按文件演练编号，不发布 |
| GET /delivery/verifications | 当前项目演练历史 | 文件摘要、状态与实际运行证据 |
| GET /delivery/verifications/:id | 指定演练 | 同上 |
| POST /delivery/verifications/:id/cancel | 取消排队/运行中的演练 | CANCELLED |
| GET /release/approvals | 本机审批记录 | 包摘要、源SQL哈希、演练与审阅证据 |
| POST /delivery/packages/:id/approve | packageDigest、reviewNote + 幂等键 | 只审批摘要匹配且成功演练的不可变包 |
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

任务状态：QUEUED、RUNNING、SUCCEEDED、VALIDATION_FAILED、FAILED、CANCELLED、INTERRUPTED。
当前 Agent 任务返回 completionScope=SQL_DEVELOPMENT、fullLifecycleE2E=false；
即使 SUCCEEDED 也只代表代码阶段通过。旧记录缺少范围字段同样不能被计为完整 E2E。
完整 E2E 要求理解需求至上线后监控的全部证据，定义及分阶段门槛见 PRD.md。
数据服务Agent返回completionScope=DATA_SERVICE_DESIGN、fullLifecycleE2E=false；成功只表示方案引用和约束校验通过。
同步Agent返回completionScope=OFFLINE_SYNC_DESIGN、fullLifecycleE2E=false；模型不读取CSV业务行，成功只表示基于当前元数据的草稿方案通过后端校验。
服务重启会把正在执行的任务标为 INTERRUPTED，保留记录，等待人工重跑；尚未触发的本机发布批次保留SCHEDULED并在服务恢复后重新装载，不能重复执行已经终态的批次。
重复键同输入返回原记录，不重复执行；同键不同输入返回 409。

## 真实执行边界

Spark 3.5.7 只允许已登记的 accounts/positions/cash 合成数据视图、单条 SELECT/WITH 和函数白名单。
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
