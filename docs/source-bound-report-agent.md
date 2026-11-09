# 同源报表Agent：规划、审阅与实际生成

更新：2026-11-09。独立开发工作台可基于当前发布批次提出报告需求，查看Agent方案，显式审阅后生成实际报表。沿用原`reports`专业工具与创建API，没有另建执行器。

规划器只接收字段、口径、批次标识、行数和内容摘要。方案只能选择此来源允许的指标；模型不能指定其他来源、数据集、SQL或权限。行业等字段缺失时返回一个澄清问题，不能拿其他指标冒充。来源及指标定义改变后，原方案不能继续应用。

方案保存来源、上下文摘要、所选指标和审阅摘要。应用必须提交确切`proposalHash`，调用已有创建流程，并以方案ID作为原创建请求ID。丢失应用响应后先查原方案，应用和新模型请求关闭；已完成的报表不会重复规划或聚合。规划可以取消，已进入生成或完成的报表不能用“取消规划”冒充撤销。

界面优先显示报告需求与方案，手动创建折叠为备用入口。刷新保留批次和原方案；首次历史读取尚未确认时不开放新规划。确认原请求不存在后，才能显式按原编号、原内容重试，不能使用后来修改的输入替代。

## 内部工具与多端契约

- 既有`reports`专业工具支持可选`source`，工具目录摘要随输入契约变化。主控意图可保存`reportSource`；调用报表工具时必须与它相同，原批准不能用于另一发布上下文。
- `POST /agent/intents`可提供`reportSource`；CLI为`agent understand --report-source-file`，MCP为`agent_intent_create.reportSource`。
- `POST /reports/agent/plans`可提供`source`；无来源的传统方案保持草稿语义。来源方案只在本机边界开放，并按实际身份隔离。
- `GET /reports/agent/plans?source_batch_id=UUID`列出本账号同批次方案；默认列表只返回传统方案，避免旧界面误把实际生成当作写草稿。
- `GET /reports/agent/requests/:requestId`只读恢复原规划请求。CLI为`reports plan-request --request-id`，MCP为`report_plan_request`。
- `POST /reports/agent/plans/:id/apply`：同源方案须提供`proposalHash`。CLI为`reports apply-plan --proposal-hash`，MCP为`report_plan_apply.proposalHash`。传统方案仍只创建草稿；同源方案会实际物化和聚合。
- 直接创建报表可选`metricIds`，省略时仍使用原五组件；老请求的正文签名不变。CLI的`--metric-ids`及MCP同名字段使用同一校验。

## 验收与边界

完整本机CI1605项：1604通过、0失败、1既有跳过。覆盖内部工具调用／重放、批准上下文与来源匹配、指标子集、缺字段澄清、非法指标、归属隔离、方案摘要及应用／取消边界；模型适配器提示只含元数据。

隔离副本复用原MANUAL版本的真实Spark发布结果；一次合成规划选择持仓与现金两项，实际应用只发送一次。注入成功应用回执丢失后，界面查询及刷新找回同一方案／批次／聚合运行；内部工具重放、CLI与MCP处理器查询对应同一结果，CSV一致且客户维度脱敏。原核心运行与服务数量不变。

本轮规划器、主控意图和步骤批准是合成验收；未调用真实模型或新Spark，未部署云端，不能算当前v3自主20例、真人审批或外部MCP注册连接。真实端到端门槛仍按[完整清单](goal-acceptance-audit.md)验收。
