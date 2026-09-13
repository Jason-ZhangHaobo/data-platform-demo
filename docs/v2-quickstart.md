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
6. 查看验证、日志、运行记录；刷新页面查看已保存版本及后台结果。
7. 导出验证包，核对代码哈希和运行结果。此步骤不是发布上线。

## 3. 配置真实 Data Agent

通过 [阿里云百炼 API Key 页面](https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key) 获取北京地域的模型服务密钥；入口和地域对应关系见 [官方说明](https://help.aliyun.com/zh/model-studio/get-api-key)。
使用专用于本项目的最小模型访问权限，避免复用公司凭证。

推荐：直接进入 [本机模型设置](http://127.0.0.1:3100/v2/?module=settings) → “连接真实模型服务”。
在密码输入框粘贴 API Key，点击“保存到本机”，无需改文件或重启。
该入口仅在回环开发模式开放：写入权限 0600 的本项目 `.env.local`，不回显密钥、不记录到任务中、不自动调用模型。

也可手工将 `.env.v2.example` 复制为 `.env.local`，仅在本机编辑：

```dotenv
DASHSCOPE_API_KEY=
V2_MODEL=qwen3-coder-plus
```

手工改文件后需重启 `npm run v2:dev`。不要把密钥发送到聊天、硬编码到前端源码或提交 Git。
没有凭证时“委托 Agent”明确不可用，不会启用关键词/固定 SQL 的假模型。
配置完成也不代表已验收：仍需真实调用、SQL 执行、结果断言和成功率评测。

## 4. 复跑检查

```bash
npm run ci
npm run v2:spark-test
npm run v2:runtime-test
npm audit
```

CI 的模型/执行器边界测试使用明确标注的 TEST_DOUBLE，不计入真实 Agent E2E 成功率。
Spark 检查才运行真正引擎，生成 `.v2-artifacts/spark-acceptance.json`。
后台版本/状态保存在独立 `.data/v2-platform.sqlite`，引擎输入输出在 `.v2-artifacts/`，均不提交 Git。

## 5. 公网上线的下一道门槛

先完成账号内 FC/OSS/RDS 账单和试用到期成本核对、模型实测、隔离执行、邀请登录、独立云元数据库、域名/备案。
当前部署脚本仍是旧版入口，不能把它当作已经支持 V2 Spark 的云部署。
操作恢复、版本与 UI 检查结果见 [验收记录](acceptance.md)。
