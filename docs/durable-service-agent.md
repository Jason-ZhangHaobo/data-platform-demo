# 私有数据服务 Agent：持久规划与草稿确认

本增量把同源 DAPI／XAPI 规划从临时进程队列推进为可恢复的持久记录。独立Agent已复用该协议；默认关闭的[受控事件适配](service-agent-events.md)已完成本机合成验收。真实云部署、模型与新进程恢复仍是独立门槛，不能把合成事件称为已安装的长期云后台。

## 用户操作与恢复

1. 先核对原任务、交付包、发布和成功批次。模型只使用该来源的字段含义和可访问的已发布 DAPI 固定版本。
2. 提交需求与原 UUID，立即得到 `QUEUED / READY_FOR_MODEL` 任务。私有模式的创建不调用模型；回执未知时查询原请求，不换 UUID。
3. 读取最新版本后，显式推进一次模型边界。发送前持久化尝试、租约和保守 Token 预留，之后重新核对来源、身份、窗口和预算。
4. 审阅通过核验的方案摘要，确认创建 DAPI 或 XAPI 草稿。草稿应用不测试、不发布、不发凭证，后续服务生命周期另行按授权进行。

模型结果未知时，记录 `INTERRUPTED / MODEL_OUTCOME_UNKNOWN`，原次数和预留保留。GET、刷新、重复提交和换控制器都不自动再调用。需读取原任务并明确 `confirmModelRetry:true`，且原窗口还有额度，才能再次推进。租约不晚于执行窗口结束；过期响应不恢复执行资格。已过期租约首次推进只标记未知，不顺带重试。

明确发送前失败记录 `MODEL_NOT_SENT`；历史尝试与保守预留仍保留，不把它误称为实际已收费。取消可停止本人原任务的后续推进，不依赖来源健康；取消时已在途的模型可能已收费，其未知预留保留，晚到结果不能覆盖取消或新尝试。来源暂不可用时，本人仍能读取原元数据，`sourceCheck:UNAVAILABLE` 不能用于写入。

生成前后及草稿应用都复核来源与固定版本。XAPI 只能绑定当次上下文中的 DAPI 版本，不跟随最新版本；已应用草稿的回执丢失，可按原方案恢复同一草稿。草稿后来改动时拒绝冒充原结果。原 SQL Agent 的失败记录、人工归因及发布批准不被改写。

## 默认关闭的私有执行范围

### 独立Agent界面与私有传输

界面按“保存任务 → 模型规划 → 确认草稿”展开，左侧保留需求及本人历史，右侧展示原任务阶段、窗口共享尝试与保守Token、原口径、固定版本及方案。规划范围下来源详情可展开，原任务及包版本仍可核对；窄屏采用单栏。经典目录可查看，测试、发布、版本修改和凭证保持关闭。

回执未知时原UUID或任务编号保留在恢复链接中，需求不丢失；先“读取原任务”核对结果，再决定下一动作。链接不保存需求正文、SQL或凭证。未知模型结果必须主动勾选可能已收费的提示；普通刷新不重试。审阅确认绑定完整方案摘要，应用丢失回执时仍恢复同一草稿。切换来源或账号清除旧任务界面，历史窗口不能授权当前操作。

临时预览需明确同时开启 `--data-services --service-agent`；旧数据服务开关不开放规划POST。`/auth/session` 只给指定本人返回 `servicePlanningOnly` 与 `servicePlanning` 的安全窗口信息。其他用户不获来源、模型或额度；公开HTTP始终只读。服务端权限及预算仍逐步重检，浏览器标志不能授予执行权。

长模型期间可“读取原任务”，也可刷新后恢复同一在途任务。后端先在串行通道内完成预留持久化和同步校验，再启动模型请求；只对纯等待让出通道，模型成功或异常都必须重获通道，随后检查当前租约、来源、身份及版本再写结果。其他读取、刷新、取消及最终持久化保持串行。取消直接沿正常认证路径保存，晚到结果不覆盖取消，保守预留保留，不再使用提前停止信号旁路。

私有配置启用时，EVENT应用请求的外层只是严格信封转发，不刷新或写入元数据；可信INTERNAL API持有通道，避免外层占着通道等内层。独立预览可并发投递，后端仍控制元数据串行与权限；即使多个任务可读，也只允许一个私有模型在途。GET和刷新不启动模型，普通请求仍可能等待短持久化。可选事件模式见[独立协议](service-agent-events.md)，不把本机观测或配置启用当作公网性能、真实云事件验收。

`V2_PRIVATE_SERVICE_AGENT_PROFILE` 是经过部署审阅的配置，不是客户端参数。未配置时不开放创建、推进或应用；本人已保存任务仍可读取或取消，其他范围门继续生效。必须为私有数据服务模式，并实际安装只读的FC入口；仅设置只读环境标志、缺少入口或使用可写入口都会拒绝启动此范围。不能与既有开发／发布／限定消费写窗口混用。实际部署与付费验收仍须具体有效范围，本文件不是激活批准。

| 配置 | 约束 |
|---|---|
| `id`、`actorId`、`sourceBinding` | 窗口UUID、一个有效项目成员、完整四来源；不能由请求覆盖执行者 |
| `startsAt`、`expiresAt` | 明确UTC时间，有效窗口最多2小时 |
| `maxPlans`、`maxModelCalls` | 各1—3；同一窗口多任务共享调用计数，不按新任务清零 |
| `requestTokenLimit`、`tokenBudget` | 单次1024—24000，窗口总额不低于单次且不超过24000；未知用量保守计入 |
| `maxModelCostCny` | 最多5元的附加上限；按保守Token估算预留，仍受全月上限约束 |
| `bill.month`、`observedAt`、`spendCny`、`unsettledReserveCny` | 当前月完整账单快照，最多30分钟旧；必须保留未结算预留，并核对全月不超过200元 |

实际计费前仍需核验可用模型和价格。配置指纹绑定账号、来源、额度、期限、月份、未结算预留，以及部署时的模型名和HTTPS端点摘要；换模型、端点或降低预留不能在同一窗口静默重置。可信账单刷新可更新观测时间与支出，不延长窗口或清空次数、Token。账单和模型估算保守叠加可能提前阻止执行，不能以陈旧快照证明全站费用。

独立租约预算验证只读取 `service_agent_plan` 记录，不能借用 SQL Agent 的租约抵扣；原 SQL 预算门保持原协议。模型适配器在 HTTP 发送前限制上下文与输出，不发送业务行、SQL、参考答案、文件、凭证或内部租约。请求／响应／解析失败可能已发送，安全诊断不保存供应商响应正文、URL、密钥或原异常。

## API、CLI 与 MCP

所有路径前缀为 `/api/v2`，私有执行仍需要会话、项目权限、CSRF 和可信私有传输；来源可读不代表允许付费。

| 操作 | 接口与请求 | 行为 |
|---|---|---|
| 创建 | `POST /data-services/agent/plans`，`{message,sourceBinding}`，UUID `Idempotency-Key` | 只保存待推进任务，同一原请求恢复同一记录 |
| 查列表 | `GET /data-services/agent/plans`，完整四来源查询 | 仅本人同源持久任务 |
| 原请求恢复 | `GET /data-services/agent/requests/:requestId` | 只读取，不调用模型 |
| 查任务 | `GET /data-services/agent/plans/:id` | 状态、尝试、用量、窗口、口径、固定版本与恢复提示；不返回租约令牌 |
| 推进 | `POST /data-services/agent/plans/:id/advance`，`{expectedVersion,confirmModelRetry?}` | 一次受控模型边界；陈旧版本、未知结果未确认或额度不足时拒绝 |
| 应用 | `POST /data-services/agent/plans/:id/apply`，`{proposalHash}` | 只确认该方案摘要对应的原草稿，事务幂等恢复 |
| 取消 | `POST /data-services/agent/plans/:id/cancel`，空对象或 `sourceBoundOnly:true` | 本人原任务通过串行认证及持久化停止，不删除历史；无需等待模型响应 |

CLI 复用 `services plan/plans/plan-detail/plan-request/apply-plan/cancel-plan`；新增：

```sh
shuduo services advance-plan --id PLAN_UUID --expected-version N
# 只有明确确认未知结果可能已收费时才传入：
shuduo services advance-plan --id PLAN_UUID --expected-version N --confirm-model-retry true
```

MCP 对应 `service_agent_plan_advance({planId,expectedVersion,confirmModelRetry?})`，其他操作沿用原工具。客户端先核对原记录和版本，只发送一次推进；应用私有方案时提交当前完整摘要。本机旧规划的自动队列和空对象应用保持兼容，不借新协议扩大其能力。

私有传输需单独启用服务规划路径；旧 `allowDataServices` 不开放模型 POST。公开 HTTPS 保持只读。显式模式返回 `recovery.driver:EXPLICIT_ADVANCE`，事件模式返回 `OSS_EVENTS` 及安全事件进度；均保留 `backgroundDispatcherVerified:false`、`agentIndependentE2E:false`、`publicDeployed:false`，不宣称真实云后台或完整Agent E2E已通过。

本机验收使用真实 HTTP／SQLite／认证／CSRF／预算／服务管理器，上游模型、Spark与发布回执均为合成数据。实际浏览器已验证保存、推进及应用的丢失回执恢复，未知结果明确重试，慢模型取消及晚到拒绝，来源失效恢复、批次隔离、过期和跨账号拒绝，以及1280／900响应式布局。真实模型、云实例重启与事件后台仍分别验收，不能由本协议测试或合成界面结果替代。
