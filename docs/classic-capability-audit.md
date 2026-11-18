# 经典模块能力盘点

盘点日期：2026-11-19。本页记录代码提供的路径及明确边界，部署和完整 Agent 评测按[当前续接](goal-mode-next.md)核验。

| 领域 | 当前实现路径 | 后续边界 |
| --- | --- | --- |
| 数据源／元数据 | CSV真实读取、类型推断、结构版本；服务端白名单MySQL适配 | CSV来自仓库虚构样例，未开放任意上传；真实MySQL数据面及其他连接器需分别验收 |
| 离线同步 | SQLite实际FULL／UPSERT落地、有界原批次快照预览、自定义映射、主键与记录水位 | CSV合并所提供的增量行，MySQL为有界快照差异；源端过滤、删除同步和CDC待实现 |
| 实时同步 | JSONL本机事件处理、去重、水位、Checkpoint与恢复 | Kafka／Flink及数据库CDC适配未完成 |
| 数据开发 | Spark SQL、受限CPython、版本／差异、执行与独立断言 | 真实模型及特定环境需独立验收；语法覆盖、生产规模和云Python仍有边界 |
| 调度发布 | 不可变文件、DAG、原样例与本机沪深公告日历选择、本机计时、受控云接口与回滚 | 日历Agent／云端选择、年度维护、DataWorks／EMR适配及目标环境运行需实测 |
| 资产治理 | 登记资源目录、字段血缘、指标、标准、版本契约 | 全企业系统的采集与血缘覆盖取决于各适配器 |
| 数据质量 | 实际行规则、版本/批次/摘要、空数据及缺字段判定、历史与恢复证据 | 五类GUI参数和版本编辑已支持；本机归档输入已支持；云端归档、多源规则库及规模需扩展或验证 |
| 安全脱敏 | 邀请身份、项目权限、行列策略、脱敏查询及审计 | 公司SSO、独立租户与生产要求需结合公司环境适配 |
| DAPI／XAPI | 查询、声明式组合、版本、授权、限流、OpenAPI及日志 | 当前消费层和冻结结果有明确范围，尚非任意企业数仓的联邦查询 |
| 报表 | 数据集快照、真实聚合、KPI／图表、导出及来源回查 | 聚焦登记证券口径，更多BI编辑能力与连接器待扩展 |
| 运维／平台 | 运行事件、事故恢复、预算与配置状态 | 云资源、费用、SLO及多实例需实际环境证据 |
| Agent与多端 | 持久编排、开发修正、交付及专业工具；GUI/API/CLI/MCP | 替身回归不计完整真实成功；监控、授权消费和新口径须按同一案例闭环 |

代码入口见 [ingestion](../src/v2/ingestion.mjs)、[realtime](../src/v2/realtime.mjs)、[durable-agent](../src/v2/durable-agent.mjs)、[delivery](../src/v2/delivery.mjs)、[assets](../src/v2/assets.mjs)、[quality](../src/v2/quality.mjs)、[security](../src/v2/security.mjs)、[data-services](../src/v2/data-services.mjs)、[reports](../src/v2/reports.mjs)。

## 本轮前置缺口

离线同步API已有自定义映射，页面此前只支持同名映射和固定 `position_id` 主键。本轮补齐[手工映射、主键与水位](manual-sync-mapping.md)，不增加上传、凭证或云资源范围。

虚构CSV经真实文件读取与SQLite写入，全量3行、异名增量合并后4行。元数据变化时保留草稿并要求复核；创建任务不自动执行。源端增量、CDC、Kafka／Flink仍属后续适配，正式Agent评测另按运行证据计分。
