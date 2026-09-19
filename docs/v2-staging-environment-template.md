# V2 staging 受保护环境清单

配置入口：[GitHub Environments](https://github.com/Jason-ZhangHaobo/data-platform-demo/settings/environments)。创建环境 `v2-staging` 后，按以下分类填写。这里只列名称，不填写或提交任何真实值。

## Variables

| 名称 | 作用 |
|---|---|
| `V2_FUNCTION_NAME` | 独立 V2 函数名，例如 `dataplatform-v2-staging-api` |
| `V2_FUNCTION_ROLE_ARN` | FC 运行时角色，必须与部署角色不同 |
| `V2_DEPLOY_ROLE_ARN` | GitHub OIDC 部署角色 |
| `V2_DEPLOY_OIDC_PROVIDER_ARN` | GitHub OIDC Provider |
| `V2_VPC_ID` | RDS 所在 VPC |
| `V2_VSW_ID` | 同 VPC 交换机 |
| `V2_SECURITY_GROUP_ID` | 同 VPC 安全组 |
| `V2_OSS_BUCKET` | 杭州私有 OSS Bucket |
| `V2_PUBLIC_URL` | 已备案且 HTTPS 的公网地址；仅公网部署工作流必需，函数预置阶段可留空 |
| `V2_PUBLIC_ORIGIN` | 与 `V2_PUBLIC_URL` 去掉末尾 `/` 后完全一致；仅公网部署工作流必需 |
| `V2_AUDIT_EVIDENCE_FILE` | `docs/evidence/` 下当月脱敏审计文件路径 |
| `V2_SPARK_EXECUTOR_URL` | 已完成真实隔离 Worker 验收后再填写；首期留空 |
| `V2_MYSQL_SOURCE_TABLE_ALLOWLIST` | 虚构业务库允许读取的表名逗号列表；真实同VPC验收前留空 |
| `V2_MYSQL_SOURCE_SYNC_ENABLED` | 仅真实业务源权限/限额验收后设为`true`；默认留空或`false` |

## Secrets

可以逐项填写以下 Secrets，也可以只填写一个 `JASONSECRETS`，内容使用 JSON 对象或单行 `KEY=VALUE` 文本；工作流只读取白名单键并在 Runner 临时展开。若同一键同时存在，逐项 Secret 优先。无论哪种形式，秘密都不会写入仓库或日志。

| 名称 | 作用 |
|---|---|
| `V2_MYSQL_HOST` / `V2_MYSQL_PORT` | 独立平台元数据库连接 |
| `V2_MYSQL_USER` / `V2_MYSQL_PASSWORD` | `platform_app` 账号凭证 |
| `V2_MYSQL_DATABASE` | `platform_meta` |
| `V2_MYSQL_SOURCE_HOST` / `V2_MYSQL_SOURCE_PORT` | 独立虚构业务数据库连接，不复用平台元数据库用途 |
| `V2_MYSQL_SOURCE_USER` / `V2_MYSQL_SOURCE_PASSWORD` | 仅白名单表SELECT的业务源只读账号 |
| `V2_MYSQL_SOURCE_DATABASE` | 虚构业务数据库，例如`business_demo`；不得填写公司数据库 |
| `V2_BOOTSTRAP_ADMIN_EMAIL` | 首个管理员邮箱 |
| `V2_BOOTSTRAP_ADMIN_PASSWORD_HASH` | 本机生成的 scrypt 哈希，不是明文密码 |
| `V2_BOOTSTRAP_ADMIN_NAME` | 管理员显示名 |
| `DASHSCOPE_API_KEY` | 百炼模型 Key |
| `V2_SPARK_EXECUTOR_SECRET` | 隔离 Worker 完成真实验收后再填写；首期留空 |
| `JASONSECRETS` | 上述 Secrets 的受控 JSON/KEY=VALUE 包；可替代逐项 Secrets |

工作流会先运行 `scripts/verify-v2-staging-config.mjs`，只返回缺失名称或固定错误码；角色、VPC、账单、函数是否存在等检查随后执行。任何一项失败都不会创建或更新 FC 函数。
