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
| MCP | `report_provenance`，参数为 `reportId` 和 `runId` |
| CLI 离线 | `shuduo reports verify-provenance --file FILE` |

HTTP读取限制在本机原所属人。文件包含原需求与澄清文本，业务数据用快照摘要和结果摘要表示。离线命令验证文件内容与内部绑定，返回 `onlineAuthorityVerified:false`。服务端可按存档校验来源。两种校验都保持本机验收的范围。
