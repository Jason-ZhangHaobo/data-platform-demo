# HTTPS 域名接入验收合同

本文件是实施合同，不是云端已部署或公网已上线的证明。当前授权、证书和实际域名配置只读取受保护执行状态。

## 一次接入批次

1. 核验受保护 main 的固定版本、原角色与策略、原函数代码及关闭的业务开关、预算和剩余授权窗口。
2. 复用原验收检查点，仅在明确批准下重建同名签名 HTTP 临时入口一次；保留既有调用计数，不用新批次清零额度。先完成默认入口的隔离验证。
3. 在同一个临时入口仍存在时，核对域名未配置、DNS 无冲突、证书匹配后，只新增批准的根 CNAME 与 HTTPS 绑定。域名仍使用云签名认证，应用公开业务开关保持关闭。
4. 核验实际 TLS 和自定义域名隔离。默认域名与自定义域名分别记录请求计数；不运行模型、Spark 或发布任务，不用网关鉴权失败代替已签名请求到达应用后的隔离证据。
5. 成功仅保留批准的域名配置；失败只回滚本次创建且内容仍匹配的配置。统一清理临时 HTTP 入口、临时加密 Secret 与临时 IAM 条款，并回读确认。

该批次不包含匿名业务开放、受邀用户实际使用验收、自动续期或新增计算任务；完成后不能宣称公网产品已可用。

## 最小权限与密钥处理

- 按 FC 3.0 官方 API 授权表，`GetCustomDomain`、`CreateCustomDomain` 的资源为 `*`；该技术权限可能作用于其他域名，必须明确告知并限制使用范围和有效期。
- `DeleteCustomDomain` 支持具体 `acs:fc:<region>:<account>:custom-domains/<domain>` 资源，回滚删除不授予账号级通配权限。
- 不申请 `UpdateCustomDomain`；遇到已有域名、DNS 冲突或外部配置变化即停止，不自动接管、更新或删除。
- 证书私钥仅由本机受保护目录通过临时加密 Secret 交付到已核验的 FC TLS 配置。不得出现在命令参数、日志、报告、Git 或 Artifact 中；临时 Secret 在结束后删除。本机原私钥保留用于管理证书。
- 证书主体、SAN、有效期和私钥匹配必须校验；签发验收中的受信任链检查以及实际 HTTPS 信任链检查不能由“证书文件存在”代替。

## 可恢复及错误边界

- 操作编号、期望配置摘要、基线不存在证据必须在首个写请求前持久保存；无法写检查点就不创建资源。
- 创建响应未知，按原域名和唯一证书配置名称回读。内容完全匹配才继续，不发第二次创建请求。
- 删除响应未知，只回读。未证实删除时保留失败状态，恢复不盲目再删。
- 恢复成功保留的配置只读核验，不重建、不重新计算验收次数，也不冒充新的验收成功。
- 配置漂移时拒绝清理，并准确报告未完成项。不能为消除清理错误而删除别人的资源。
- `accept-v2-https-binding` 工作流将原临时入口生命周期、证书传输与域名状态机连接起来：默认入口通过后导出加密回执，本机受控协调器核验来源才写DNS；云作业观察精确CNAME后继续。`always`步骤清理原入口、回滚未通过域名并导出密文，协调器最后恢复IAM和删除临时Secret。合成测试通过不等于真实执行成功。

## 代码与测试

- `scripts/v2-domain-binding-plan.mjs`：证书校验、固定范围计划、临时策略、域名配置比对及适配器驱动的创建/回滚状态机。
- `test/v2/domain-binding-plan.test.mjs`：使用本机生成的虚构证书和内存适配器；不读取真实密钥，不创建云资源。
- 既有入口验收继续使用 `scripts/accept-v2-http-boundary.mjs`；不得单独执行后删除入口，再为域名偷偷新增第二个入口。
- `scripts/accept-v2-https-binding.mjs`与`transport-v2-domain-signed.py`：仅固定域名/操作，PEM通过stdin而非命令参数传递，响应投影删除私钥。域名探测核对可信TLS连接的实际叶证书指纹；计划通过不代替真实连接。
- `test/v2/https-binding-workflow.test.mjs`及既有线级HTTP回归覆盖阶段顺序、相同入口延续、精确鉴权拒绝和敏感响应剔除。

## 官方依据

- [CreateCustomDomain](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-createcustomdomain)
- [GetCustomDomain](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-getcustomdomain)
- [DeleteCustomDomain](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-deletecustomdomain)
- [域名配置及 CNAME](https://help.aliyun.com/zh/functioncompute/configure-custom-domain-names)
- [权限认证类型](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-authconfig)
