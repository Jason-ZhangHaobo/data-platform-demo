# 账号受限的云端工作台预览

状态：2026-10-09，Safari 已真实显示私有工作台、可编辑 SQL、3 个版本和既有 Spark 任务 2300.00/950.00；验证页显示 5 条业务场景通过，刷新后批次与结果一致。已打开正常数舵登录弹窗，等待用户提供应用会话后验收新任务提交。阿里云登录恢复不等于数舵应用登录。详见 [验收记录](evidence/v2-cloudshell-preview-20261009.json)。不计入完整 Agent E2E，也不是生产公网部署。

## 目的与边界

复用已部署控制面和 Spark Worker，在备案与正式公网门槛未完成时验证浏览器操作。使用阿里云 Cloud Shell 自带身份调用已有 FC 私有入口，不导出云凭证、不添加 IAM 权限、不创建公网 FC 触发器。用户仍以数舵账号登录，后端继续校验项目权限、会话和 CSRF。

依据：[阿里云 Web Preview 文档](https://help.aliyun.com/en/cloud-shell/user-guide/preview-web-applications)说明预览代理提供 HTTPS 且限制当前账号访问；该功能面向主账号。Cloud Shell 为临时环境，不提供持久上线保障。

仅接入已部署的 `PRIVATE_APPLICATION_HTTP_V1` 协议：状态、测试上下文、会话、代码版本、运行列表/详情、登录/退出、保存、提交、取消。Agent、Python、调度、服务等模块保留目录并标记本预览未接入。结果下载明确为运行结果快照，不冒充部署交付包。

## 构建与启动

1. PR 的 CI 完成后取得 `shuduo-private-preview-*` 构建产物。包仅包含 `web-dist/` 与 `scripts/run-v2-cloudshell-preview.mjs`，没有环境变量、数据库文件、认证材料或公司数据。
2. 使用有界 CLI 下载把该包传至 Cloud Shell，核对 SHA-256 后解压到新建临时目录。不复用曾长时间挂起的网页上传控件。
3. 从 Cloud Shell 工具栏选择 Web Preview 的 60000 端口，确认实际生成的 HTTPS 地址；不要推测主机名。使用地址的 origin（不带路径/查询）启动：

```sh
node scripts/run-v2-cloudshell-preview.mjs --origin https://VERIFIED-PREVIEW-HOST --port 60000
```

4. 打开该地址的 `/v2/?module=development`。只读页面应显示云端真实历史。已有账号登录后创建一次新任务，保留运行 ID，确认 Spark 版本、结果、断言，再刷新验证记录一致。
5. 测试完成按 Ctrl-C 停止预览；无需删除或重建云资源。预览会在 45 分钟后停止接收新连接，每次最多转发 200 次请求。Cloud Shell 自身到期也会失效；云端任务状态不依赖该临时页面。

## 安全与体验验证

- origin/Host 精确校验、跨站 API 拒绝、写入 JSON + Origin 检查，应用自身 CSRF 校验不削弱。实际网关将 Host 改为 `127.0.0.1:60000`，保留 `X-Forwarded-Proto: https`。只对匹配端口的官方 `PORT-dot-ID.shell.aliyuncs.com` HTTPS origin 启用该精确适配，不接受任意代理 Host。
- 网关从 VM 网络接口连接服务，所以进程监听 `0.0.0.0`，但所有请求仍经过 Host/Origin 限制及 Cloud Shell 的账号受限网关。不能因 Host 写作回环地址就把监听收窄到回环接口；该误配已通过“本机 HTML 200、浏览器网关连接失败”定位并修复。静态 HTML 允许从官方入口正常跳转，跨站 API 仍拒绝。
- 仅固定函数、地域、操作及路径；不得接收任意函数名、Shell 命令、IAM 或数据库管理操作。
- 只转发数舵会话 Cookie，不把阿里云账号 Cookie 发送给应用。
- CLI 通过 `--body-file /dev/stdin` 接收正文，密码与会话不进入 argv、Shell 历史或临时文件。Linux 下 Node 子进程 stdin 为 socket，不能直接重新打开 `/dev/stdin`；由 Python 3 标准库转换为匿名管道，再交给 CLI。真实管道测试纳入 Linux CI。超时终止本次调用独立进程组。CLI 标准错误不回传页面，不记录请求正文。
- 静态文件仅限编译目录，禁止目录遍历、目录列表和逃逸软链接；API 不开启 CORS。
- 云调用串行，等待队列最多 8，浏览器轮询不重叠。超时提示查看历史，不自动重发写入。
- 安全测试：`node --test test/v2/cloudshell-preview.test.mjs`；完整门槛：`npm run ci`。

## 已知限制

Cloud Shell 前置账号访问限制依据厂商文档，本项目没有声称完成跨阿里云账号隔离实测。Safari 重定向、前端渲染、编辑器载入、只读运行结果和刷新恢复已观察通过；实际登录 Cookie、授权新任务及跨用户隔离仍待验收。不能将只读页面通过写成完整 P1 GUI 通过。首次加载受云端冷启动影响，不能用本地构建体积替代公网三秒性能验收。
