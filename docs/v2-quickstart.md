# 新版工作台启动与验收

当前交付是本机 M0/M1 基础，不替换旧公网版本。不能把 localhost 地址发给朋友当公网产品。
所有输入均为本项目虚构证券数据；不用公司文件或真实客户数据进行测试。

## 1. 启动

验证环境：macOS arm64、Node.js 24.19.0、Python 3.12、Java 17、Spark 3.5.7。
在本工作目录执行：

```bash
npm ci
npm run v2:bootstrap
npm run v2:build
npm run v2:dev
```

打开 [本机工作台](http://127.0.0.1:3100/v2/)。
首次安装会下载约 177 MiB Java 和约 303 MiB PySpark；Java 支持断点续传并校验 SHA-256。
macOS arm64 的 JDK 仅放在项目 `.runtime/`，不修改系统 Java。Linux 请提供 Java 17 的 JAVA_HOME。
如默认 Python 不合适，在 bootstrap 前设置 V2_BOOTSTRAP_PYTHON 指向 Python 3.12。

## 2. 无模型也能验证的真实链路

1. 数据开发 → 确认三张合成表和口径 → 查看/编辑参考 SQL。
2. 点击保存建立代码版本；点击运行 SQL，立即得到后台运行状态。
3. 标准数据中 CLIENT-001 总资产为 1,800.00：持仓 1,500.00 + 现金 300.00。
4. 输入版本切换为“客户资产 · 现金变更”，重新运行，客户总资产变为 2,300.00。
5. 切换为“重复持仓”，验证重复输入不会重复累计金额。
   同一 SQL 还会自动核验“同额不同持仓”“仅有现金客户”，不能只满足当前下拉框中的一套数据。
6. 查看验证、日志、运行记录；刷新页面查看已保存版本及后台结果。
7. 导出验证包，核对代码哈希和运行结果。此步骤不是发布上线。

## 3. 配置真实 Data Agent

通过 [阿里云百炼 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) 获取北京地域的模型服务密钥；入口和地域对应关系见 [官方说明](https://help.aliyun.com/zh/model-studio/get-api-key)。
使用专用于本项目的最小模型访问权限，避免复用公司凭证。

推荐：直接进入 [本机模型设置](http://127.0.0.1:3100/v2/?module=settings) → “连接真实模型服务”。
在密码输入框粘贴 API Key，点击“保存到本机”，无需改文件或重启。
该入口仅在回环开发模式开放：写入权限 0600 的本项目 `.env.local`，不回显密钥、不记录到任务中、不自动调用模型。
新版模型卡片变为“已保存，连接未验证”才表示保存生效（未刷新的旧页面显示“已配置，待实测”）。保存不自动调用收费模型，也不代表连接成功。
若出现“未保存”，按具体提示区分空输入、脱敏展示值、云账号 AccessKey、整段配置或中间空白。首尾空白与一对普通引号会自动处理；较长、带分隔符的密钥不再按旧短 Key 规则拒绝。
密钥与服务端点需配套，不能仅从字符串外观判断其是否可调用当前模型；参见 [阿里云官方配置说明](https://www.alibabacloud.com/help/zh/model-studio/get-api-key)。

也可手工将 `.env.v2.example` 复制为 `.env.local`，仅在本机编辑：

```dotenv
DASHSCOPE_API_KEY=
V2_MODEL=qwen3-coder-plus
```

手工改文件后需重启 `npm run v2:dev`。不要把密钥发送到聊天、硬编码到前端源码或提交 Git。
没有凭证时“委托 Agent”明确不可用，不会启用关键词/固定 SQL 的假模型。
配置完成也不代表已验收：仍需真实调用、SQL 执行、结果断言和成功率评测。
当前服务完成过真实 SQL 生成响应后，模型卡片显示“连接已验证”；更换密钥或重启服务后重新核验。此状态不等于业务结果正确或完整 E2E 成功。
已有真实代码生成/报错/自动修正示例，见 [M1 试跑报告](m1-live-agent-report.md)。在开发页审阅最近产物，再查看“验证”与“运行记录”。

## 4. 复跑检查

```bash
npm run ci
npm run v2:spark-test
npm run v2:runtime-test
npm audit
```

如需有意识地再次产生模型调用并复跑冻结的M1代码阶段评测，可执行：

```bash
npm run v2:m1-eval
```

该命令顺序运行20个真实模型+Spark场景，并把报告写入忽略提交的`.v2-artifacts/evaluations/`；会产生按量模型费用，普通CI不会自动运行。它只报告代码阶段，不能替代完整E2E。

完整本机生命周期可执行`npm run v2:e2e:smoke`先跑1例，再执行`npm run v2:e2e`跑满20例。当前正式报告20/20，但每例包含3次Spark执行，复跑约需数分钟；不会再次调用模型，因为精确复用已冻结的真实M1产物。

邀请认证回环预览使用`V2_PREVIEW_ADMIN_PASSWORD`启动`scripts/run-public-auth-preview.mjs`。该模式只用于UI/CSRF/角色测试，临时数据库随进程结束失效，绝不能作为公网地址分享。

进入[本机调度与发布](http://127.0.0.1:3100/v2/?module=schedules)可查看M2a文件演练、M2b摘要审批/计时发布以及M2c批次与恢复监控。页面中的“发布”仅为本机测试版本激活，接口保留`publicDeployed=false`。

进入[本机数据服务](http://127.0.0.1:3100/v2/?module=services)可从成功发布批次创建DAPI、执行查询测试、发布版本、组合XAPI并查看调用日志。创建应用令牌会仅显示一次，平台列表不返回令牌或哈希。

V2 CLI与MCP均使用同一个`/api/v2`：

```bash
npm run v2:cli -- services list --type dapi
npm run v2:cli -- services openapi --type xapi --id <SERVICE_ID>
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"xapi_list","arguments":{}}}' | npm run v2:mcp --silent
```

外部调用令牌只通过`SHUZHAN_APP_TOKEN`环境变量提供给CLI/MCP，不放进命令参数或MCP工具参数。旧`dataplatform`命令仍是V1模拟接口。

进入[本机数据源](http://127.0.0.1:3100/v2/?module=sources)查看真实CSV连接、元数据和结构变化；进入[本机离线同步](http://127.0.0.1:3100/v2/?module=sync)查看字段映射、运行证据与落地结果。

```bash
npm run v2:cli -- sources list
npm run v2:cli -- sync list
npm run v2:cli -- sync rows --table raw_positions
```

MCP对应提供`source_*`、`sync_*`与`ingestion_plan_*`工具；它们与GUI/CLI使用同一`/api/v2`，当前只允许仓库内虚构CSV。

CI 的模型/执行器边界测试使用明确标注的 TEST_DOUBLE，不计入真实 Agent E2E 成功率。
Spark 检查才运行真正引擎，生成 `.v2-artifacts/spark-acceptance.json`。
后台版本/状态保存在独立 `.data/v2-platform.sqlite`，引擎输入输出在 `.v2-artifacts/`，均不提交 Git。

## 5. 公网上线的下一道门槛

先完成账号内 FC/OSS/RDS 账单和试用到期成本核对、模型实测、隔离执行、邀请登录、独立云元数据库、域名/备案。
当前部署脚本仍是旧版入口，不能把它当作已经支持 V2 Spark 的云部署。
操作恢复、版本与 UI 检查结果见 [验收记录](acceptance.md)。
