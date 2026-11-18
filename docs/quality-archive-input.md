# 原归档批次质量复检

## 目的和范围

复检实际留存的原同步批次，不把当前表的通过结果误当成历史通过。本机质量规则可使用已审阅的当前规则版本，在对应落地表的原快照上执行非空、唯一、数值范围、枚举或时效规则。时效按本次检测时间判断，不回拨到历史时点。

该能力复用真实CSV／SQLite同步归档和JavaScript行规则，不使用模型替身或固定评分。本机回环开放，云端入口不能据此获得归档检测权限。当前质量助手仍只生成规则草稿；共享API／CLI／MCP提供显式调用，不代表已验收Agent自主选择与完整E2E。

## 使用

1. 在“数据质量”选中规则，展开原归档批次复检，明确选择任务、批次和行数；来源区可展开查看元数据版本及完整快照摘要。
2. 规则变化后保留原选择，先审阅并采用当前规则版本。点击“检测所选原批次”才执行；目录读取和刷新不检测。
3. 查看原批次、规则版本和实际通过／失败计数。页面回看旧回执时分别显示“原检测规则V1／当前规则V2”，不会静默以新版本重跑。
4. 响应未确认时保留原请求UUID，恢复动作先GET回读；存在则采用原回执，不存在且原版本仍有效才按原UUID提交。刷新只读取已保存结果。重复链接编号拒绝；其他操作不能覆盖较晚的手动选择。

历史复检结果标记`HISTORY_ONLY`，不更新规则当前健康或lastRunId，不新建当前质量告警，不解除当前告警或运维事故，也不进入当前运维健康计数。历史失败／通过均保留在质量运行历史。当前表检测沿原流程，真实当前修复仍可解除对应告警。

目录最多返回最近40个已留存候选，完整性在运行前重新核对。快照未留存、超限、原任务版本不符、跨表、摘要不符或字节损坏均拒绝，不从当前表补造历史。当前版本应用于旧数据，不宣称复现历史当时的规则配置。

## 契约与多端

POST `/api/v2/quality/rules/:id/run`支持：

```json
{
  "expectedVersionId": "REVIEWED_RULE_VERSION_UUID",
  "sourceSelection": {
    "kind": "SYNC_RUN_ARCHIVE_V1",
    "taskId": "ORIGINAL_TASK_UUID",
    "runId": "ORIGINAL_RUN_UUID",
    "metadataVersionId": "ORIGINAL_METADATA_UUID",
    "snapshotHash": "ORIGINAL_SNAPSHOT_SHA256"
  }
}
```

归档请求必须使用`Idempotency-Key` UUID。来源必须完整；原先被忽略的`syncRunId`等顶层未知参数现在422，不能悄悄检测当前表。当前表省略`sourceSelection`时保持原请求、响应及幂等契约。

- `GET /quality/rules/:id/archive-inputs`：本机候选批次，只读，不声称已当场核验每份快照。
- `GET /quality/rules/:id/run-requests/:requestId`：按原请求读取准确run、原规则版本和runWrite，不执行检测。旧回执说明过去那次已核验结果，不代表原归档现在仍可重新读取。
- 新归档响应含`runWrite.runId`；run包含规则版本／配置摘要、原批次、元数据、快照、落地摘要与行数及独立来源摘要。客户端核对同一批次和计数，不能仅按HTTP201显示通过。

```sh
shuduo quality archive-inputs --id RULE_ID
shuduo quality run --id RULE_ID --expected-version-id RULE_VERSION --archive-task-id TASK_ID --archive-run-id RUN_ID --archive-metadata-version-id METADATA_VERSION --archive-snapshot-hash SHA256 --request-id REQUEST_UUID
shuduo quality run-request --id RULE_ID --request-id REQUEST_UUID
```

MCP使用`quality_archive_inputs`、`quality_rule_run`的`sourceSelection`及`requestId`、`quality_run_request`。未知、重复、部分来源参数在发送前拒绝；后端同样验证。GUI／API／CLI／MCP共用同一执行和回执。

## 验收

`test/v2/quality-archive-input.test.mjs`覆盖真实三批CSV／SQLite、五类规则、错源与损坏拒绝、跨当前表更新后的原请求回读、历史与当前健康隔离，以及CLI／MCP参数和非本机拒绝。原质量版本、缺字段／空表和恢复测试继续回归。

实际浏览器已验证负价旧批失败、正常历史批通过但当前告警保持、响应损坏后的GET恢复、刷新无重跑、版本变化保留选择，以及桌面／窄屏来源展示。最终界面只读复验复用原回执，不再检测。真实模型、Spark、云端及正式20例验收不由本项替代。
