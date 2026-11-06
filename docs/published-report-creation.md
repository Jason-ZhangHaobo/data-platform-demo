# 从确切发布结果创建报表

独立Agent交付页现在支持显式选择已核验批次、填写名称，完成真实快照和聚合，再回显到同一会话。此流程复用发布结果，不运行新SQL、模型或Spark；新报表不是预设结果。当前仅开放本机开发边界，云端请求拒绝，不能据此宣称公网完成。

## 来源与运行

服务端按项目和实际身份核对代码版本、运行、八文件包、审阅／批准、成功调度批次、测试SQL和结果断言。Agent来源须对应原任务，手工来源须属于当前工程师，不能互相改名。数据集保存固定来源；后续刷新仍读原批次，无法核验时停止，不回退为全局最新资产。

| 步骤 | 保存内容及恢复方式 |
|---|---|
| 确认来源 | 原请求、正文摘要、提交身份与发布内容摘要 |
| 数据集 | 从原来源实际字段创建，使用原步骤幂等记录 |
| 快照 | 平台元数据与业务快照分离；固定物化编号允许跨库中断后复用，不覆盖不同内容 |
| 报表 | 固定已保存快照和V1；服务器与GUI共用证券模板，不补造维度 |
| 实际聚合 | 保存版本、快照、运行和结果摘要；恢复不重复已完成的聚合 |

股票持仓＋现金的限定口径使用对应指标名称，不称作客户全资产。缺类别／行业字段不生成分布。新流程仍受原数据契约限制，不支持任意结果结构或生产BI引擎。

## 统一API、CLI与MCP

- `POST /api/v2/reports/published`：必须提供UUID格式的`Idempotency-Key`，正文为`name`及`source`。来源字段为`kind`（AGENT或MANUAL）、`releaseId`、`packageDigest`、`revisionId`、`runId`、`batchId`；只有AGENT还须提供`taskId`。身份由后端确定。
- `GET /api/v2/reports/published/requests/:requestId`：只读查询本账号原请求。
- `POST /api/v2/reports/published/:id/advance`：空正文，显式续接原任务，不改变原来源。

回执协议`shuduo-published-report-creation/v1`区分PREPARING、PARTIAL、SUCCEEDED。HTTP200／202不代替业务状态；成功还需校验原请求、来源、快照、版本及实际运行。相同键换正文返回409。结果未知先GET；确认不存在后，才能按相同键、相同正文重试。部分完成按原任务续接，不创建另一份。

CLI使用`reports from-publication --name 名称 --source-file published-source.json --request-id UUID`，`reports request --request-id UUID`及`reports resume --id CREATION_ID`。MCP对应`report_published_create`、`report_published_request`、`report_published_resume`，共用同一客户端校验与API。工具实现／本机调用不等于外部Agent已经注册连接或云端验收。

浏览器在发送前保存原请求；丢失回执时保持未确认，提供查询原请求。刷新页面只查询，不重新创建；已确认完成后才允许显式创建另一张。

## 验收范围

合成来源测试覆盖两套证券语义、身份隔离、正文冲突、全局最新数据变化、快照已写入但元数据回滚后的双库重开、聚合已完成但检查点丢失。真实本机界面复用先前MANUAL参考SQL的实际Spark发布结果，仅创建一个报表请求，注入一次成功回执丢失后按原编号恢复，刷新仍恢复同一结果。独立金额、脱敏CSV、CLI及MCP处理器查询对应同一聚合运行；没有新增模型／Spark／云操作。

原Spark来源、合成测试审阅、传输故障与新真实Agent任务分别统计。本次不计当前v3自主20例或公网验收；当前全量门槛为1600项（1599通过、1既有跳过），完整目标仍见[验收清单](goal-acceptance-audit.md)。
