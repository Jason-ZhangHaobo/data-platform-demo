# 数据契约自动约束数据服务发布

更新：2026-11-09。首版在本机开发范围将已有数据契约绑定到DAPI／XAPI，发布或切换历史版本前实际检查冻结来源。契约检查从手动查看推进到实际阻断；既有未配置门禁的服务保持原行为，不能称为全平台已经强制治理。

## 使用与判断

在数据契约模块登记字段、必填约束、行通过率和最大陈旧秒数，再在数据服务中选择契约绑定。绑定固定契约版本及规则摘要，变更必须生成新门禁版本并填写理由；契约后来变化会阻断，须重新审阅绑定，不能默默采用新规则。

默认按每一行带时区的源时间检查，采用最旧时间；缺少任一行时间返回PARTIAL并阻断。可明确选择“发布完成时间”，它只衡量批次处理完成距检查的时间，不证明行情、业务日期或T+1及时性。未来时间异常同样失败，未测量不能显示通过。

门禁读取接口确切版本的发布批次、冻结字段和实际行，并核对业务快照完整性与归一化内容摘要。不会使用全局最新资产补齐缺字段。XAPI检查固定子DAPI版本的来源，不能用另一个已通过来源代替。任一检查未通过或证据不可用，原线上指针保持；合格后才切换。每次新发布／切换重新检查，历史“当时放行”不等于当前仍新鲜。

门禁记录单独归属服务发布，不恢复或关闭当前全局资产告警。它不替代证券金额、现金去重、证券粒度等独立业务断言，也不是生产安全审批。

## 统一接口与恢复

| API（前缀`/api/v2`） | 作用 |
|---|---|
| `GET /data-services/:id/contract-gates` | 绑定、不可变配置版本及最近30条发布／切换判定 |
| `POST /data-services/:id/contract-gates` | `contractId/contractVersionId/freshnessBasis`，绑定并启用 |
| `POST /data-services/:id/contract-gates/:bindingId/versions` | `expectedBindingVersion/contractVersionId/freshnessBasis/changeReason`，并发条件更新 |
| `GET /data-services/:id/contract-gate-requests/:requestId` | 按实际账号恢复原保存回执，当前新版本独立返回 |

两个写接口必须携带原`Idempotency-Key`。协议`shuduo-service-contract-gate-write/v1`保存不可变原版本；同编号不同内容拒绝，其他账号不能读取原回执。页面先保存非秘密请求，再发送；结果未知时冻结编辑，先查原编号。确认未找到后才能显式按原内容重试；当前版本已变化需明确采用，不能用最新版本冒充原保存结果。

CLI使用`contracts service-gates/bind-service/gate-version/gate-request`；MCP为`service_contract_gates/service_contract_gate_bind/service_contract_gate_version/service_contract_gate_request`，共用客户端校验。它们只配置元数据，不自动发布或发放调用凭证。

## 验收与范围

完整本机CI1610项：1609通过、0失败、1既有跳过，类型、构建与入口体积门通过。定向回归覆盖缺时间、必填字段、契约变化、XAPI固定子版本、快照变化、未来时钟、激活预检变化、并发旧版本和原保存恢复。真实页面在隔离副本复用历史MANUAL Spark发布行：默认门禁实际拦截候选且保留原线上版本；显式采用批次处理时效后实际放行。一次成功保存回执被合成丢弃，查询找回同一绑定；仅产生两个配置版本。API、CLI与MCP处理器回读同一判定，原开发／发布／消费记录不变。

此轮没有调用真实模型、新Spark或云资源；页面故障、测试审阅和门禁设置属于本机验收。首版仅支持客户资产数据集及本机配置；私有管理器继承检查钩子，但真实云配置／来源、同步与代码交付门禁仍未验收。不能计入当前v3自主20例、公网完成或外部MCP连接。
