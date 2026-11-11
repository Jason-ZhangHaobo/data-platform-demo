# V2 API 契约与实现边界

## 只读业务期间的本人改密（2026-11-02，部署与真实账号验收待完成）

`POST /auth/password` 仅接受 `currentPassword,newPassword` 两个字段。只读和开发/发布/服务试点均允许该精确 POST 进入原身份校验；仍需有效本人会话、Origin、客户端标记、CSRF 和当前密码。目标账号、角色、项目等额外字段拒绝，不能给他人改密。成功前等待持久化，随后撤销旧会话并签发新会话；持久化失败不返回成功 Cookie。

响应复用登录的权限裁剪：只读仍为 `SESSION/readOnly=true`，有效试点仍为原限定范围，过期试点仍只读。此例外不开放邀请、任务、发布、接口凭证管理或云配置。平台设置复用本人改密面板，明确业务边界不变；未登录和本地开发身份不显示此操作。

这里只声明实现契约。真实密码变更、旧会话失效、云端重启后的保留及凭证配置一致性须独立验收；引导哈希更新不等于修改既有账号密码。维护顺序见 [凭证维护](credential-maintenance.md)。

## 人工接管版本的云交付准备（2026-10-30，云验收待完成）

人工接管版本继续使用同一项目、工程师和原 Agent 来源，不改写 Agent 任务的失败、尝试、Token 或自主完成结论。

- `GET /runs/:id/workflow`：仅源工程师可读取人工版本的核验报告、对应包及演练；验证记录的 `source=MANUAL`、`manualProvenance`、原任务、口径、SQL 摘要和批次关联。读取不提交新的计算。
- `POST /runs/:id/prepare-delivery`：空 JSON 对象与 `Idempotency-Key`。仅真实隔离 Spark 3.5.9、当前代码和同口径五场景核验通过的人工批次可进入。服务端决定来源，不接受客户端替换任务、代码或批次；`DEVELOPMENT_ONLY` 仍受指定原任务与工程师范围限制。
- 人工交付复用 `/agent/deliveries/:id/advance` 和取消、读取路径。包先持久化，再写私有不可变产物；未知结果沿用原摘要与批次对账。文件演练与普通开发共同消耗现有 Spark 额度。
- 清单保存 `source.attribution.kind=ENGINEER_ASSISTED`、原任务和操作者，报告与交付均标记 `agentIndependentE2E=false`。界面继续显示人工来源，未保存修改不能继承旧核验。
- 本准备接口不批准或发布任务，也不借用原失败 Agent 的批准。人工包的独立审阅发布契约见下节；准备交付成功不能代替该审阅。

以上为接口与本机实现范围；模型生成正确率、真实云文件演练、关页推进和实例恢复须分别实测，不由合成回归推断。

## 人工同源包的审阅发布契约（2026-11-05）

本节描述接口、客户端及权限边界，不声明实际环境已部署、发布窗口已开放或真实云调度已验收。人工接管复用原任务的发布路径，但必须指明人工来源；原 Agent 的失败、尝试、Token 预留及自主完成结论不变。

### 精确来源与接口

发布选择字段只有 `sourceKind`、`sourceRunId`、`packageDigest`、`verificationId`、`releaseId`，查询参数使用这些 camelCase 名称。`sourceKind` 只能为 `AGENT` 或 `MANUAL`；摘要为 64 位小写十六进制，其他选择编号为不超过 100 字符的字母、数字、下划线或连字符。客户端语法校验不替代服务端 UUID、项目、所有权及来源核验。重复查询键、未知字段和路径注入拒绝，不采用“最后一个参数覆盖前一个”的规则。

| 操作 | 请求及来源约束 | 行为边界 |
|---|---|---|
| `GET /agent/tasks/:originTaskId/publication` | 精确查询可携带上述五个选择字段；`MANUAL` 必须包含 `sourceRunId/packageDigest/verificationId`，已知发布编号时再绑定 `releaseId` | 只读取、对账该来源和包的已有发布、批次、告警；不新建批准或提交 Spark，不回退到其他历史包 |
| `POST /agent/tasks/:originTaskId/publication` | JSON 为 `packageDigest, verificationId, attestations`；人工版本另加 `sourceKind:"MANUAL", sourceRunId`，并携带 `Idempotency-Key` | 校验原任务、人工版本及真实成功批次、不可变包和成功文件演练的同源关系；四项人审通过后创建该包的审阅、批准和发布记录。返回 `WAITING_SCHEDULER` 不代表已执行 |
| `POST /agent/tasks/:originTaskId/publication/cancel` | JSON 携带同一精确选择字段及选定 `releaseId`；人工来源仍须完整的运行、包摘要、演练绑定 | 只停止选定发布的后续批次，保留已完成结果、原请求和审阅历史；不能取消其他人工包或同任务的其他发布 |

四项 `attestations` 必须分别为 `code/assertions/deliveryFiles/cloudScope=true`。生成文件、查看报告和工程师接管本身均不代表已审阅。代码版本、源运行、包摘要或演练记录变化后，旧确认不得复用；同一请求编号对应不同内容时拒绝。

人工链路沿用 `GET /runs/:sourceRunId/workflow` 取得核验报告及同源包、演练。服务端还要核验原任务、当前工程师、`MANUAL/ENGINEER_EDIT` 来源、口径、SQL 摘要、实际隔离执行和独立断言；不能仅凭客户端声明 `sourceKind:"MANUAL"` 取得权限。包清单保留 `source.attribution.kind=ENGINEER_ASSISTED`，发布回读携带 `sourceKind:"MANUAL"`、`sourceRunId` 及 `agentIndependentE2E:false`，界面继续明确人工归因。

`actorId`、`submittedBy` 或其他执行者覆盖字段不属于发布请求，客户端与服务端均拒绝；执行者仅由后端从已验证会话注入。该契约不沿用本机安全演示接口的 `X-Actor-Id` 身份模拟。

兼容旧 AGENT：省略 `sourceKind` 时仍按 AGENT 来源解释；旧的无选择字段读取与空对象停止请求只兼容唯一的 AGENT 发布。存在多个可匹配版本时返回 409，不能取第一条。新客户端优先绑定 `packageDigest/verificationId`，停止已选版本还绑定 `releaseId`；无来源选择不能落到人工发布。

### 权限、未知结果与客户端映射

`PUBLICATION_ONLY` 仍限指定账号、原任务、包摘要、演练及有效时间窗口，沿用 Cookie、CSRF、Origin、项目权限、预算和签名调度门。它允许读取对应人工 `workflow` 并审阅确切包，但不开放代码编辑、新模型调用、开发运行或交付文件重演练。GUI 将 `canPublish` 与开发 `canWrite` 分开：没有开发写权限的获准发布用户可审阅指定包，但开发权限不能代替人工发布权限。未保存草稿、错包、错演练、读取结果未确认或窗口到期都不能提交。

发布结果未知时先用相同选择字段读取原记录，不自动重发 POST、不生成新批准或新任务。确需明确重试时复用首次请求的 `Idempotency-Key` 和冻结请求内容；已有发布继续返回原记录，不重置两个测试批次的额度。页面切换包或演练后，旧异步响应和旧“读取成功”状态不能放行新选择；取消也必须使用当前已核对的 `releaseId`。

| 客户端 | 精确读取／停止 | 发布与稳定请求编号 |
|---|---|---|
| CLI | `shuduo agent publication --id TASK_ID`／`shuduo agent stop-publication --id TASK_ID`，增加 `--source-kind`、`--source-run-id`、`--package-digest`、`--verification-id`、`--release-id`；人工选择必须完整，带选择字段的停止命令必须有发布编号 | `shuduo agent publish --id TASK_ID --file REVIEW_JSON --source-kind MANUAL --source-run-id RUN_ID --request-id ORIGINAL_REQUEST_ID`；审阅文件保留包摘要、演练及四项确认，文件与命令参数冲突时拒绝，不覆盖已审阅范围 |
| MCP | `agent_publication_detail`／`agent_publication_stop` 使用 `taskId` 及同名 camelCase 选择字段；工具 schema 和实际调用均拒绝未知字段、缺失人工来源和 actor 覆盖 | `agent_publication_create` 使用 `taskId, sourceKind, sourceRunId, packageDigest, verificationId, attestations`，可选 `requestId`；`requestId` 映射为 `Idempotency-Key`，不放入执行者或选择字段 |

`requestId` 为 1—100 字符的字母、数字、下划线或连字符。需要跨终端恢复时，从首次发布起提供并保留它；旧客户端省略该项仍兼容，但不能把再次生成的编号当作原请求的重试。CLI/MCP 不代替用户勾选四项人审，也不自动重试失败的传输。真实云发布、定时执行及监控结果仍须按实际证据分别验收。

私有应用与临时预览仅在既有 Agent 允许列表开启时接入合法的精确发布 GET 和人工 workflow；`allowDurableAgentRead` 不允许上述 Agent／人工交付路由的 POST，也不新增写能力。临时预览仍过滤云账号 Cookie 并保留应用身份校验，不因这些路径变成公开写入口。

### 从人工版本进入数据服务

指定发布账号的登录及会话读取返回 `publicationSource`：以授权的 `taskId/packageDigest/verificationId` 唯一解析交付来源，成功时为 `status:RESOLVED`，携带 `sourceKind/revisionId/runId`；缺失、歧义或来源变化时为 `UNAVAILABLE`，不能回退原失败 Agent 的代码。匿名与其他账号不返回此字段。它只用于准确导航，不能代替四项审阅、有效窗口或执行权限；窗口到期仍可保留确切版本的只读入口。

人工结果的服务交接携带原任务、确切包、发布编号和人工来源。开发运行编号用于回到原代码；服务查询必须使用该发布中实际成功的 `release_run.id`，两者不得混用。指定来源不存在或不一致时不自动选取另一包、另一发布或全项目最新批次。读取、切换页面、刷新和导出不新增模型、Spark、接口调用或应用凭证。

| 读取接口 | 来源选择 | 结果边界 |
|---|---|---|
| `GET /data-services/sources` | 旧用法可不传参或只传 `agent_task_id`；指定 `package_digest` 或 `release_id` 时三项必须齐全 | 仅返回匹配且通过发布核验的批次；投影含发布来源类型、包摘要、源代码版本及开发运行编号，结果编号本身仍是发布批次编号 |
| `GET /data-services/task-evidence` | 必须有 `agent_task_id/package_digest`；可加 `release_id` 锁定发布，同时可用 `call_id_digest` 读取当前固定版本的原调用 | 固定服务版本及所有 XAPI 子版本必须来自相同发布和成功批次。原调用缺失时保留待核验状态 |

重复、未知或不完整选择字段拒绝。人工消费保留 `sourceKind:MANUAL`、`sourceAttribution:ENGINEER_ASSISTED`、`agentIndependentE2E:false`；消费对照只是既有调用与不可变快照的一致性，不等于外部系统独立验收或 Agent 自主完成。历史调用中的凭证已撤销时，显示历史证据和当前凭证状态，不自动重新授权。

本机原生 Agent 的 `task-evidence` 同样接受可选 `release_id`，保持 `LOCAL_TEST_ONLY` 和既有身份边界；人工/未知来源不能被转换为原生 Agent 成功。消费条目的 `sourceVersions` 仅投影最多5个固定 DAPI 的服务/版本编号、配置摘要、包摘要、发布/发布批次和允许字段名，不含业务行、SQL、参数或令牌。实际 `recheckCall` 返回配置摘要，`call.configHash` 必须与当前固定版本一致；摘要格式本身不构成独立真实性证明。

已核验条目另提供 `source`（`shuduo-service-consumer-source/v1`），从原不可变包投影 `scope/sourceKind/taskId/revisionId/revisionHash/developmentRunId/contextId/validationContractId/packageDigest/releaseId/sourceReleaseRunId`。必须同时关联当前项目、包、代码和实际发布运行，开发运行与发布批次不同；不是将消费者文件中的声明原样回显。缺失或矛盾来源不提供成功的外部绑定。该字段不含业务行、SQL、账号或凭证，也不改变原权限。外部 V2 报告绑定协议见 [数据服务说明](m3-data-services.md)。

新任务评测 v2 在同源监控通过后保留 `AWAITING_CONSUMPTION`，通过上述只读投影继续核验；旧 v1 只覆盖到监控，不能迁移或改名计作 v2。`--refresh` 更新原本机检查点，但远端仅 GET 原任务/包/发布的 `task-evidence`，不检查或启动模型、Spark及后续案例；`--report` 不改检查点。具体命令、版本和失败恢复见 [新任务评测说明](live-lifecycle-evaluation.md)。

### 本机原生 SQL Agent 的精确交接

本机开发环境同样提供 `GET /data-services/sources`，使用上表相同选择参数。只列出当前项目中可核验的原生 SQL Agent 来源：当前代码/运行、不可变包、文件演练、独立审阅和批准、本机健康发布、成功调度批次及监控必须关联一致。无匹配或证据不足返回空列表，不选其他任务、包或发布；非法、重复或不完整参数拒绝。旧不带绑定的经典服务目录仍沿用既有行为。

响应明确 `scope:LOCAL_TEST_ONLY`、`sourceKind:AGENT`、`publicDeployed:false`，只返回来源编号、包摘要、执行状态、行数等白名单；开发运行编号与发布批次编号分开。合法包复用可以没有反向交付指针，必须保留成功交付与演练的正向关系；回滚恢复须核验当前恢复窗口的两批及其事件，历史成功批次仍可供固定服务版本引用，不能借旧成功补当前缺失。

工作台链接使用 `source_scope=LOCAL_TEST_ONLY` 及原 `source_task/source_package/source_release/source_kind/source_revision/source_run`。私有云显式使用 `PRIVATE_CLOUD_TEST`，旧省略scope的私有云链接兼容；未知范围、跨环境或本机人工来源不自动转换。本机按钮还须由 `/status.dataServices.localSourcesEnabled` 与实际本机范围共同确认，不能仅因浏览器是本机地址而宣称能力已接通。

返程保留原生 Agent 与精确来源，重新读取任务、代码、开发运行及同源发布后只读展示；来源变化不展示最新代码冒充原版本。可明确打开不带来源锁定的当前任务页面继续处理，导航本身不执行模型、Spark或接口调用。本机 `GET /agent/tasks/:id/publication` 支持原生 `AGENT` 的精确包、源运行及发布编号；有选择时无匹配不回退，多匹配拒绝，旧无query读取兼容。旧本机任务缺少顶层runId时，只从已核对的最后尝试及代码关系投影原编号，不修改历史记录。

本机调度器在执行前重新检查实际到期时间；计时器提前唤醒或排队期间时钟回退时，批次保留 `SCHEDULED` 并等待剩余时间，未实际启动前不记录触发或调用执行器。取消及旧回调不能重启同一批次。触发时间使用当时实际时钟，不用计划时间补造证明，也不修改历史坏时序记录。

人工服务的实际调用按当前已发布根版本和 XAPI 固定子版本校验应用创建者与原工程师归属；旧的非所有者应用不能借接口版本更新继承人工数据。管理读取还核对所暴露的历史版本及调用，接口切回 Agent 不能解除人工历史保护。自己的应用元数据与撤销能力保留，不能因此读取人工服务内容。旧纯 Agent 的管理员策略兼容；无关候选版本不改变实际调用的固定来源。

CLI 对应 `services sources --agent-task-id ID --package-digest SHA256 --release-id ID` 和 `services task-evidence --task-id ID --package-digest SHA256 [--release-id ID [--call-id-digest SHA256]]`。MCP 的 `data_service_sources`、`data_service_task_evidence` 使用相同来源选择，证据工具的 `callIdDigest` 需同时提供 `releaseId`。两种入口只发 GET。临时预览的消费证据下载可带 `releaseId`，转发为同一 `release_id` 并核对返回报告的发布编号。

## 指定旧任务的开发续接（2026-10-29，默认关闭）

`DEVELOPMENT_ONLY`可选`V2_PUBLIC_DEVELOPMENT_TASK_ID`，严格UUID、既有持久Spark SQL任务、原指定管理员及最多两小时的新窗口。没有该项时保留一条新任务模式。原身份、项目、CSRF、版本和预算校验不变；不能用配置本身替代实际授权。

- 会话对获准账号返回`developmentTaskOnly:true`与`developmentTaskId`；匿名/其他账号不返回编号。窗口结束只读。
- `POST /agent/tasks`在指定模式拒绝新建/派生；只允许指定`:id`的`advance/cancel/prepare-delivery/background`及其`cancel/resume`。交付任务必须有同目标来源，不能只靠路由UUID或同一用户判断。
- `POST /agent/tasks/:id/background/resume`仅接收`expectedVersion,confirmModelRetry`。后台窗口及目标由服务端生成，客户端传`durationMs`或`developmentBoundary`拒绝。最多15分钟且不超过新窗口，不重置原次数与费用预留；未知模型结果必须显式确认。
- `POST /revisions`必须指定目标`originAgentTaskId`且口径一致，服务端保存人工来源。`POST /runs`仅接受目标当前/历史尝试关联版本或可信人工版本。人工运行不改写原Agent结论。
- 旧窗口绑定的后台事件返回`SCOPE_DENIED`，不触发计算、不改变其他任务/计数；状态可带`scopeBlocked:true`提示重新审阅。关闭开发范围后旧委托仍不能执行。原私有验收、无范围tick及内部转发不能绕过指定任务边界。
- `PUBLIC_DEVELOPMENT_TARGET_ONLY`表示不在指定任务范围；`PUBLIC_DEVELOPMENT_BACKGROUND_SCOPE_CHANGED`表示后台委托不属于当前窗口；`PUBLIC_DEVELOPMENT_CLOSED`表示当前窗口或身份不可执行。GET仍按原访问控制读取，不自动重新提交。

这些是协议与本机回归范围，实际部署、真实模型/Spark、恢复和完整E2E须另验。

操作层复用环境-only的`INVITED_DEVELOPMENT_RECOVERY_WINDOW_V1`，可选`resumeExistingTask`采用`TARGET_TASK_FRESH_WINDOW_V1`：绑定目标UUID、已结束的旧窗口、保留尝试、独立批准及代码阶段已用读取/探测数；摘要写入`binding.taskResumeDigest`，不能替换任务或清零计数。该分支为零新任务，保留尝试数允许1—3，后续模型上限严格为`3-retainedAttempts`，Spark上限可收窄为1—4。保留三次尝试时禁止新增模型，原模型预算原样保留，不要求模型价格或模型可用性请求；Spark额度按新鲜用量加本批上限设置，完整账单、历史预留、就绪及同一两小时时钟仍须核验。环境仍最多四次写入（含恢复），代码包不由此脚本上传或修改。旧新任务模式和其原额度保持不变。

前置只读代码更新使用独立的`TARGET_TASK_CODE_CONTINUATION_V1`描述，绑定同一批准、候选、前序、完整历史和保留费用。该阶段仍零计算、零业务开窗；不混用旧预算修复描述，也不接收环境开窗字段。环境阶段从总额扣除代码阶段实际用量；缺乏真实闭合记录与人审来源时，不得凭这些协议名执行。

## 指定版本受邀发布增量（2026-10-27）

以下为已实现的范围控制，不声明任何实际环境已开放。设置 `V2_FC_PUBLIC_WRITE_SCOPE=PUBLICATION_ONLY` 时，必须同时配置 `V2_LOCAL_DEVELOPMENT=false`、既有 `V2_BOOTSTRAP_ADMIN_EMAIL`、`V2_PUBLIC_PUBLICATION_TASK_ID`、`V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST`、`V2_PUBLIC_PUBLICATION_VERIFICATION_ID` 和 `V2_PUBLIC_PUBLICATION_STARTS_AT/EXPIRES_AT`（最多两小时）。实际执行仍要求原持久化、隔离Worker、预算和签名定时器条件通过；不因设置scope取得身份或跳过CSRF。

- 会话仅对指定管理员返回批准目标与 `SESSION/DELIVERY` 写能力；匿名及其他账号不返回任务、包或演练标识，保持只读。
- `GET /agent/tasks/:id/workflow`、人工 `GET /runs/:id/workflow` 与精确选择的 `GET /agent/tasks/:id/publication` 仍受原项目/记录访问控制。只读取已有结果，不能提交新Spark；人工及多版本查询规则见上节。
- `POST /agent/tasks/:id/publication`：请求为 `packageDigest, verificationId, attestations` 和 `Idempotency-Key`，四项确认是 `code/assertions/deliveryFiles/cloudScope=true`。AGENT 必须匹配指定任务、真实演练与成功SQL；MANUAL 必须额外绑定人工源运行和确切包，不能复用原失败任务的批准。创建审阅、批准和一个发布记录，**本请求不提交Spark**。
- `POST /agent/tasks/:id/publication/cancel`：以同一选择字段和选定 `releaseId` 停止允许目标；仅旧唯一 AGENT 保留空对象兼容。发布记录持久化 `verificationId`；取消/回滚后换幂等键不重置两批额度。
- 签名定时事件才可推进两个固定批次；准备及提交时再次检查任务、摘要、演练和期限。两个批次使用同一冻结业务日期，仅为有界样例验收，不是连续两交易日或永久生产调度。窗口结束不启动新计算，原迟到结果可继续对账。
- 发布scope关闭模型与开发计算、其他模块写、邀请及凭证管理。私有内部API转发也受限；旧私有任务验收及Agent推进操作拒绝。合法状态读取、签名发布定时事件保留，非发布模式原行为不变。
- GUI将 `canPublish` 与开发写权限分开，并核对当前任务/包/演练、显示期限和完整来源编号。仅看文件不会勾选审阅；修改来源或确认读取失败时不能提交。

验证：完整本机819项（818通过、1既有跳过），新增HTTP/持久SQLite与队列替身测试、虚构账号界面操作。实际部署、云Spark、定时器与外部消费证据不由这些测试替代，须读取受保护执行记录。

## 基础契约与历史实现范围

更新：2026-09-15。基础地址为本地开发服务的 `/api/v2`。以下接口已实现；`shuduo`与`shuduo-mcp`使用该契约，旧`dataplatform`命令仍是V1模拟，不能作为V2证据。交付包、演练、独立审阅、审批、发布、回滚和监控已补齐CLI/MCP映射；危险动作的MCP说明要求显式确认。

## 权限与请求

本地开发仍只绑定回环地址并绕过登录。公网模式支持匿名只读与受邀会话；写请求要求JSON、已允许Origin、`X-Shuduo-Client`、会话Cookie、CSRF和项目角色权限。客户端标记本身不是身份。
匿名写入返回401；缺CSRF、跨项目或越权返回403；未知记录返回404；无效参数返回400。公网模型Key写入始终拒绝。
SQL 上限 20,000 字符，请求体上限 100 KB。任务/运行请求必须携带 `Idempotency-Key`。

FC 公网入口启用时，`GET /contexts` 通过入口、来源和项目检查后直接读取内置样例，无需等待会话或云状态刷新。响应使用 `Cache-Control: no-store`。

| 方法与路径 | 输入 / 行为 | 输出 |
|---|---|---|
| GET /status | 配置状态，永不返回密钥 | 模块范围、Spark/模型/元数据/产物/预算状态；接入域返回可用源类型和SERVER_ENV_ONLY凭证模式，不返回连接信息 |
| GET /status?include=session | Agent 首屏显式请求同一次刷新后的会话和状态 | `{status, session}`；使用与单独读取相同的权限投影和 `no-store` 响应 |
| GET /budget | 无 | 当月模型估算、远程Spark次数/秒数、资源门和账号账单连接状态 |
| GET /cloud/readiness | 本地开发或ADMIN会话 | 只返回脱敏部署门、失败项、生成时间和账单摘要；公开匿名拒绝，绝不返回资源标识或审计原文 |
| GET /auth/session | Cookie可选 | 当前受邀用户、角色、权限和过期时间；匿名返回authenticated=false |
| POST /auth/login | 邮箱/密码 | 建立8小时会话，设置会话/CSRF Cookie；错误不区分用户是否存在 |
| POST /auth/redeem | 一次性邀请码/显示名称/密码 | 创建受邀项目成员、使邀请码失效并登录 |
| POST /auth/logout | Cookie + CSRF | 撤销服务端会话并清除两类Cookie |
| POST /auth/password | 当前密码、新密码 + Cookie/CSRF | 更新scrypt哈希、撤销全部旧会话并签发新会话 |
| GET/POST /auth/invitations | ADMIN会话；创建时邮箱/角色 | 列表不返回哈希；创建邀请码只显示一次、7天到期 |
| POST /settings/model-key | 仅本地开发模式；apiKey | 保存到权限 0600 的 .env.local，只返回 configured；不自动调用模型 |
| GET /contexts | 内置虚构证券输入，列表取决于执行模式 | 表结构、口径、参考 SQL；独立预期结果留在服务端 |
| POST /revisions | sql、contextId | 201；不可变版本、SHA-256 |
| GET /revisions | 当前项目版本列表 | 版本、代码、来源和时间 |
| GET /revisions/:id | 指定版本 | 版本详情 |
| POST /runs | revisionId + 幂等键 | 202；后台运行编号 |
| GET /runs | 当前项目历史 | 状态、版本、真实结果、引擎和验证 |
| GET /runs/:id | 查询状态 | 同上 |
| POST /runs/:id/cancel | 取消当前/排队运行 | 明确 CANCELLED；不会随后变为成功 |
| GET /runs/:id/bundle | 仅允许已通过验证的运行 | SQL、结果、断言、引擎和版本；NOT_PUBLISHED |
| POST /agent/tasks | message、contextId、language=SPARK_SQL/PYTHON、code + 幂等键；旧SQL调用仍兼容sql字段 | 202；真实模型代码任务编号；SQL进入Spark，Python进入受限CPython与五套断言；缺配置/执行环境返回503 |
| GET /agent/tasks | 历史委托 | 状态、尝试次数、用量和产物 |
| GET /agent/tasks/:id | 指定委托 | 同上 |
| GET /agent/tools | 无 | `shuduo-agent-tools/v2`十域工具目录及完整契约SHA-256摘要：风险、创建/详情/应用路径、依赖、批准、子取消模板、严格输入/输出JSON Schema及幂等要求；development使用CODE_DEVELOPMENT并显式绑定SPARK_SQL/PYTHON与当前代码；不含凭证或授权 |
| POST /agent/tools/:toolId/validate | `catalogVersion, contractDigest, input` | 在批准或创建任务前按当前目录做服务端契约预检；版本/摘要或输入不匹配失败关闭，固定`execution=NO_EXECUTION`，不创建任务 |
| POST /agent/intents/:intentId/tools/:destinationId/invoke | `catalogVersion, contractDigest, approvalId, input` | 以当前推荐步骤和有效批准调用专业模块原子API并幂等绑定任务图；仍受模块权限/预算约束，响应只含任务信封，不应用草稿、不发布或授权 |
| GET/POST /python/revisions | POST:`code, contextId` | 列出或保存受限Python不可变版本；不执行代码，固定本机边界 |
| GET/POST /python/runs | POST:`revisionId` | 列出或后台执行受限CPython版本，并运行五套独立证券断言 |
| GET /python/runs/:id | 无 | 读取运行、结果、回归和资源限制证据 |
| POST /python/runs/:id/cancel | 空对象 | 取消排队或运行中的Python子进程并保留终态 |
| GET /agent/intents | 受邀用户的跨模块Agent意图记录 | 路由、风险、摘要和模型用量；公网匿名拒绝读取 |
| POST /agent/intents | message + 幂等键 | 202；模型仅从白名单模块推荐下一步，固定NO_EXECUTION，不创建下游任务 |
| GET/POST /agent/intents/:id/approvals | 读取批准或destinationId + 幂等键 | REQUEST_APPROVAL持久化目标摘要哈希与风险；PLAN_ONLY拒绝。批准不执行工具，批准者内部标识不返回 |
| GET /agent/intents/:id/graph | 无 | 从意图、批准、工具调用租约、交接和专业任务只读投影统一步骤图、恢复状态、尝试号、证据与完成数；未绑定成功不计完成，不返回原始需求/业务行或升级Agent自主E2E/公网状态 |
| POST /agent/intents/:id/cancel | 空对象 | 停止未绑定子任务的父意图并撤销未消费批准；已有专业子任务时409，须分别控制子任务 |
| POST /agent/intents/:id/children/:destination/cancel | 空对象 | 从最新handoff或未绑定工具调用租约解析并取消QUEUED/RUNNING专业任务；父意图不取消，完成态409，重复取消幂等 |
| GET/POST /agent/intents/:id/handoffs | 只读交接或destinationId/专业任务/approvalId + 幂等键 | 已执行专业任务必须绑定同一步骤有效批准，绑定后批准转BOUND；无任务ID的草稿交接仍为NO_EXECUTION |
| GET /agent/tasks/:id/journey | 只读指定委托 | 七阶段现有版本/运行/交付/审批/计时批次/监控证据与责任归属；固定非Agent自主E2E、非公网，不返回业务行或原始报错 |
| POST /agent/tasks/:id/prepare-delivery | 空对象 + 幂等键 | 对真实模型+独立断言成功的SQL/Python任务返回后台交付准备编号；SQL生成Spark包，Python生成独立`shuduo-python-delivery/v1`并真实按文件受限CPython演练。两者都停在工程师审阅，后续审批与本机发布必须显式操作 |
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
| GET/POST /data-services/dapis | 列表或创建DAPI草稿 | 草稿绑定真实成功调度发布批次；支持带SQL/测试SQL证据的Spark或带codeExecuted证据的CPython，版本固化源引擎、字段投影、超时和限流 |
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
| GET/POST /data-services/agent/plans | 列表或自然语言需求；同源记录含完整sourceBinding及原UUID | 本机排队模型；持久私有模式只保存QUEUED任务，范围DATA_SERVICE_DESIGN，须单独显式推进 |
| GET /data-services/agent/context?agent_task_id=…&package_digest=…&release_id=…&source_release_run_id=… | 完整且唯一的任务/包/发布/成功批次；私有受邀身份 | 只读已验证包口径与同源已发布DAPI固定版本，最多100个；复用私有归属和快照验证。planning.enabled=false，不调用模型、不创建方案或接口；GUI/CLI plan-context/MCP service_agent_context同源 |
| GET /data-services/agent/plans/:id | 方案状态 | 受治理提案、原来源/人工版本、原窗口quota共享尝试及保守Token、恢复与安全诊断；不返回内部租约 |
| POST /data-services/agent/plans/:id/apply | 本机空对象；持久私有模式{proposalHash} | 人工确认指定摘要为原草稿，事务幂等恢复，不测试、发布或发凭证 |
| POST /data-services/agent/plans/:id/advance | 持久私有模式{expectedVersion,confirmModelRetry?} | 显式模式执行一次受控模型边界；事件模式202登记原任务outbox，不在前台运行模型。明确续接保存新检查点，保留次数/用量，旧事件不得花新确认；未知不自动重试。共享预算与身份/来源/版本门不放宽 |
| GET /data-services/agent/requests/:requestId | 本人原请求UUID | 找回原同源规划，不重新调用模型；来源不可用时仍只读返回原元数据 |
| POST /data-services/agent/plans/:id/cancel | 空对象或sourceBoundOnly:true | 同源规划限定创建者，可在来源失效或模型等待时停止；正常认证和最终状态均串行持久化，晚到结果不覆盖取消 |
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
| GET /runs/:id/comparison-candidates | 无查询参数 | 现有权限下的同口径运行候选，最多50条元数据，不含源码/行/日志 |
| GET /runs/:id/comparison?baseline_run_id=UUID | 单一确切基线编号 | 两记录分别校验归属；只读原代码摘要、值来源/条件及独立核验。输入/断言/引擎未齐不作受控状态对照；缺历史不推断新增/删除；不解析草稿或执行 |
| GET /assets/:id | 资产编号 | 字段、证据摘要、说明、血缘、指标与标准 |
| POST /assets/:id/annotation | 业务名称/说明/域/负责人/分类/标签 | 保存新的资产说明版本，不覆盖底层证据 |
| POST /assets/:id/annotation-requests | V2协议、请求UUID、expected版本/摘要、完整annotation | 事务核对已读基线并保存不可变应用／拒绝回执；必须检查outcome，不能只看201 |
| GET /assets/:id/annotation-requests/:requestId | 原UUID | 仅本账号原请求；原快照与当前投影分开，恢复不写入 |
| GET /assets/:id/lineage | 无 | 上下游版本绑定；columnLineages只读原批次保存且核对SQL/结构/输出的值来源，可含conditionReferences（WHERE/JOIN/GROUP/HAVING/DISTINCT引用）。子摘要再次核对SQL/结构，缺失不补造；COMPLETE不代表完整行集影响，GET不解析或执行 |
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
| GET /data-services/:id/contract-gates | 本机开发范围，可选单个version_id | 服务绑定、不可变配置版本和最近30次判定；指定版本时回显确切id/configHash且只含本版判定，其他服务/损坏/重复参数拒绝；只读不检查或发布 |
| POST /data-services/:id/contract-gates | contractId/contractVersionId/freshnessBasis + 幂等键 | 固定契约规则和时间依据；仅客户资产数据集，不自动发布 |
| POST /data-services/:id/contract-gates/:bindingId/versions | expectedBindingVersion/contractVersionId/freshnessBasis/changeReason + 幂等键 | CAS更新并保存原版本回执；契约变化须重新确认 |
| GET /data-services/:id/contract-gate-requests/:requestId | 原请求编号、本账号 | shuduo-service-contract-gate-write/v1：原应用版本与当前版本分开；读取不重写 |
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
| POST /reports/published | 名称、确切发布来源 + UUID幂等键 | 本机实际物化／聚合，保存可恢复请求；不运行模型或Spark |
| GET /reports/published/requests/:requestId | 原UUID请求编号 | 仅本账号只读恢复原请求；未知结果不新建 |
| POST /reports/published/:id/advance | 空对象 | 续接原报表任务，复用已完成步骤 |
| GET/POST /reports/datasets | 列表或名称/代码/资产/字段 | 创建数据集草稿，不复制业务行 |
| GET /reports/datasets/:id | 无 | 数据集与全部不可变快照摘要 |
| POST /reports/datasets/:id/refresh | 空对象 + 幂等键 | 从实际资产物化独立快照并绑定证据摘要 |
| GET/POST /reports | 列表或名称/代码/数据集/组件/说明；可指定同数据集datasetSnapshotId | 创建固定所选快照的报表V1，未指定时固定当前快照 |
| GET /reports/:id | 无 | 当前/历史版本与全部聚合运行 |
| POST /reports/:id/versions | 组件/说明 + 幂等键 | 创建固定当前数据集快照的新版本 |
| POST /reports/:id/run | 空对象 + 幂等键 | 实际执行KPI/BAR/PIE受限聚合并保存摘要 |
| GET /reports/:id/export | 无 | 导出最后成功运行的聚合CSV，不含明细行 |
| GET/POST /reports/agent/plans | 列表或自然语言需求 | 真实模型基于字段和快照摘要生成报表方案 |
| GET /reports/agent/plans?source_batch_id=UUID | 确切批次 | 本机本账号同源方案；默认列表仍只展示传统方案 |
| GET /reports/agent/requests/:requestId | 原请求键 | 只读恢复原同源规划，不再次调用模型 |
| GET /reports/agent/plans/:id | 无 | 受治理方案、解释、模型与用量 |
| POST /reports/agent/plans/:id/apply | 普通方案空对象；同源方案须proposalHash | 普通方案为草稿，同源方案实际生成已审阅指标；不导出或生产发布 |
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
| GET /evaluations/full-lifecycle/latest | 无 | v2报告/v3契约：重新核对冻结源摘要、七阶段关联、同版双批及监控时序；固定20例分母，保留失败/未执行/救援；旧契约或证据不一致409，缺报告404；历史回放不计Agent自主E2E |
| GET /agent/requests/:requestId | 原创建请求编号 | 按当前创建者找回原Agent任务；读取不重发需求，本机/受邀持久命名空间分别隔离，匿名403、缺失404 |
| POST /internal/scheduler/tick | HMAC签名的`{limit}` | 外部持久调度驱动领取到期ACTIVE_CLOUD批次；不接受用户会话替代服务签名，默认关闭 |

普通本机原生 Agent 的精确发布交接可使用 `sourceBinding:{taskId,packageDigest,releaseId,sourceReleaseRunId}` 规划服务，后端能力标志为 `sourceBoundAgentPlansEnabled`。候选批次、语义和固定 DAPI 版本仅来自原来源；生成、读取、应用和恢复都保留原身份与编号。来源暂不可用时只读元数据带 `sourceCheck:UNAVAILABLE`，不能据此创建或应用；模型取消不依赖来源仍健康。私有／受邀／限定消费模式不因这项本机能力开放模型。完整契约、版本变化与 CLI/MCP 入口见 [同源服务Agent](source-bound-service-agent.md)。

任务状态：QUEUED、RUNNING、SUCCEEDED、VALIDATION_FAILED、FAILED、CANCELLED、INTERRUPTED。
`POST /agent/tasks` 可通过严格 `derivation:{kind:REGISTERED_CONTEXT_CHANGE,taskId,revisionId,runId,revisionHash}` 从本人成功原生 SQL 版本创建不同已登记口径的新任务。目标仍用 `contextId`，`sql` 必须等于原冻结版本，与失败修正字段互斥。服务端核来源、归属、五场景断言及原窗口；新任务返回白名单 `derivedFrom`，不继承原成功、计费或批准。幂等摘要包含来源和目标；未知提交复用原请求查询。工作台/CLI/MCP 契约见 [口径变更说明](agent-context-derivation.md)。

当前代码 Agent 按语言返回 completionScope=SQL_DEVELOPMENT或PYTHON_DEVELOPMENT、fullLifecycleE2E=false；Python只到代码与独立断言，调度交付仍返回明确未实现边界；
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
服务重启会把普通正在执行的任务标为 INTERRUPTED，保留记录，等待人工重跑；尚未触发的本机发布批次保留SCHEDULED并在服务恢复后重新装载，不能重复执行已经终态的批次。启用`DURABLE_TICK`后，云发布RUNNING批次保留租约；外部tick只在租约过期后恢复，领取状态必须先持久化，再执行Spark。
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

真实云连接、跨用户公网并发、多实例队列、云端审批及发布绑定仍在后续门槛内。MySQL/OSS持久化与持久调度代码已完成本机故障模型验收，但都不能替代真实云运行。
DAPI/XAPI本机发布与外部调用、V2 CLI/MCP已实现；官方交易日生产调度及公网数据服务尚未实现。
M1验证包不能被称为已部署任务。M2a新增交付包包含实际被解析的部署清单，但仍是本机文件演练，未进行云端部署或发布；详见 [交付规范](m2a-delivery.md)。
M2b/M2c已增加本机摘要审批、短周期墙上时钟发布、监控告警与回滚。其`published=true`仅表示本机测试版本生效，同时固定`publicDeployed=false`和`fullLifecycleE2E=false`；详见[本机发布报告](m2b-m2c-local-release.md)。
## 持久 SQL Agent 增量接口

私有后台驱动另见[有界私有后台驱动](durable-agent-recovery.md#第二次增量有界私有后台驱动)：已有 IAM 私有事件入口可显式启用 `PRIVATE_AGENT_TICK_V1`，载荷仅 `operation` 与 UUID `requestId`。无新增公网接口；默认关闭，不替代未知模型结果的人工重试确认。

默认关闭的 `V2_DURABLE_SQL_AGENT_ENABLED` 将 SQL Agent 创建改为检查点任务，新增 `POST /api/v2/agent/tasks/:id/advance`。请求必须携带 `expectedVersion`，可选 `confirmModelRetry`；GET 只读，未知模型结果不会自动重试。沿用身份/CSRF/开发权限，任务限制提交人或管理员操作。阶段、边界及本机测试见 [Agent 恢复合同](durable-agent-recovery.md)。本增量尚非云端或完整 Agent E2E 验收。

`MODEL_NOT_SENT` 表示可信诊断已确认本次请求在发送前停止，任务状态为 `INTERRUPTED`。GET、后台事件、调度tick和评测器均不得自动重试；处理配置或预算条件后，用户明确调用原任务 `advance` 或 `background/resume` 可继续，无需未知计费的 `confirmModelRetry:true`。版本、所有权、次数和预算检查继续生效，原attempt和保守预算预留保留。普通错误的同名code不能自证请求未发送；未知结果、租约过期及历史 `MODEL_OUTCOME_UNKNOWN` 仍沿原确认规则。

## 独立核验差异

已授权的运行读取及Agent核验报告增加`validationDetails`，schema为`shuduo-validation-details/v1`。`source`绑定runId、revisionId、revisionHash、contextId、contractId；只有与原版本及项目相符时才展示值。根状态为`AVAILABLE`、`LEGACY_UNAVAILABLE`或`UNVERIFIED`，每个场景另有`detailsStatus`、`mismatches`、`totalMismatches`、`truncated`。单场景≤20项、五场景≤100项；金额/数量的具体比较值为有限十进制字符串，不转浮点数。

差异kind为`VALUE_MISMATCH`、`INVALID_VALUE`、`MISSING_CLIENT`、`DUPLICATE_CLIENT`、`CLIENT_COUNT`、`OUT_OF_SCOPE_CLIENTS`、`OUTPUT_FIELDS`。非法实际值不回显原文；范围外客户只给数量。旧回执没有明细时不根据当前rows重建；字段不合法或来源不符时不显示数值。原始Worker comparison经现有签名回执落库，但不从普通validation出口直接透出，也不追加到模型错误摘要。GET不产生新的计算，现有权限不变。
