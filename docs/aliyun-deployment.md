# 阿里云部署方案

## 目标架构

```text
GitHub Pull Request
  └─ GitHub Actions：源码检查、测试、构建

main 分支
  └─ 阿里云 Serverless 应用中心
      ├─ staging：自动部署
      │   ├─ Function Compute Web 函数
      │   └─ OSS 测试 Bucket
      └─ production：人工审批后部署
          ├─ Function Compute Web 函数
          └─ OSS 模拟生产 Bucket
```

## 为什么使用代码包而不是容器镜像

项目没有第三方运行时依赖。Function Compute 的 Debian 12 自定义运行时自带 Node.js 20，因此可以直接上传代码包，避免创建和付费维护容器镜像仓库。

## 部署变量

以下变量只能配置在阿里云应用中心的环境或流水线中，不能提交真实值：

| 变量 | staging | production |
|---|---|---|
| `DEPLOY_ENV` | `staging` | `production` |
| `OSS_BUCKET` | 测试 Bucket 名称 | 模拟生产 Bucket 名称 |
| `FC_ROLE_ARN` | 最小权限函数角色 ARN | 最小权限函数角色 ARN |
| `DEMO_ACCESS_TOKEN` | 随机测试访问码 | 独立的随机生产访问码 |

## 安全边界

- HTTP 触发器需要匿名模式才能在浏览器打开，但所有 API 都由 `DEMO_ACCESS_TOKEN` 保护。
- 访问码只保存在阿里云环境变量和浏览器会话中，不进入 GitHub。
- FC 通过函数角色获取临时凭证访问 OSS，不使用永久 AccessKey。
- staging 与 production 使用不同 Bucket 和访问码。
- 不启用预留实例，最小实例数保持为 0。

## 发布步骤

1. PR 通过 GitHub Actions 后合入 `main`。
2. 应用中心自动部署 staging。
3. 浏览器验证健康检查、任务创建和模拟运行。
4. production 流水线停在人工审批节点。
5. 产品负责人确认版本和费用后批准。
6. 部署 production 并执行冒烟测试。
