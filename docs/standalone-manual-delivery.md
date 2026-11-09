# 独立手工 SQL 的交付文件与演练

更新：2026-11-10。已实现并完成本机协议、界面与文件执行验收；未部署公网。文件与演练阶段不包含独立手工发布；[后续审阅发布与监控](standalone-manual-publication.md)已接入，不计当前v3 Agent自主E2E。

## 1 背景

证券工程师可以先独立编写并核验SQL，然后准备调度与部署文件。经典开发能力应在模型未配置时可用，不能为了复用交付引擎虚构一个Agent任务。

## 2 价值

直接从本人保存的成功运行准备八文件，检查文件内容，交由隔离执行器演练。模型调用为零，手工来源明确，重启或回执丢失后仍能查回原任务、包与演练。

## 3 问题

旧持久交付以Agent任务为必需来源，独立手工版本无法进入；只下载配置又不足以证明文件能执行。把手工成果包装成Agent成功也会污染自主完成率和发布授权。

异步存储、持久化或计算期间，来源、会话权限与停止状态可能改变。错误回执不能作为重新生成文件或再次计算的理由。

## 4 需求与验收

### 产品流程

恢复独立手工版本及成功运行 → 查看四项核验 → “准备文件并演练（不调用模型）” → 预览／下载八文件 → 查看同版本主SQL、测试SQL及登记五场景结果。

工作台复用文件浏览器、分文件用途和只读预览。脏代码不沿用当前完成结论；来源未确认时停止新增准备／演练，已读文件作为历史保留。原任务仍可由拥有权限的作者停止，不因证据漂移而失去停止入口。

文件阶段成功文案现为“文件演练已通过”，后续发布状态在独立面板显示。四项审阅仍由工程师明确确认；发布协议和范围见[后续阶段](standalone-manual-publication.md)。离开页面停止页面推进，已提交计算保留原编号；这不等于永久云后台调度。

### 来源、持久性与授权

- 独立资源为 `manual_delivery_task`，模式 `DURABLE_MANUAL_DELIVERY_V1`。`source.kind=MANUAL_RUN`绑定原运行、代码与摘要；不填写假的 `sourceAgentTaskId` 或创建空Agent。
- 原保存的 `ENGINEER_EDIT`、本人作者、同项目／口径、SQL字节、Spark3.5.9成功及五场景独立结果必须一致。读取使用原成功证据摘要，准备和新计算边界重核。
- 归因固定 `MANUAL／ENGINEER_AUTHORED`，`agentIndependentE2E=false`。可选旧Agent关联只保留在真实开发参考中，不成为本手工任务的伪造父任务。
- 清单包含 `MANUAL_SUCCESS_REFERENCE`、SQL、断言、调度、部署、交易日历、虚构验证数据、源报告及使用说明。文件字节和清单摘要验证后才展示；原生Agent发布不得消费这一归因。
- 任务／包先持久化再保存产物；提交前先保存同一演练／执行编号。未知结果先读原包或原回执，显式恢复仍沿用稳定请求和原执行编号。不清除已发生计算或预留。
- 元数据库重启不把该持久任务和进行中的文件演练标成普通中断。合成协议验收与实际云恢复分别统计。
- 后端会话绑定作者，其他管理员也不能冒领；沿用项目权限、DELIVERY、CSRF、执行窗口和预算。旧“仅指定Agent任务”窗口不能新增独立手工任务。读取可在正常窗口到期后保留，新计算关闭。

### 统一接口

| 接口 | 作用 |
|---|---|
| `GET /api/v2/delivery/manual/source/:runId` | 本人成功来源、四项核验、现有手工包／演练；只读 |
| `POST /api/v2/delivery/manual` | 仅接受已读 `sourceBinding`，稳定 `Idempotency-Key`；准备文件，不调用模型 |
| `GET /api/v2/delivery/manual/:taskId` | 原编号读取，包括来源已变化的历史 |
| `POST /api/v2/delivery/manual/:taskId/advance` | `expectedVersion`推进同一文件演练，可能启动隔离Spark |
| `POST /api/v2/delivery/manual/:taskId/cancel` | `expectedVersion`停止原交付，保留文件和计算历史 |

GUI、CLI、MCP使用共同回执检查器，核对来源、归因、清单和八文件字节、演练关系、测试SQL摘要与五场景结果。HTTP200或一个passed字段不能代替完整回执。

CLI：`shuduo manual workflow|prepare|detail|advance|cancel`；指定 `--source-run-id`，准备另需 `--request-id UUID --confirm`，detail／推进／停止另需 `--id`，推进／停止另需 `--version N --confirm`。拒绝未知、重复和作者注入参数。

MCP：`manual_development_workflow`、`manual_delivery_prepare`、`manual_delivery_detail`、`manual_delivery_advance`、`manual_delivery_cancel`。改变状态需显式 `confirm=true`，读取和准备均不自动发布。

### 验收范围

覆盖无Agent／模型禁用、原作者、另一管理员、CSRF、窗口到期、限定原任务、重复准备、原编号恢复、文件损坏、错摘要／演练、五场景缺失、存储等待后撤权、持久化等待时取消，以及GUI／CLI／MCP一致性。既有Agent与人工辅助交付回归保留。

一次实际本机Spark3.5.9运行使用新包中的SQL／测试SQL执行登记五场景，并核对八文件、结果金额／证券数量及输入指纹；不作为云回执写入持久演练，也不计Agent自主完成。界面上游为合成来源／执行回执，模型禁用，丢失准备回执后同一包恢复，刷新不重算。

## 5 Demo

客户资产T+1：持仓去重，现金独立聚合，按证券代码计数。工程师不经模型生成交付包，在文件浏览器查看 `schedule.json` 的执行→断言→证据依赖和 `deployment.json` 的Spark要求；演练通过后仍等待独立确切版本审阅。真实云部署与完整发布链路按新证据验收。
