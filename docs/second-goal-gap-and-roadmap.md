# 全球产品对标与差距
此文件为对标附录。新版范围、优先级、里程碑以 PRD.md、decisions.md 和 product-roadmap.md 为准，替代旧十二个月分期承诺。
资料核验基线：2026-09-13；官方说明不等于已进行同环境实测。

| 对标 | 已查证设计方向 | 本项目验证重点 |
|---|---|---|
| DataWorks | 跨模块 Skills、代码及数据服务发布 | 同一任务贯穿 SQL、调度、部署、DAPI/XAPI |
| Databricks | 开发上下文、执行反馈、修正和权限 | 编辑器内 Agent、差异、真实结果验证 |
| Snowflake | 语义与受治理工具调用 | 参数、指标口径、权限与查询证据 |
| Fabric | 上下文编程、差异审阅；相关 Copilot 为预览 | 无需反复描述表结构，错误与结果联动 |
| Collibra | 目录、质量、血缘与治理 | 数据契约与消费者影响 |
| Informatica | 自然语言生成映射与集成流程 | 映射配置真实执行、可人工接管 |

官方来源：
- https://help.aliyun.com/zh/dataworks/user-guide/new-data-agent
- https://help.aliyun.com/zh/dataworks/user-guide/getting-started-with-dataservice-studio
- https://docs.databricks.com/aws/en/notebooks/ds-agent
- https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-agents
- https://learn.microsoft.com/en-us/fabric/data-engineering/copilot-notebooks-overview
- https://www.collibra.com/resources/collibra-platform
- https://www.informatica.com/about-us/news/news-releases/2025/05/20250514-informatica-unveils-agentic-ai-offerings-on-industrys-first-ai-powered-cloud-data-management-platform.html

## 基线判断
当前是可演示产品原型，不能声称已经具备生产级授权、SQL/实时计算、质量或调度。
V2 以任务正确率、人工步骤、返工次数、访问体验和运行成本衡量改进，不以模块数宣称世界第一。

本轮新增真实本地 Spark 与 React 代码工作台，并不等同于生产级平台或已接通真实模型。
DataWorks/Databricks/Fabric 的共同参考点是开发上下文、执行反馈及人工接管，不照搬其全部审批模式。
Fabric 所引用 Notebook Copilot 文档明确为 preview；Informatica 来源为 2025 年发布公告，不能据此推定每项 Agent 当前均已普遍开放。
六家厂商本轮仅核对官方材料，没有登录这些产品做同环境性能或成功率对照，后续须用相同证券任务实测。
