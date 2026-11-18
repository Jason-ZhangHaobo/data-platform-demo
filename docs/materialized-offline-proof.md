# 完整持仓快照的离线交付核验

## 作用

交付包不应因最后一个文件是增量或删除事件而被误当成完整持仓。离线核验现在支持 `SYNC_MATERIALIZED_HOLDINGS_V1`，把原 CSV、采集元数据、任务配置、冻结输入和原目标快照串联核对。全量、增量合并和显式变更使用确切留存目标；清仓后的零行仍保留登记账户及现金。

原当前表及 `SYNC_RUN_ARCHIVE_V1` 继续使用已有全量 CSV 重放，旧返回协议保持。新来源没有快照就拒绝，不以当前表、最后一个增量文件或人工补造数据替代。

## 发布前只核验输入

工程师拿到八文件交付包后，可在发布前检查输入证据。包文件是原 `manifest/files/digest` JSON，摘要必须为原包摘要，不修改原内容。

```sh
node scripts/verify-saved-sync-sql-lifecycle.mjs \
  --input-only \
  --metadata /path/to/v2-platform.sqlite \
  --landing-snapshots /path/to/v2-landing.sqlite \
  --source-csv /path/to/original-source.csv \
  --package-file /path/to/original-package.json \
  --package-digest <SHA256> \
  --project project-securities-lab \
  --actor local-engineer
```

`--actor`、`--project` 必须对应原包及原冻结记录。上述为虚构本机示例身份，不是公网身份授权。输入模式不接受消费、发布批次、报表或质量参数；不能把它当作简化的完整评测。

返回协议 `shuduo-saved-sync-sql-input/v1`，范围 `LOCAL_SAVED_INPUT_ONLY`。结果列出原同步批次、元数据、输入摘要、目标行数与来源证明；`fullLifecycleE2E`、`agentIndependentE2E` 和 `countsTowardLiveEvaluation` 均为 false。只核对已存证据，不运行模型、Spark 或发布。

## 完整核验与兼容

原完整生命周期或 `--consumption-only` 命令在选择新来源时，额外提供同一个 `--landing-snapshots`。其余原包、请求、发布批次、调用、报表/质量证据要求保持，不能用输入阶段结果顶替。新来源的完整生命周期结果使用 `shuduo-saved-sync-sql-lifecycle/v3`，消费核验使用 `shuduo-saved-sync-consumption/v2`，包含同一份输入来源证明；旧来源原协议保持。

所有数据库均以只读方式打开，在同一进程的读取事务中按原编号查询。不构造可写 LandingStore、不重新落地、不初始化缺表、不覆盖原数据库。原数据应由一致备份或受控静止导出提供；只读事务不能证明来自不同时间点的独立数据库天然一致，证据不匹配就拒绝。

## 核验内容与限制

- 核对原任务/运行、源版本、元数据、项目、配置摘要、成功/实际执行/留存状态及源 CSV 字节摘要、行数和结构。
- 冻结记录和交付上下文必须与原作者、目标、模式、批次、行数及摘要一致；重新构建登记业务预期，不能修改现金或来源后复用旧摘要。
- 留存快照重算内容及业务行摘要、核对原字节长度和内部行键、业务字段、原任务配置和创建时间；不读取当前持仓表作为替代。
- 显式变更核对原代号、映射/主键规格、运行声明的控制摘要及计数关系。证明标明 `historicalControlReplayVerified:false`：历史完整墓碑链没有独立留存，不能声称重放并重算全部历史控制状态。
- 证明范围为 `RETAINED_TARGET_SNAPSHOT`。`sourceCsvRows` 和 `targetRows` 分开，例如一个 DELETE 事件可对应零行完整目标。
- `eventReplayVerified:false`、`upstreamCoverageVerified:false` 保持明确；来源核验不是上游业务覆盖、数据库 CDC、真实模型、自主生成、云端执行或完整 E2E 的证明。

## 本轮验证

实际 CSV/SQLite 覆盖种子、删除、空持仓与增量合并，已留存快照在后续批次完成及数据库重新打开后仍可核对。缺失/损坏/错批、元数据、配置、控制、项目、身份及预期变化均拒绝。实际 CLI 覆盖发布前输入检查和跨阶段参数拒绝，读取前后数据库字节保持。测试交付计算回执为显式合成 fixture，不计真实模型或 Spark 验收；本轮无需重新运行这些服务。
