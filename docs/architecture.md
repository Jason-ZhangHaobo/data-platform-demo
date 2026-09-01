# 技术架构

## 当前结构

```text
浏览器原生 HTML / CSS / JavaScript 前端
        │ HTTP / JSON
        ▼
Node.js 原生 HTTP API
        │
        ▼
TaskStore 接口
        ├─ FileTaskStore（本地开发）
        └─ OssTaskStore（阿里云持久化，使用函数角色临时凭证）
```

`OssTaskStore` 使用 OSS ETag 和 `If-Match` 做乐观并发控制。如果对象在本次保存前已被其他请求修改，后端返回 409，要求用户刷新后重试，不会静默覆盖新数据。整个状态仍保存在单个 JSON 中，因此只适合单人或低并发演示。

第一版没有第三方运行时依赖，前端和后端被打包成一个容器，避免维护多个部署单元。后端同时提供 API 和前端静态文件。第二次迭代可通过独立 PR 升级为 React/Express，从而演练技术栈迁移。

## 模块演进

```text
data-platform-demo
├─ offline-sync      已实现第一版
├─ data-development  后续迭代
├─ data-masking      后续迭代
└─ data-assets       后续迭代
```

共享的账号、权限、审计和发布能力放在平台层，各业务模块保持清晰边界。

## 环境

- `local`：个人电脑开发和测试。
- `staging`：阿里云华东 1（杭州）测试环境，合并到主分支后自动发布。
- `production`：阿里云华东 1（杭州）模拟生产环境，必须人工批准发布。

测试和模拟生产使用不同配置与数据，不复用账号内现有云资源。
