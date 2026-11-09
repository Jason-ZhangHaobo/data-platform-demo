# 独立手工发布结果的 DAPI／XAPI 消费

更新：2026-11-10。代码、真实本机HTTP／SQLite及完整页面验收通过；上游发布批次为合成签名回执，未部署真实云端，不计当前v3 Agent自主E2E。

## 1 背景

独立手工SQL已经具备八文件、审阅、发布与监控。既有数据服务只认识关联Agent的发布，无法接入没有原Agent的真实手工交付；业务系统也无法沿该来源查回接口版本与历史调用。

## 2 价值

从确切发布的成功批次继续开发DAPI、组合XAPI、授权查询并核对调用。复用现有服务管理器、不可变快照、参数化SQLite、版本、分页、契约和日志；手工成果使用manualDeliveryTaskId，不冒充Agent身份。返回链接保留原包／发布／代码／运行。

## 3 问题

- 不能将手工交付ID写进agentTaskId、用旧任务权限读新来源或切换到其他包。
- 不能只凭HEALTHY或passed布尔值接入：需要原审阅、批准、演练、真实交付资源与两个匹配结果的批次。
- DAPI／XAPI必须固定原批次和子版本；另一个管理员或旧应用不能继承手工来源。
- 历史消费通过不意味着凭证现在有效；撤销后仍保留历史证据，当前请求必须拒绝。

## 4 需求与验收

### 来源与服务开发

选择独立手工发布 → 核对两个成功批次 → 创建／实际查询测试／发布两个DAPI → 固定子版本组合XAPI → 创建最小测试应用 → 授权查询及分页 → 撤销 → 返回原版本看历史调用证据。

校验清单来源、manual_delivery_task、成功隔离演练、四项审阅、批准和两个不同序号批次。MANUAL_RUN／ENGINEER_AUTHORED、作者、原代码摘要、包／演练／发布关系必须一致。两个批次的输出另与不可变样例独立预期逐项规范化对照，缺失、混用或金额被改即拒绝。

服务版本仍使用sourceReleaseRunId、sourceReleaseId、sourcePackageDigest和不可变快照。XAPI固定DAPI版本；创建者仅能调用自己有权使用的手工来源版本，不能通过ADMIN、旧应用或混合子版本获得权限。原Agent／人工接管来源兼容。

### 真实身份与限定窗口

新的来源查询为 `manual_delivery_task_id + package_digest + release_id`，三项必须齐全；与agent_task_id互斥，不回退全项目目录。GUI绑定同样使用manualDeliveryTaskId及原revision／run／hash，不产生task或origin_task伪关联。

既有消费窗口默认AGENT_TASK。只有显式 `V2_PUBLIC_SERVICE_SOURCE_KIND=MANUAL_DELIVERY` 才允许冻结计划以manualDeliveryTaskId替代taskId；计划锁定包、一个成功发布批次、两个DAPI、一个XAPI和唯一短期测试应用。指定管理员、最多两小时、字段／限流／超时、授权与撤销约束保持原门槛。

窗口给SESSION／SERVICES，不开放模型、开发计算、业务批次发布、其他模块或任意接口。代码合并不会自动配置真实窗口、创建应用或恢复已结束授权；实际云验收和预算仍需有效范围。

### API／CLI／MCP

- `GET /api/v2/data-services/sources?manual_delivery_task_id=…&package_digest=…&release_id=…`：只读已核验批次摘要，不返回业务行。
- `GET /api/v2/data-services/task-evidence?...`：同一选择，返回 `shuduo-private-manual-consumption/v1`；实际手工ID单列，保留人工作者归因，无taskId。
- 服务开发、测试、发布、授权、查询、撤销继续共用既有 `/data-services/dapis`、`xapis`、`applications`、`open/dapis`与`open/xapis`接口。
- CLI：`shuduo services sources|task-evidence --manual-delivery-task-id ID --package-digest SHA256 --release-id ID`。旧Agent参数保留，混用／不完整／重复选择拒绝。
- MCP：既有data_service_sources及data_service_task_evidence支持相同manualDeliveryTaskId选择；服务开发操作沿用统一API，执行人不由参数注入。

消费者来源增加 `shuduo-service-consumer-source/v2`，明确manualDeliveryTaskId、ENGINEER_AUTHORED及agentIndependentE2E=false。既有v1不被重新解释；外部报告一致性只能给MATCHED_ONLY，不能升级为自主或环境验收。读取历史对照不新增调用，不消耗调用限流，不返回令牌、参数或业务行。

### 界面与返回

独立工作台的发布监控下显示“把此版本交给业务系统”：已核对批次、接口版本、历史调用及应用撤销状态。“进入此版本的数据服务”带完整来源，继续复用服务目录和表单。

数据服务页显示真实手工交付编号及冻结消费计划；返回原人工版本时保留同一包／发布／代码／运行／摘要，清除Agent定位。未确认、错来源或环境不一致时只保留历史，关闭推进；加载不当失败。新增来源的服务Agent上下文／模型规划尚未接入，当前可手动操作或调用统一原子API，后续单独接入。

### 验收证据

完整本机CI1729项：1728通过、0失败、1既有跳过；类型、构建与入口体积门通过。覆盖来源链损坏及错误金额、其他管理员、CSRF、冻结窗口、跨批次／身份、真实DAPI和XAPI分页、现金接口越权拒绝、应用撤销、历史证据隐私、CLI／MCP和原Agent回归。

完整页面实际创建、测试、发布两类接口并生成一个本机临时测试应用；本机HTTP客户端执行DAPI查询、XAPI两页、未授权现金拒绝和撤销后拒绝。返回原手工版本后，DAPI／XAPI历史调用对照通过，应用显示已撤销。原代码和运行逐项不变，零Agent记录、模型及新增Spark提交，临时应用已撤销且进程停止。

首次界面流程的脚本收尾提前关闭服务，最后完整断言未结束，单独保留为未完成记录；串行补验通过后才清理。上游签名批次为合成，查询确实执行SQLite；不证明真实Spark／云冷启动、公网性能或完整自主E2E。

## 5 Demo

中国证券财富场景：股票持仓＋可用现金T+1（非客户全资产）。持仓DAPI返回客户、股票市值和证券数量，现金DAPI返回可用现金及组合口径金额，XAPI固定两个子版本。应用只授权直接持仓和组合查询；客户一的1000元股票市值＋300元现金组合为1300元，分页客户二为950元。现金接口直接访问拒绝，撤销后全部授权失效，历史调用仍可追溯。
