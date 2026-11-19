# Agent 新交付的登记交易日历

## 工程师流程

本机原生证券 SQL Agent 的开发与独立结果核验通过后，在“调度与部署交付”展开“为新交付选择交易日历”。读取版本，核对冻结业务日、下一交易日、覆盖范围、公告来源与摘要，明确选用后点击“按所选日历准备或回读交付”。

选择影响下一次交付：原代码/运行、原包、演练和批准保持。相同来源及相同日历回读已有交付；不同日历创建独立交付包和对应演练。新包仍为八文件，`calendar.json` 使用已登记 `shuduo-calendar/v2` 并绑定来源引用及摘要。实际演练按包内日历，以冻结业务日的下一交易日运行；选择日历不会补造或更换业务数据。

未选择时继续原样例日历。取消草稿仅清除本页选择，不把已有官方日历包换回样例。失败后重新准备会沿用当前交付的日历；生成和演练不代表审阅或批准发布。

## 版本与恢复

- 准备请求绑定 `expectedSource` 的代码版本/SQL 摘要/运行及已有需求绑定，以及 `calendarSelection` 的版本 ID/摘要。来源变化、日历失配或覆盖不足会拒绝。
- 日历进入交付任务、等价查找和幂等签名。同一请求 UUID 更换日历会冲突；新选择使用新编号。已有包的日历必须匹配，不能用其他日历或旧批准替代。
- 同一来源仍有其他日历交付待执行时拒绝并行准备，先查看或停止原任务。重复原请求不会追加演练。
- 响应无法解析时保留原编号和仅含版本标识的恢复链接，先查原请求；找不到回执时不展示其他包作为结果。可明确按原编号、同一来源和日历重试。
- 原请求待确认时，先前交付只作历史回看，发布与新准备受限。退出本页恢复不取消后台交付。刷新后仍按原交付编号回读；换代码或批次不能误读旧包。

本轮只开放无云入口的本机原生 SQL（本机进程执行）。持久远程分支、Python、基金专用开放日和云发布的日历选择未适配，明确拒绝；不放宽原云端 `expectedSource` DTO、正文摘要或窗口批准。

## 多端契约

`GET /api/v2/agent/tasks/:id/workflow` 对具备条件的本人来源返回 `calendarPreparation`：`scope:LOCAL_NATIVE_SQL`、`source` 和冻结 `businessDate`。

```text
POST /api/v2/agent/tasks/:id/prepare-delivery
Idempotency-Key: <UUID>
```

```json
{
  "expectedSource": {"revisionId":"<UUID>","revisionHash":"<SHA256>","runId":"<UUID>"},
  "calendarSelection": {"calendarId":"sse-equities-2025-2026-v1","calendarDigest":"<SHA256>"}
}
```

`source` 必须从当前工作流原样保留；存在 `requirementBinding` 时不能省略或手造。旧空正文和云端来源正文保持原语义。新日历请求必须有稳定 UUID，未知字段或不完整选择拒绝，不会静默回到样例。

```sh
node bin/shuduo.mjs agent prepare-calendar --id <TASK_UUID> --source-file <SOURCE_JSON> --calendar-id <ID> --calendar-digest <SHA256> --request-id <UUID> --confirm
node bin/shuduo.mjs agent workflow --id <TASK_UUID> --delivery-id <DELIVERY_UUID>
node bin/shuduo.mjs agent workflow --id <TASK_UUID> --preparation-request-id <UUID>
```

MCP 为 `agent_delivery_calendar_prepare`；读取使用 `agent_development_workflow` 的 `deliveryTaskId` 或 `preparationRequestId`，两者互斥。不能混用人工来源参数。旧准备命令收到日历参数会明确拒绝并指向新操作，不忽略选择。

指定回读对应 `GET /agent/tasks/:id/workflow?deliveryId=<UUID>` 或 `?requestId=<UUID>`，仅本机原任务/版本/批次。原请求没有记录时返回 `preparationRequest.status:NOT_FOUND`，不带无关交付包、文件演练或发布能力。只读取不会执行模型、文件演练或创建批准。

## 实际验证与边界

本机协议回归覆盖日历冻结、样例旧包与原批准保持、换日历新版本、原请求冲突/回读、并行拒绝、来源与日历损坏、覆盖不足及多端/旧命令。计算替身回执不计真实运行。

另以既有已核验虚构证券 SQL/数据为来源，实际生成新包并运行一次本机 Apache Spark 3.5.9：主 SQL、测试 SQL及五组登记回归通过；浏览器关闭后执行，重开按原请求恢复，无重复计算。模型调用、云写与新增批准为零。最后界面复验复用该成功交付，仅检查待确认时旧包的历史标记及回读，新增 Spark/制品为零。它不是实时模型开发、云端恢复、正式发布或完整 E2E 验收。

日历事实与限制沿用[证券交易日历](securities-trading-calendar.md)：公告推导版本不是实时交易所服务，不包含临时调整、停牌、基金开放日或清算安排。正式云端、发布、Safari与不同网络仍按各自范围验收。
