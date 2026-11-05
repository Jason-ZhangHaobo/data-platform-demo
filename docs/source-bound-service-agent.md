# 从同一发布结果规划数据服务

工程师完成证券数据开发与测试发布后，可在独立 Data Agent 的“发布结果 → 接口交付”视图，用自然语言规划当前结果的 DAPI／XAPI。模型只得到所选成功批次的元数据、原业务口径和同源已发布 DAPI 的固定版本；通过后端核验后，用户确认创建草稿，再沿已有流程测试、发布和授权。

首期实现普通本机开发模式中的原生 SQL Agent 来源。后端通过 `dataServices.sourceBoundAgentPlansEnabled` 明示能力，界面同时核对本机环境与原来源。私有云、受邀公网、人工接管及限定消费窗口保持既有能力边界；本实现不表示这些环境已开放模型规划。

## 私有／受邀来源上下文（只读适配）

私有数据服务启用时，`dataServices.sourceBoundAgentContextEnabled` 表示可核对上下文，**不表示可调用模型**。独立 Agent 的接口交付视图提供“核对规划上下文”，展示当前成功批次、已登记字段含义和同源已发布 DAPI 的固定版本。人工交付保留原工程师、原人工版本与非自主完成归因；沿用既有后台权限，其他管理员不能继承他人的人工来源。

`GET /api/v2/data-services/agent/context?agent_task_id=…&package_digest=…&release_id=…&source_release_run_id=…` 要求四项来源完整且唯一，必须受邀登录。后端复用私有来源验证、服务管理器及归属判断；口径来自已验证交付包清单，不采用任务后来改写的口径或默认口径。只返回一个确切批次，最多100个可访问、配置完整且结果快照未损坏的已发布 DAPI；显示截断与未通过候选数，不暴露业务行、SQL、查询模板、凭证或文件内容。

返回协议为 `shuduo-service-agent-context/v1`，范围 `PRIVATE_CLOUD_TEST`；`planning.enabled:false`、`agentIndependentE2E:false`、`publicDeployed:false`。这是读取时的元数据核对，不是执行票据。限定消费来源不能借此切换到其他包；旧消费窗口不会因此开放规划、草稿应用或模型付费。

切换批次立即清除旧上下文；链接只保留来源与批次标识。刷新保留所选批次，须重新只读核对，不能借用上一份回执。来源失效显示错误并保留选择，不使用其他结果；恢复后可核对同一批次。没有自动轮询或模型提交。

CLI 使用 `shuduo services plan-context --task-id UUID --package-digest SHA256 --release-id UUID --source-run-id UUID`；MCP 为只读工具 `service_agent_context`，参数仅 `sourceBinding`。GUI／CLI／MCP 使用同一只读 API 和回执验证，不接收执行者、确认写入或模型参数。私有传输及临时预览仅新增这一条严格 GET，不放开旧规划 POST。

当前只读适配已通过本机 HTTP／SQLite、CLI/MCP和实际浏览器合成验收；上游发布回执为合成数据，不计真实云或模型验收。云端规划下一步仍须实现来源与身份复核、单独执行窗口、持久模型尝试及未知结果保留、次数/Token/月预算和原任务恢复，再按具体范围部署验收。

## 工作流程

1. 从原 Agent 的确切交付包与发布进入接口交付页，选择一个已经完整核验的成功批次。开发运行不能用作发布批次。
2. 输入需求，或选择“先规划持仓 DAPI”“组合已有 DAPI”预填需求。预填不执行；确认生成才调用模型。
3. 查看方案的接口类型、名称、路径、超时、限流及原口径。股票持仓＋可用现金不会被说明为客户全资产。
4. 确认创建草稿。DAPI 必须指向原批次；XAPI 只能固定引用模型上下文中的同源 DAPI 版本。版本变化时明确拒绝，不切换到最新版本。
5. 在同一视图测试查询、发布当前测试版本，并按既有权限授权消费。模型规划与草稿应用不自动发布或发行凭证。

规划上下文最多包含100个同源已发布 DAPI；任务记录保存实际提供的版本编号、配置摘要与字段。模型看不到业务行、原 SQL、快照查询模板或调用令牌。用户输入的需求与原始数据一样应只使用本项目的虚构证券案例。

## API

沿用 `POST /api/v2/data-services/agent/plans`，提交需求与完整来源，并使用 UUID `Idempotency-Key`：

```json
{
  "message": "基于当前已发布的持仓与现金DAPI规划组合查询",
  "sourceBinding": {
    "taskId": "原Agent任务UUID",
    "packageDigest": "交付包SHA-256",
    "releaseId": "确切发布UUID",
    "sourceReleaseRunId": "实际成功发布批次UUID"
  }
}
```

以上为格式示意，调用时使用实际编号。四个来源字段全部必需，不接收调用者指定的执行者、SQL或其他覆盖字段。没有来源的旧规划模式保留原行为；不完整来源不能退回全项目规划。

| 操作 | 接口 | 行为 |
|---|---|---|
| 查同源记录 | `GET /data-services/agent/plans?agent_task_id=…&package_digest=…&release_id=…&source_release_run_id=…` | 仅该确切来源和当前创建者的记录 |
| 查原方案 | `GET /data-services/agent/plans/:id` | 原编号、固定版本和来源复核状态 |
| 找回未知提交 | `GET /data-services/agent/requests/:requestId` | 只找原创建者和原请求编号，不重发模型 |
| 应用草稿 | `POST /data-services/agent/plans/:id/apply`，空对象 | 事务幂等绑定原方案；不创建替代规划 |
| 取消规划 | `POST /data-services/agent/plans/:id/cancel` | 本人原任务可取消；新专用客户端发送 `sourceBoundOnly:true`，不能借此取消旧无绑定任务 |

生成前后及应用时重新核对完整发布证据与固定 DAPI 版本。应用已提交但方案状态更新未完成时，沿原方案幂等记录恢复同一草稿。草稿后来被编辑时，不把其当前版本冒充原应用结果。

## 中断与来源失效

浏览器在发请求前保留原 UUID。恢复链接只保存来源编号、摘要、成功批次、规划编号或请求编号，不保存需求、SQL和凭证；刷新回到独立 Agent 的接口视图。原输入仍在本页时，明确重试会先查询，再按原内容和原编号提交。刷新后没有原内容副本，只允许查询。

来源暂时失效时，创建者仍可读取自己的原方案元数据，返回 `sourceCheck:UNAVAILABLE`；它不是执行许可。界面只读展示原方案及口径，生成与应用关闭，正在运行的本人规划仍可取消。来源恢复后重新读取原来源与方案即可，无须再次调用模型。验证成功的读取返回 `sourceCheck:VERIFIED`，应用仍会再次核对当前固定版本。

切换批次会切换对应记录，不显示旧批次方案充当新方案。明确恢复链接中的批次不可用时保持错误与原编号，不改选其他批次。模型任务按现有本机队列保存状态；进程重启后的中断不自动重发。云端持久模型驱动及其权限、预算窗口须另行实现与验收。

## CLI／MCP

```sh
shuduo services plan --message "规划本次发布的持仓查询" \
  --request-id UUID --task-id TASK_UUID --package-digest SHA256 \
  --release-id RELEASE_UUID --source-run-id PUBLISHED_BATCH_UUID
shuduo services plan-request --request-id UUID
shuduo services plan-detail --id PLAN_UUID
shuduo services apply-plan --id PLAN_UUID
```

`services plans` 使用相同四个来源参数；`services cancel-plan --id PLAN_UUID` 取消原规划。`--source-run-id` 在这里指实际发布批次，与返程链接中表示开发运行的 `source_run` 不同。

MCP 对应 `service_agent_plan_create/list/detail/request/apply/cancel`，与 GUI／CLI 共用原 API。创建必须提供 `sourceBinding,message,requestId`；其余操作只接收原规划或请求编号，不允许执行者注入或覆盖方案。规划可能调用付费模型，仍须当前身份、模型配置与预算许可；来源可读不代表已获新的付费或发布批准。

本机测试使用合成模型及Spark回执，同时实际执行 HTTP、SQLite、CLI/MCP 与浏览器恢复流程；可证明来源约束和产品流程，不能算真实模型质量、云端部署或完整E2E完成率。
