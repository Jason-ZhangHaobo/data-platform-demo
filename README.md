# 数栈 · 数据中台与 Data Agent

使用虚构中国证券数据，验证“完整经典中台 + 深度融合 Data Agent”的实际工作流。

## V2 当前交付

新版需求基线已经生效；旧版保留对照，不覆盖进行中的用户改动，也未替换旧公网部署。

- React / TypeScript / Monaco 代码工作台：分组导航、SQL 编辑/差异、版本、上下文、后台结果与日志。
- 本地真实 Spark 3.5.7：证券资产计算、金额精度、现金独立聚合、持仓去重；23 项独立引擎用例通过。
- 独立本地平台元数据库保存不可变版本和运行记录，支持幂等提交、取消、重启中断标记。
- 真实模型接口及最多三轮修正已编码；没有配置 API Key，尚未进行真实模型端到端验收。
- 数据源、同步、调度、资产、质量、安全脱敏、DAPI/XAPI、报表、运维均有明确模块位置。规划入口不算功能已实现。

```bash
npm ci
npm run v2:bootstrap
npm run v2:build
npm run v2:dev
```

打开 [本机新版工作台](http://127.0.0.1:3100/v2/)。这是本机地址，不是朋友可访问的公网地址。
本地验证使用 Node.js 24；首次需要安装 Python/Spark/Java，详见 [V2 启动与模型配置](docs/v2-quickstart.md)。

需求：[PRD](docs/PRD.md) · [决策](docs/decisions.md) · [路线图](docs/product-roadmap.md) · [验收证据](docs/acceptance.md) · [V2 API](docs/v2-api.md) · [成本核验](docs/v2-budget.md)。

## 默认业务上下文

后续新增的用例、业务场景、PRD、代码示例、测试数据、验收用例和培训材料，默认围绕中国证券行业展开，包括券商经纪、财富管理、资产管理、基金、托管清算、行情参考、风险合规和审计等场景。全部机构、账户、证券代码和业务数据均为虚构；不执行真实交易、资金操作或监管报送。完整约束见[中国证券行业业务上下文](docs/business-context.md)。

## 旧版 V1 对照能力（不作为 V2 验收证据）

- 离线同步任务的创建、编辑、启用和停用。
- 手动触发或停止模拟同步。
- 运行状态、读写行数与日志记录。
- 数据开发 SQL 任务草稿、风险提示与模拟运行记录。
- 面向证券行业的脱敏规则管理、虚构样例预览和规则启停。
- 证券数据资产目录的搜索、字段元数据、敏感等级和血缘摘要。
- 数据资产契约：版本、兼容策略、关键字段、质量 SLO、下游消费者和变更边界。
- 账号、角色、最小权限访问检查和允许/拒绝审计记录。
- Data Agent Lite 的意图识别、计划预览、确认执行和跨模块审计。
- 财富顾问持仓分析的空值、唯一性、行数和 T+1 时效质量规则模拟。
- 财富顾问指标语义上下文、口径、字段来源和示例问答。
- Data Agent 评测集、回归得分和失败用例历史。
- Kafka/Flink 实时同步任务的状态、Checkpoint、吞吐和延迟模拟。
- 浏览器原生前端、Node.js 原生后端和可替换存储接口。
- 自动源码检查、API 测试和生产构建。
- 单容器交付，方便部署到阿里云函数计算。

> 本项目禁止接入公司代码、真实业务数据、内部地址和生产账号。

## 旧版本地启动

```bash
npm run dev
```

打开 [旧版本机 Demo](http://localhost:3000)。当前仓库已经引入 V2 依赖，需要先执行 `npm ci`。

## 质量检查

```bash
npm run ci
```

## 旧版 CLI 入口

CLI 与 GUI、Data Agent 共享同一套 API、权限和审计。

```bash
node bin/dataplatform.mjs help
node bin/dataplatform.mjs assets search --query 持仓
node bin/dataplatform.mjs agent plan --message "财富顾问查询客户持仓，生成客户总资产和行业分布报表"
node bin/dataplatform.mjs dev list
node bin/dataplatform.mjs ops list
```

## 旧版 MCP 入口

Data Agent 客户端可以通过 stdio 启动 MCP Server，发现并调用同一套 API 能力：

```bash
DATA_PLATFORM_API_BASE_URL=https://dataplaging-api-qagxeaqdmd.cn-hangzhou.fcapp.run node bin/dataplatform-mcp.mjs
```

MCP 暴露数据资产检索、权限检查、Data Agent 计划/确认、SQL 任务查询/校验/发布，以及运维告警查询/确认。确认工具必须在用户看到计划、SQL 或告警影响后明确确认才可调用。MCP 不提供自动结案工具，告警恢复仍需人类完成核验。

## Staging 访问保护

旧版支持 `REQUIRE_ACCESS_TOKEN` 演示访问保护；当前线上取值未在本轮核验。V2 不复用此开关作为用户登录认证，公网写入在邀请身份、隔离执行与预算门槛通过后开放。任何凭证不得写入仓库。

## 真实 CSV → MySQL

真实同步默认关闭，只有设置 `REAL_SYNC_ENABLED=true` 才会执行。运行时需要配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD` 和 `MYSQL_DATABASE`；密码只能放在阿里云 FC 环境变量或 GitHub Secret 中。CSV 源文件放在 `src/shared`，目标任务必须指向配置的业务数据库。

## 生产构建

```bash
npm run build
npm start
```

旧版默认端口为 `3000`，容器端口为 `9000`。V2 前端额外使用 TypeScript 与 Vite；旧部署产物尚未接入 V2 Spark 执行单元。

## 文档

- [产品需求文档](docs/PRD.md)
- [技术架构](docs/architecture.md)
- [阿里云部署方案](docs/aliyun-deployment.md)
- [费用控制与清理手册](docs/cost-controls.md)
- [数据中台＋Data Agent 产品蓝图](docs/product-roadmap.md)
- [中国证券行业业务上下文](docs/business-context.md)
- [第二个总体目标：世界级数据中台差距与演进路线](docs/second-goal-gap-and-roadmap.md)

## 路线图

统一按 [V2 M0–M5 路线图](docs/product-roadmap.md) 推进。旧分期描述被取代。
全流程 PPT 在约定范围完成或用户明确要求时生成，本轮未生成最终 PPT。
