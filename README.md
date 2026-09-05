# 数栈 · 数据中台与 Data Agent

一个使用虚构数据构建的数据中台与 Data Agent 全栈 Demo。第一版从离线同步任务管理开始，长期目标是让跨模块智能体服务数据集成、开发、脱敏、安全、资产、运维和分析全链路。

## 当前能力

- 离线同步任务的创建、编辑、启用和停用。
- 手动触发或停止模拟同步。
- 运行状态、读写行数与日志记录。
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

## Staging 访问保护

staging 的 `health` 接口保持公开，任务和汇总 API 需要 Bearer 访问码。访问码只保存在 GitHub Actions Secret `DEMO_ACCESS_TOKEN` 和阿里云 FC 环境变量中，不要写入仓库。每次部署时，工作流会保留现有 FC 环境变量并同步访问码，同时开启 `REQUIRE_ACCESS_TOKEN=true`。

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

## 路线图

1. 发布 MVP 到阿里云杭州的测试和模拟生产环境。
2. 第二次需求迭代增加 CSV 到 MySQL 的真实同步。
3. 增加数据开发、数据脱敏和数据资产目录模块。
4. 增加 Data Agent Lite，用自然语言创建离线同步任务草稿。
5. 将各业务模块注册为 Agent Skills，并加入 ChatBI、知识库和主动运维。
