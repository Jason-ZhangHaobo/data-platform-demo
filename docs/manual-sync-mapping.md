# 离线同步手工字段映射

使用仓库内虚构证券持仓，支持重命名和跳过字段，不包含表达式转换或任意文件上传。

1. 数据源页选择 `positions_aliased.csv`，登记、连接测试并采集元数据。
2. 在离线同步的手动配置中设置目标表及下列映射。
3. 选择主键、水位并创建版本化草稿；核对已保存配置后明确点击实际执行。

| 源字段 | 目标字段 | 角色 |
| --- | --- | --- |
| holding_id | position_id | 主键 |
| customer_id | client_id | 普通字段 |
| security_code | security_code | 普通字段 |
| asset_class | asset_class | 普通字段 |
| industry | industry | 普通字段 |
| holding_value | market_value | 普通字段 |
| biz_date | trade_date | 记录水位 |

目标留空即跳过；重复或非法目标禁止创建。主键支持1—5列，按所选顺序保存，键值逐列非空且不能含分隔控制字符。主键与水位按源字段选择，保存时使用映射后的目标名。

水位只记录本次输入最大值，不用于源端过滤或CDC。数值按精确数值比较，其余按原文本顺序记录；CSV日期采用标准日期文本。FULL替换目标表，INCREMENTAL_UPSERT合并提供的行并保留其他旧行。

## 源版本变化

将同一源切为 `positions_aliased_incremental.csv` 新版本并重新采集元数据。旧配置保留，创建关闭；明确选择“使用当前元数据”后，仍存在的映射和角色继续保留，缺失角色须重新选择。

切换增量模式并创建新任务。以 `raw_positions` 为目标，全量3行合并为4行，POS-002市值从500.00更新到650.00，新增POS-004市值1200.00。默认预览仅显示 `raw_positions`；其他目标看所选任务运行回执。

## 多端与恢复

API `mapping` 使用源到目标映射，`keyFields`／`watermarkField` 使用目标字段名。GUI携带 `sourceRevisionId` 与 `metadataVersionId`；服务端变化时拒绝创建，不静默绑定新版本。

CLI提供 `--source-revision-id` 与 `--metadata-version-id`，须同时填写；MCP `sync_task_create` 支持同名字段。旧调用可同时省略，按服务端当前版本建草稿。GUI相同配置重试沿用原请求编号，回读已有任务不执行同步。

测试见 `sync-task-mapping.test.mjs`、`ingestion-watermark.test.mjs` 和[验收记录](acceptance.md#离线同步手工映射与版本复核)。这些本机CSV／SQLite结果单独统计，不计真实模型、Spark或完整Agent评测。
