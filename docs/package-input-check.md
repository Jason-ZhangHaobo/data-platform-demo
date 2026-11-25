# 在独立 Agent 中直接核验原包输入

## 工程师操作

进入原交付文件区，点击“核验原包输入”。核验通过后，可以查看原同步任务、批次、持仓行数和摘要，并下载该包的 JSON 回执。MySQL 数据源核对当次同步保存的落地回执和完整持仓快照；CSV 数据源读取登记的原文件，也支持下载[供离线重放的最小输入证明](input-evidence-export.md)。

核验结果范围是 `LOCAL_SAVED_INPUT_ONLY`。它证明所选交付包与原输入一致，不替代 SQL 执行结果、调度、审阅、发布、消费或完整 E2E。修改来源后应重新核验；页面内重新核验会清除旧成功反馈，失败明确显示原因。切换包或关闭面板不会采用迟到响应。

## 读取与权限

- 只使用原包绑定的 `sourceId/sourceRevisionId/metadataVersionId` 及原内容摘要，不跟随当前源版本。
- 读取现有合成数据目录中的普通 CSV，沿用 5,000,000 字节及禁止路径越界/符号链接的限制；不接受用户提供任意文件路径。
- 原文件缺失、不可读、字节改变或元数据失配时拒绝；错误不包含服务器文件路径。原包和已下载的材料可继续回看，不能补造原 CSV 或用新文件替代。
- 原 CSV 仅在后端参与解析与摘要核对，不作为响应、模型输入或下载内容；未映射原值不会进入回执。
- 沿用原包所有权、本机回环和确切摘要限制，不开放公网能力或扩大用户权限。

CSV 当前表和 CSV 全量归档继续使用原文件独立重放。CSV 物化来源核对留存的完整目标，支持增量合并和删除后的空持仓，空持仓仍保留登记账户和现金。

### 从 MySQL 交付包查回当时的持仓

例如，工程师为较早的两条持仓准备客户资产交付包。提交后 MySQL 源表和落地表都已更新。审阅者仍可在该包核对同步任务、原运行、源版本、采集的元数据、标准落地回执及快照摘要。后端从原快照重建登记业务口径，逐项对照开发时冻结的上下文和包内 `fixtures.json`。这个操作使用已保存记录，新增模型和 Spark 调用均为零。

MySQL 回执的 `input.proof.scope` 为 `RETAINED_MYSQL_FULL_SNAPSHOT`。`landingReceiptHash` 指向原批次落地回执，`landingSnapshotHash` 指向该批次保存的持仓，`input.contentHash` 是同步时读取的源行摘要。回执仅覆盖所保存的有界读取，`upstreamCoverageVerified` 为 `false`。下载内容包含编号、数量和摘要；原始持仓行留在项目数据存储中。原回执缺失或关联变化时，重新核验会撤下旧成功状态。

## 共享接口

```text
GET /api/v2/delivery/packages/:id/input-check?packageDigest=<SHA256>
```

只接受一个完整摘要。正确结果协议 `shuduo-package-input-check/v1`，绑定原包编号/摘要，`readOnly:true`、`sourceCsvExposed:false`；包含来源核对摘要及内容摘要。`newModelCalls/newSparkRuns/cloudRequests` 为零，`fullLifecycleE2E/agentIndependentE2E/countsTowardLiveEvaluation/publicDeployed` 为 false。

```sh
node bin/shuduo.mjs delivery input-check --id <PACKAGE_UUID> --package-digest <SHA256>
```

MCP 为只读工具 `delivery_input_check`，参数 `packageId`、`packageDigest`。GUI/API/CLI/MCP 使用同一核验；不需要模型或 Spark 执行，不准备新制品、不产生新同步运行、不写健康或批准。

## 验收与边界

真实 MySQL 与 Spark 的 CI 用同一 Agent 成功运行准备八文件，分别核对每份文件的字节数和 SHA-256，并实际运行包内的 `main.sql` 与 `tests.sql`。文件演练应得到原两位客户资产 1,300.00 元、700.00 元，五组场景通过。按同一请求重试只找回原包及原演练；此时交付状态是“待工程师审阅”，发布数为零。该样例的 SQL 生成器为合成实现。

本机真实 CSV/SQLite 覆盖空持仓、后续源版本变化仍核对原版本、原文件变化/删除/符号链接、错误元数据、身份/Host/摘要边界、快照损坏及 5 MB 文件限制。原数据库变更计数保持，现有离线与证明下载兼容。协议测试中的交付计算回执为显式合成 fixture，不能计真实模型或 Spark。

实际 Chrome 在既有已核验包的隔离副本中完成直接核验、回执文件实际下载、改变原 CSV 后清除成功、恢复原字节后重新通过和窄屏检查；模型/Spark/制品写入/HTTP业务写为零。仅本机验收，正式 Safari、云端与公网生命周期仍分别待验。
