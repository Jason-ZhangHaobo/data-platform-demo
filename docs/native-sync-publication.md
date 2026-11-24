# 原生持仓：明确发布、原请求恢复与两批监控

接续[文件审阅](native-sync-review.md)。适用于本机原生 Spark SQL Agent 的冻结虚构持仓；本轮不开放云端或生产发布，不代批新的真实业务包。

## 使用流程

1. 打开确切交付，核对八文件与成功演练，独立记录本人文件审阅。
2. “两批本机测试与监控”展示另一组发布确认，默认未勾选。明确批准此包、原代码和演练，以及同一冻结业务日的两批实际计算。
3. 点击“批准并启动此版本两批本机测试”。先只读核对原请求和原审阅，再复用既有批准与激活 API。首批约 5 秒后、第二批约 35 秒后触发，间隔 30 秒；实际时间以激活记录为准。两批绝不是两个交易日。
4. 按“查询原发布与两批监控”查看状态。文件审阅与发布权限分别遵守原工作台权限。原生持仓使用专用入口，避免显示通用发布表单或用其他版本的发布填补空白。
5. 需要时可“停止此版本后续本机批次”。历史和原批准保留；停止结果未知时仍先只读查询，不重新发布。

本机调度器必须已经启用；页面不会替你开启。关闭页面不会撤销已批准的两批；本机服务关闭后并不具备云端持续运行保证，原批次须先恢复查证。此边界不同于已经验收的长期云后台。

## 响应丢失与重开

- 每次明确发布冻结一个 UUID 请求。原任务、交付、包、演练、文件审阅及演练摘要保存在 URL 元数据中，不含密码、SQL、调用令牌或原数据。
- 批准响应未知：只读查原 UUID。`APPROVED` 代表批准已记录、尚未激活；需要用户明确点击“继续激活原批准的两批”，读取本身不会启动计算。
- 激活响应未知：按原批准查已消费的发布和两批，不再次激活。无论服务端响应是否被浏览器解析，既有激活幂等约束都保持。
- 另一个新 UUID 不得借用此版本已有的批准：明确拒绝并要求返回原发布请求，避免多标签页隐式继承或重复批准。
- `NOT_FOUND` 不采用其他请求的批准。确认原请求尚无批准后，用户重新逐项确认才使用原 UUID 重试。
- `EXPIRED` 不自动重批或激活。用户可以明确开始一个新请求并重新确认。原批准保留。
- 演练或文件审阅变化：拒绝原发布。批准 API 的可选 `expectedSyncRehearsalDigest` 在服务端再次核对，防止只读预检与提交之间的变化。
- 重开原 URL 自动只读恢复文件审阅和原发布。不会恢复为已勾选的新发布同意，也不会自行重跑失败或未知批次。

## 监控证据

只读回执按原批准定位发布，不扫描或回退到另一个包。共同核对原代码、快照、批准消费、激活时间窗口、两批计划与序号：

| 状态 | 必要含义 |
| --- | --- |
| SCHEDULED | 已计划，但尚未证明触发 |
| RUNNING | 本机计时器已触发，开始时间与模式一致 |
| SUCCEEDED | 主 SQL、测试 SQL、独立结果和五回归通过，且确切监控事件一致 |
| FAILED | 失败批次、对应失败事件及告警可核对；不以其他成功批次覆盖 |
| INTERRUPTED | 原结果未知事件与未关闭告警对应，只读查询不重试；停止后仍保留原结果未知 |
| CANCELLED | 原发布已停止，历史批次保留 |

两个批次全成功时继续复用现有数据服务来源认证，核对健康、批次计数和监控证据。坏事件、缺失结果、重复或错位的两批、原批准失配均明确未确认，撤下旧正向监控。回执只返回状态、计数和必要编号，不返回结果行、原始日志或运行目录。

## 统一 API、CLI、MCP

批准及激活复用现有 `POST /delivery/packages/:id/approve` 和 `POST /releases`。新增只读入口：

```text
GET /api/v2/agent/tasks/:taskId/sync-publication/requests/:requestId
 ?deliveryId=:uuid&packageId=:uuid&packageDigest=:sha256
 &verificationId=:uuid&reviewId=:uuid&syncRehearsalDigest=:sha256
```

六个唯一查询参数必填；未知、重复及跨原作者的参数拒绝。回执协议 `shuduo-native-sync-publication/v1`，阶段为 `NOT_FOUND / APPROVED / EXPIRED / RELEASED`。回执摘要仅证明内容完整性，不冒充不可篡改生产审计。

请求 JSON 包含八个字段：`taskId, deliveryId, packageId, packageDigest, verificationId, reviewId, syncRehearsalDigest, requestId`。从原审阅预检取得前七项，工程师明确开始本次发布时创建最后的 UUID。新包、演练或本人审阅变化不能借用旧请求。

```sh
node bin/shuduo.mjs agent sync-release-read --request-file request.json
node bin/shuduo.mjs agent sync-release --request-file request.json --confirm
node bin/shuduo.mjs agent sync-release --request-file request.json --confirm --activate-only
```

MCP `agent_sync_release_read` 只读；`agent_sync_release` 必须 `confirm:true`，可明确 `activateOnly:true`。GUI、CLI、MCP复用同一受控阶段函数和严格回执校验，不由客户端绕开后端的独立文件审阅、两批同意、十五分钟批准和激活校验。

## 本轮验收口径

协议测试和浏览器使用明确合成执行回执，实际驱动既有本机调度状态机；覆盖批准/激活响应丢失、原请求冷恢复、等待/运行/终态、失败、停止、未知、证据变化、跨作者及多端契约。没有代批或运行新的真实包，也没有新增真实 Spark、模型、云变更或正式 E2E 计数。

真实两批仍须工程师批准确切包后执行，逐批核对实际结果与监控；公网和真实模型完整链路继续单独验收。
