# V2 API 契约与实现边界

更新：2026-09-13。基础地址为本地开发服务的 `/api/v2`。以下接口已实现；旧 CLI/MCP 仍使用旧版 API，不能用其测试证明 V2 多端一致。

## 权限与请求

当前仅支持回环地址上的单项目开发会话，不是受邀用户登录系统。
写请求要求 JSON 对象和 `X-Shuzhan-Client: workbench`；这一标记只用于本地请求来源防护，不能作为公网身份。
公开只读模式拒绝全部写入。跨项目请求返回 403；未知记录返回 404；无效参数返回 400。
SQL 上限 20,000 字符，请求体上限 100 KB。任务/运行请求必须携带 `Idempotency-Key`。

| 方法与路径 | 输入 / 行为 | 输出 |
|---|---|---|
| GET /status | 配置状态，永不返回密钥 | 模块范围、Spark/模型/元数据状态 |
| POST /settings/model-key | 仅本地开发模式；apiKey | 保存到权限 0600 的 .env.local，只返回 configured；不自动调用模型 |
| GET /contexts | 三组虚构证券输入 | 表结构、口径、参考 SQL；不含独立预期结果 |
| POST /revisions | sql、contextId | 201；不可变版本、SHA-256 |
| GET /revisions | 当前项目版本列表 | 版本、代码、来源和时间 |
| GET /revisions/:id | 指定版本 | 版本详情 |
| POST /runs | revisionId + 幂等键 | 202；后台运行编号 |
| GET /runs | 当前项目历史 | 状态、版本、真实结果、引擎和验证 |
| GET /runs/:id | 查询状态 | 同上 |
| POST /runs/:id/cancel | 取消当前/排队运行 | 明确 CANCELLED；不会随后变为成功 |
| GET /runs/:id/bundle | 仅允许已通过验证的运行 | SQL、结果、断言、引擎和版本；NOT_PUBLISHED |
| POST /agent/tasks | message、sql、contextId + 幂等键 | 202；真实模型任务编号；缺配置返回 503 |
| GET /agent/tasks | 历史委托 | 状态、尝试次数、用量和产物 |
| GET /agent/tasks/:id | 指定委托 | 同上 |
| POST /agent/tasks/:id/cancel | 取消委托及其执行 | CANCELLED |

任务状态：QUEUED、RUNNING、SUCCEEDED、VALIDATION_FAILED、FAILED、CANCELLED、INTERRUPTED。
服务重启会把未完成任务标为 INTERRUPTED，保留记录，等待人工重跑；自动续接尚未实现。
重复键同输入返回原记录，不重复执行；同键不同输入返回 409。

## 真实执行边界

Spark 3.5.7 只允许已登记的 accounts/positions/cash 合成数据视图、单条 SELECT/WITH 和函数白名单。
后端先按上下文裁剪客户范围，再执行 SQL，不依赖 Agent 自觉写权限条件。
执行串行、默认 90 秒超时、返回最多 1,000 行。本地进程不是生产沙箱。
只有真实执行成功且独立业务断言通过，运行才是 SUCCEEDED。
独立预期结果来自测试契约，不传给模型；新指标/新口径必须先补充对应契约和断言。

模型适配器使用 HTTPS、禁止重定向、60 秒请求超时、每次委托最多三轮。
总 Token 默认预算 32,000，输出默认上限 6,000；请求前保守估算并缩减输出，缺失/异常用量按剩余额度消耗，不继续调用。
这些是单任务防护，不是已验收的月度云账单硬封顶。
模型密钥入口拒绝换行注入和配置文件符号链接；只记录“已设置”审计事件，不保存密钥到平台元数据。

## 尚未开放

真实用户认证、跨用户授权、云端元数据库/OSS、自动恢复、多实例队列、审批及发布绑定在后续门槛内。
DAPI/XAPI 的发布和外部消费、版本回滚、交易日调度、V2 CLI/MCP 尚未实现。
验证包不能被称为部署包或已发布任务。
