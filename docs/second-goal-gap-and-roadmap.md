# 全球产品对标、差距与演进路线

资料核验日期：2026-09-15。产品实现状态以[验收记录](acceptance.md)为准；官方产品说明不等于本项目已与厂商做同环境实测。

## 定级结论

采用五级成熟度，而不是用菜单数量评价：

| 等级 | 定义 |
|---|---|
| L1 可演示原型 | 界面或配置可展示，但关键数据/执行可能是模拟 |
| L2 可信单机场景 | 合成数据真实执行，版本、失败和证据可核对 |
| L3 可用团队试点 | 公网/内网多人使用，身份、隔离、持久化、成本和恢复通过验收 |
| L4 企业级平台 | 多项目、多引擎、规模、HA、SSO、治理和SLA成熟 |
| L5 领先体验 | 在L4基础上，Agent跨模块完成率、易用性和开放生态形成明显优势 |

数栈V2当前为**L2（可信单机场景）**：不是早期假数据原型，也还不是可交付公司的企业平台。优势是证券标杆链路证据严格、GUI/API/CLI/MCP同源、失败关闭和人工审阅边界清晰；最大短板是公网真实云、隔离Spark、多源连接规模和企业治理尚未验收。

近期目标是先到L3，不以一年为固定工期；L3门槛通过后，再按公司真实基础设施评估L4。全面“超过DataWorks”不是可验证的短期结论，应改成在选定证券任务上完成同任务对照，并争取更少人工步骤、更清楚证据和更高成功率。

## 世界级产品给出的最新设计信号

| 对标 | 官方能力信号 | 数栈应吸收的原则 | 不应误读 |
|---|---|---|---|
| DataWorks | Data Agent按数据集成、地图、开发、治理、运维分工，并在所在模块自动匹配；支持`@`上下文 | 一个统一入口，自动路由专业Agent；计划、代码、发布、运维共享任务状态 | 文档声称端到端，不代表本项目无需独立结果断言 |
| Databricks Genie Code | 全页命令中心与编辑器内助手并存；能生成/运行/修复代码、构建Pipeline和Dashboard；使用Unity Catalog权限，支持Skills、Instructions、MCP和定时任务 | “聊天管意图、编辑器管最终确认”；资源权限继承；可复用技能；任务可后台继续 | 部分能力有地域、计费和审批前提，不能只复制UI |
| Snowflake Cortex Agents | 语义视图、搜索、隔离Python、图表、自定义工具、Skills、MCP和Agent toolsets统一编排；提供线程、日志、Trace、反馈与评测 | 工具注册、权限执行上下文、语义层、评测和可观测必须是Agent平台的一等资源 | 强问数能力不能替代数据集成、开发和完整经典中台 |
| Microsoft Fabric | Notebook聊天与单元格内Copilot共享上下文；支持跨单元生成、差异审批、错误诊断；Fabric data agent继承用户对底层数据的权限并可接外部Agent | 同一上下文下的全局委托+局部修复；执行前可审阅Diff；跨入口保持身份 | Notebook Copilot多项仍是Preview；官方明确Agent不适用于要求100%确定性的任务 |
| Collibra | 多源目录、Profiling、样例、业务语义、技术/业务血缘、质量与访问申请结合；技术血缘覆盖临时对象和字段，AI Copilot/多Agent仍标Preview | 资产页成为信任中心；字段级血缘、质量、责任人、审批和变更影响合并呈现 | 治理深度强，不等于数据开发/调度体验本身领先 |
| Informatica IDMC/CLAIRE | 集成、CDC、质量、目录、API/App集成和Agent工程共用元数据；Headless能力通过MCP进入外部工具 | 经典能力先成为可靠原子API，再供GUI/CLI/MCP/Agent复用；元数据驱动生成与优化 | CLAIRE Copilot官方资料仍说明部分资产需人工验证/保存/发布/运行 |

官方资料：

- [DataWorks Agent智能体](https://help.aliyun.com/zh/dataworks/user-guide/data-agent)
- [Databricks Genie Code](https://docs.databricks.com/aws/en/genie-code)
- [Snowflake Cortex Agents](https://docs.snowflake.com/en/en/user-guide/snowflake-cortex/cortex-agents)
- [Microsoft Fabric Notebook Copilot](https://learn.microsoft.com/en-us/fabric/data-engineering/copilot-notebooks-overview)
- [Microsoft Fabric data agent安全与责任边界](https://learn.microsoft.com/en-us/fabric/fundamentals/copilot-data-science-privacy-security)
- [Collibra Data Catalog](https://productresources.collibra.com/docs/collibra/latest/Content/Catalog/to_catalog.htm)
- [Collibra Data Lineage](https://productresources.collibra.com/docs/collibra/latest/Content/CollibraDataLineage/co_collibra-data-lineage.htm)
- [Informatica Headless Data Management](https://www.informatica.com/headless.html)
- [Informatica CLAIRE Copilot文档](https://docs.informatica.com/content/dam/source/GUID-5/GUID-5C5CD7EE-6788-480E-A3A4-3773C2C98689/5/en/CDI_November2025_%28CLAIRE%29CopilotForDataIntegration_en.pdf)

## 当前能力与Gap

| 维度 | 当前证据 | 当前级别 | 到世界级产品仍缺什么 |
|---|---|---:|---|
| Data Agent开发闭环 | 真实Qwen生成、Spark执行/报错修复、版本Diff；20条本机完整链路100% | L2 | 更多输出契约、跨模块长任务、后台恢复、反馈学习、技能/指令管理、云隔离执行 |
| 经典功能广度 | 接入、离线/实时、开发、调度、资产、质量、安全、报表、DAPI/XAPI、运维均有真实合成用例 | L2 | 真实MySQL/JDBC、对象存储、Kafka/Flink、CDC、Python、BI连接器及规模/兼容矩阵 |
| 元数据与治理 | 版本化目录、表级血缘、同步字段映射、实际指标/标准，以及契约版本、兼容评估、SLO检查、告警恢复 | L2+ | Spark SQL字段级解析、技术/业务血缘统一、契约贯穿同步/开发/发布阻断、多项目审批、责任人/术语/认证、自动Profiling |
| Agent可信度 | 独立断言、最多3次修复、批准绑定哈希、失败/阻塞/救援留存、权限外发门 | L2+ | 在线Trace、逐步工具证据、用户反馈、回归集版本、风险分级审批、模型/Prompt A/B与成本质量看板 |
| 易用性与UI | 统一现代侧栏、工作台+Agent、1280/768无横向溢出、状态/空错忙反馈 | L2 | 公网真实性能、完整键盘/读屏/WCAG、全局命令中心、跨模块任务收件箱、个性化工作区 |
| GUI/API/CLI/MCP | 主要V2资源同源，CLI/MCP有契约测试 | L2+ | 公网OAuth/会话委托、细粒度Scopes、Webhook/SDK、API兼容策略、MCP审计和第三方互操作测试 |
| 身份与安全 | 邀请、scrypt、Secure会话、CSRF、项目角色、行列策略、脱敏和审计本机通过 | L2 | 企业SSO/SCIM、密钥轮换/KMS、项目级数据隔离、审计导出、策略引擎和渗透测试 |
| 可靠性与运维 | 冷启动快照代码、幂等/CAS、事故关联恢复、版本回滚 | L2 | 真实云灾备、SLA/SLO、日志Trace指标、队列/重试/死信、多实例一致性、容量与故障演练 |
| 公网与成本 | 独立V2部署包和受保护手动工作流已准备 | L1+ | 真实RDS/OSS/FC验收、域名备案、两网络两浏览器、预算告警和费用停损闭环 |

## 演进路线：按门槛而非按月份

### P0：从L2到L3公网可信试点

1. 只读核验RDS/OSS/FC/账单；建立独立平台库和最小权限账号。
2. Linux CI实际构建Node24包；独立FC函数单实例灰度，MySQL/OSS冷启动恢复通过。
3. 建立隔离Spark执行单元，公网任意代码默认关闭；完成超时、资源限额、权限、取消和回滚。
4. 公开只读、受邀写入、DAPI/XAPI外部调用在HTTPS下连通；Safari/Chrome及两类国内网络验收。
5. 把当前20例扩展为不同输出契约、权限和跨模块任务；公网完整E2E达到≥85%，不沿用本机结论。
6. 账单阈值、调用配额、无最低实例、日志留存和一键停用演练完成。

### P1：建立差异化的“Agent原生中台”

1. 全页Agent命令中心、模块内Agent和编辑器内局部修复共享同一任务线程；支持用户指令、项目技能、计划Diff、风险分级审批。
2. Agent每一步引用实际资源/版本/运行，页面可以展开工具输入摘要、输出摘要、费用、延迟与批准人；形成可复跑Trace和反馈评测。
3. 新增真实MySQL/JDBC、OSS、Kafka/Flink和CDC适配；每种连接器先过经典人工/API验收，再开放给Agent。
4. 实现Spark SQL字段级血缘、契约在同步/开发/发布中的传播与阻断、多项目变更审批、自动Profiling与资产认证，把Agent上下文从“字段列表”升级为可信知识图谱。
5. DAPI/XAPI增加SDK、Webhook、OAuth应用、分布式限流、灰度版本、SLA和消费血缘；MCP按Scopes继承相同授权。

### P2：从团队试点到企业级复刻

1. 多项目/多租户、SSO/SCIM、KMS、策略引擎、审计导出、HA/DR和容量测试。
2. 接入公司已有计算、调度、元数据、审批和监控，不推倒重建；以适配器替换本项目本机实现。
3. 用公司许可的匿名任务集做DataWorks与现平台同任务对照：完成时间、人工操作、返工、正确率、故障恢复、成本。
4. 形成迁移清单、灰度策略、培训、运行手册和全流程PPT；只有同任务证据支持时才声称某项体验更优。

## 下一次对标评测的冻结任务

当前20例集中于客户资产加工。下一轮至少加入：客户资产明细+汇总双输出、顾问权限裁剪、产品适当性标签、基金组合穿透、交易日增量、迟到行情修正、Schema兼容/不兼容变更、质量阻断发布、DAPI版本灰度、XAPI部分失败、跨模块根因诊断和成本超限拦截。

每个任务同时记录：首个正确结果耗时、Agent工具调用数、人工批准次数、返工次数、最终断言、权限事件、Token/计算成本和可恢复性。没有厂商同环境结果时只报告数栈自身数据，不凭宣传页推导“超过”。
