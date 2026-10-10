# Agent开发、核验与交付

Agent开发工作台围绕同一任务呈现代码、结果、逐项核验、交付文件、审阅发布和运行监控。当前核验契约为已知的虚构证券客户资产口径；新增指标需要建立新的独立预期。

## 核验与交付

`GET /api/v2/agent/tasks/:id/workflow`返回代码版本对应的结果报告、最新交付准备、文件及演练摘要和发布条件。检查代码哈希、实际Spark执行、客户唯一性与金额/数量，以及五个独立回归场景。读取不会提交模型或Spark工作。任务权限沿用代码任务所有者与项目管理员。

`POST /api/v2/agent/tasks/:id/prepare-delivery`从已通过核验的源任务生成同摘要绑定的SQL、测试SQL、DAG、部署清单、日历、输入快照与验证文件。已启用持久SQL Agent的环境使用可恢复交付模式。

`POST /api/v2/agent/deliveries/:id/advance`接受`expectedVersion`，一次推进一个持久边界。先保存文件和唯一Worker提交编号，再提交真实文件演练。未知提交结果沿用原编号恢复；GET只读取结果。演练要求主SQL、测试SQL摘要、引擎版本和五场景断言全部匹配。

`POST /api/v2/agent/deliveries/:id/cancel`先持久保存取消，再发送Worker取消标记；迟到结果不能复活任务。恢复不生成新模型任务，不复用旧审批。

GUI、`shuduo agent workflow`、`shuduo agent advance-delivery --version …`和MCP的`agent_development_workflow`、`agent_delivery_advance`共用这些API。

## 发布与监控

本机测试环境沿用现有摘要绑定审阅、批准和发布API，在同页观察调度器实际触发的批次。每次代码修改需要新的核验和交付。发布是否健康取决于运行记录，不由按钮文案决定。

当前发布创建接口仅支持已启用LOCAL_TIMER的本机测试环境。云端工作台可以准备和演练交付文件，尚未验证的定时执行、上线发布和运维监控不会显示为完成。正式云发布适配和后台触发需复用现有预算、身份与恢复机制，并补真实上线后批次验收。

导出的`shuduo-delivery-package.json`可用现有`shuduo-package unpack`解包，摘要从包记录取得。它是版本产物，不能把下载行为视为上线。
