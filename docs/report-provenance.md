# 报表需求与审阅溯源

在数据报表或Agent交付页选择报表运行，展开「需求与审阅溯源」。面板展示原始需求、澄清问题和回答、实际应用的方案摘要，以及报表版本、运行与结果摘要。

应用时保存审阅依据，生成后绑定原数据集、快照、发布批次和运行。核对使用该运行对应的存档与结果。后续对话编辑、最新版本切换或失去响应后重新查询，都可沿原编号读取。已有应用可按原方案摘要显式核对并补齐溯源，沿用原报表结果。手动创建或历史缺少审阅记录的报表显示缺失状态。

## 下载与核对

| 入口 | 操作 |
|---|---|
| 页面 | 点击「导出溯源JSON」保存当前运行的附件 |
| API | `GET /api/v2/reports/{reportId}/provenance?run_id={runId}` |
| API 附件 | 同一地址加 `download_digest={已核对摘要}`，返回JSON附件。摘要变化时提示重新核对 |
| CLI | `shuduo reports provenance --id REPORT_ID --run-id RUN_ID` |
| CLI 保存 | `shuduo reports provenance --id REPORT_ID --run-id RUN_ID --download-digest SHA256 --out-file evidence.json` |
| MCP | `report_provenance`，参数为 `reportId` 和 `runId` |
| CLI 离线 | `shuduo reports verify-provenance --file FILE` |

先核对报表运行及其摘要，再同时提供 `--download-digest` 与 `--out-file`。CLI 校验附件、所选运行与摘要后，以 0600 权限保存服务端的原始字节。目标文件已存在时拒绝覆盖。成功回执只输出报表、版本、运行标识和摘要，需求与澄清文本保存在文件中。

HTTP读取限制在本机原所属人。文件包含原需求与澄清文本，业务数据用快照摘要和结果摘要表示。离线命令验证文件内容与内部绑定，返回 `onlineAuthorityVerified:false`。服务端可按存档校验来源。两种校验都保持本机验收的范围。

## 私有发布批次汇总

在运维监控的确切发布中选择「查看第 1 批报表」或「查看第 2 批报表」。任务所属人可查看该批次的客户资产、持仓及现金合计。系统重新核对原发布审阅、代码版本、监控事件与既有服务快照。快照缺失或改变时停止显示汇总，重新读取仍沿原批次。

从已核验的授权调用历史可直接查看同批次报表，也可从报表回到同批次接口记录。关闭接口执行器后的受邀只读入口仍可按原发布读取汇总。

「下载批次溯源 JSON」以当前汇总摘要请求服务端附件。若摘要变化后浏览器显示错误，返回报表页并重新读取汇总。文件记录业务日期、确切来源、汇总值与发布审阅摘要。它包含发布与快照证据，报表需求和报表方案审阅使用上面的独立协议。

| 入口 | 操作 |
|---|---|
| API | `GET /api/v2/reports/published/batch-summary`，参数为 `kind=AGENT`、`taskId`、`releaseId`、`revisionId`、`runId`、`packageDigest` 和 `batchId` |
| API 附件 | 同一地址加 `download_digest`，服务端用当前证据复核摘要 |
| CLI | `shuduo reports batch-summary --source-file source.json`，来源文件使用与 API 相同的字段 |
| CLI 保存 | 同一命令加 `--download-digest SHA256 --out-file batch.json`，仅创建新文件 |
| MCP | `report_batch_summary`，以 `source` 对象传入确切来源 |
| CLI 离线 | `shuduo reports verify-batch-summary --file batch.json` |

接口使用当前项目的受邀会话，仅原任务所属人可读取。读取与导出使用已保存的数据，业务写入保持关闭。离线核验覆盖文件摘要及内部来源绑定，在线权威需通过服务端复核。

## 私有批次报表的审阅归档

原任务所属人在批次报表填写归档名称和需求，审阅该批次的固定汇总后显式确认。每次新的确认保留独立版本、原需求、审阅时间、审阅摘要与资产汇总。归档写入只在受保护边界显式启用，报表权限和当前会话共同校验。只读入口可核对已保存版本。

在原 Agent 任务的「审阅发布与运行监控」选择「在此任务查看报表归档」，再选择确切批次和版本。地址栏保存所选请求、批次和归档摘要。关闭浏览器后，用此地址重新登录可恢复所选版本。批次、任务或摘要不符会显示核对错误，切换任务会清除旧定位。已归档的需求、汇总和下载入口在同一工作台内只读呈现。

| 入口 | 操作 |
|---|---|
| API 列表 | `GET /api/v2/reports/published/batch-archives`，传入与批次汇总相同的确切来源 |
| API 归档 | `POST /api/v2/reports/published/batch-archives`，正文为 `{draft, reviewedDigest}`，以 `Idempotency-Key` 传入原请求 UUID |
| API 回读 | `GET /api/v2/reports/published/batch-archives/{requestId}`，下载时可加 `download_digest` |
| CLI 审阅 | `shuduo reports prepare-batch-archive --file draft.json`，草稿字段为 `source`、`summaryDigest`、`title` 和 `requirement` |
| CLI 归档 | `shuduo reports archive-batch --file reviewed.json --request-id UUID --confirm` |
| CLI 回读 | `shuduo reports batch-archive --request-id UUID`，保存时追加 `--download-digest SHA256 --out-file archive.json` |
| MCP 回读 | `report_batch_archive`，传入 `requestId` |
| CLI 离线 | `shuduo reports verify-batch-archive --file archive.json` |

响应丢失时先查询原请求。相同编号和方案只返回原件，改动方案后沿用旧编号会被拒绝。回读与下载只使用归档保存的版本与快照证据。归档正文只由任务所属人读取，经典报表目录继续使用既有的独立权限边界。
