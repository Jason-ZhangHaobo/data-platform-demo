# 数栈 · 数据中台与 Data Agent

一个使用虚构数据构建的数据中台与 Data Agent 全栈 Demo。第一版从离线同步任务管理开始，长期目标是让跨模块智能体服务数据集成、开发、脱敏、安全、资产、运维和分析全链路。

## 默认业务上下文

后续新增的用例、业务场景、PRD、代码示例、测试数据、验收用例和培训材料，默认围绕中国证券行业展开，包括券商经纪、财富管理、资产管理、基金、托管清算、行情参考、风险合规和审计等场景。全部机构、账户、证券代码和业务数据均为虚构；不执行真实交易、资金操作或监管报送。完整约束见[中国证券行业业务上下文](docs/business-context.md)。

## 当前能力

- 离线同步任务的创建、编辑、启用和停用。
- 手动触发或停止模拟同步。
- 运行状态、读写行数与日志记录。
- 数据开发 SQL 任务草稿、风险提示与模拟运行记录。
- 面向证券行业的脱敏规则管理、虚构样例预览和规则启停。
- 证券数据资产目录的搜索、字段元数据、敏感等级和血缘摘要。
- 账号、角色、最小权限访问检查和允许/拒绝审计记录。
- Data Agent Lite 的意图识别、计划预览、确认执行和跨模块审计。
- 财富顾问持仓分析的空值、唯一性、行数和 T+1 时效质量规则模拟。
- 财富顾问指标语义上下文、口径、字段来源和示例问答。
- 浏览器原生前端、Node.js 原生后端和可替换存储接口。
- 自动源码检查、API 测试和生产构建。
- 单容器交付，方便部署到阿里云函数计算。

> 本项目禁止接入公司代码、真实业务数据、内部地址和生产账号。

## 本地启动

```bash
npm run dev
```

打开 `http://localhost:3000`。第一版没有第三方依赖，不需要执行 `npm install`。

## 质量检查

```bash
npm run ci
```

## CLI 入口

CLI 与 GUI、Data Agent 共享同一套 API、权限和审计。

```bash
node bin/dataplatform.mjs help
node bin/dataplatform.mjs assets search --query 持仓
node bin/dataplatform.mjs agent plan --message "财富顾问查询客户持仓，生成客户总资产和行业分布报表"
```

## MCP 入口

Data Agent 客户端可以通过 stdio 启动 MCP Server，发现并调用同一套 API 能力：

```bash
DATA_PLATFORM_API_BASE_URL=https://dataplaging-api-qagxeaqdmd.cn-hangzhou.fcapp.run node bin/dataplatform-mcp.mjs
```

MCP 暴露 `data_agent_plan`、`data_agent_confirm`、`assets_search` 和 `security_access_check`。确认工具必须在用户看到计划并明确确认后调用。

## Staging 访问保护

当前 staging 为公开验收 Demo，`REQUIRE_ACCESS_TOKEN=false`，方便朋友直接体验。需要恢复访问保护时，将 FC 环境变量切换为 `REQUIRE_ACCESS_TOKEN=true`，并保留 `DEMO_ACCESS_TOKEN` 在 GitHub Secret 和阿里云 FC 环境变量中，不要写入仓库。

## 真实 CSV → MySQL

真实同步默认关闭，只有设置 `REAL_SYNC_ENABLED=true` 才会执行。运行时需要配置 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD` 和 `MYSQL_DATABASE`；密码只能放在阿里云 FC 环境变量或 GitHub Secret 中。CSV 源文件放在 `src/shared`，目标任务必须指向配置的业务数据库。

## 生产构建

```bash
npm run build
npm start
```

默认服务端口是 `3000`。容器运行时使用 `9000`，与阿里云函数计算自定义容器保持一致。测试、构建和源码检查均使用 Node.js 内置能力，以减少供应链依赖。

## 文档

- [产品需求文档](docs/PRD.md)
- [技术架构](docs/architecture.md)
- [阿里云部署方案](docs/aliyun-deployment.md)
- [费用控制与清理手册](docs/cost-controls.md)
- [数据中台＋Data Agent 产品蓝图](docs/product-roadmap.md)
- [中国证券行业业务上下文](docs/business-context.md)
- [第二个总体目标：世界级数据中台差距与演进路线](docs/second-goal-gap-and-roadmap.md)

## 路线图

1. 发布 MVP 到阿里云杭州的测试和模拟生产环境。
2. 第二次需求迭代增加 CSV 到 MySQL 的真实同步。
3. 增加数据开发、数据脱敏和数据资产目录模块。
4. 增加 Data Agent Lite，用自然语言路由同步、开发、脱敏和资产检索模块。
5. 将各业务模块注册为 Agent Skills，并加入 ChatBI、知识库和主动运维。
6. 在全流程完成后制作数据中台端到端讲解 PPT，沉淀复刻路线和团队培训材料。
