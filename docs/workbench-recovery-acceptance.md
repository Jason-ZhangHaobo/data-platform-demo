# Agent 工作台恢复增量：验收矩阵

本文件记录可复现的代码验收范围，不记录私有部署标识或凭证。对应当前目标：工程师在独立 Agent 工作台中完成开发、核验、交付、审阅和监控，并可在故障后继续原工作。总目标仍包含真实模型/Spark、完整E2E与公网验收，不能由以下测试替代。

## 已实现并有本机自动测试的范围

| 场景 | 必须观察到的结果 | 主要测试入口 |
|---|---|---|
| 本机就绪与历史读取 | 本机模型/Spark已配置时允许提交，不误用云端持久开关；模型不可用时仍可读取历史。私有云仍要求持久模式 | `test/v2/agent-submission.test.mjs` |
| 创建Agent回执丢失与刷新 | POST前保留仅含UUID的恢复链接；刷新仅查原创建请求，不自动调用模型。仅原页仍保留内容时提供显式同内容/同编号重试，先查询后决定是否提交 | `test/v2/agent-submission.test.mjs`、`test/v2/agent-submission-component.test.mjs`、`test/v2/agent-request-recovery.test.mjs` |
| 修改代码、切换旧批次、核验读取失败 | 不继承旧绿色结论，保留记录，禁止依赖未确认结果发布 | `test/v2/agent-journey-ui.test.mjs` |
| 文件缺失、空文件、附加文件 | 八份必需文件齐全才可计交付完整；附加文件不替代缺失项 | `test/v2/delivery-presentation.test.mjs` |
| 文件预览和版本审阅 | 纯文本转义、完整版本标识、明确范围、精确四项确认；渲染不调用发布 | `test/v2/delivery-components.test.mjs` |
| 同SQL新版本或新运行 | 不误用旧包；同来源重复请求仍复用记录 | `test/v2/agent-development-workflow.test.mjs`、`test/v2/agent-delivery.test.mjs` |
| 重新打开元数据库与返回任务 | 找回该任务的发布/批次/告警；不返回执行凭证或业务行，不重新计算 | `test/v2/local-task-publication.test.mjs` |
| 监控读取超时、旧响应、终态 | 单请求在途；失败保留旧记录但取消健康结论；旧响应不覆盖写回执；终态停自动读 | `test/v2/publication-read.test.mjs`、`test/v2/agent-journey-ui.test.mjs` |
| 实际本机回滚/被替代/失败状态 | `ROLLED_BACK_LOCAL`、`SUPERSEDED_LOCAL`、`FAILED_LOCAL`不能显示发布/监控完成 | `test/v2/agent-journey-ui.test.mjs` |
| 手工运行提交响应丢失、服务重启 | 恢复链接中的原幂等编号返回同一批次，不新增第二个队列任务 | `test/v2/durable-development.test.mjs`、`test/v2/manual-run-recovery.test.mjs` |
| 代码保存响应丢失、不同用户、存储故障 | 按用户/项目/编号找回原版本；不同内容拒绝覆盖；持久化失败不宣称恢复成功 | `test/v2/manual-revisions.test.mjs` |
| 人工来源与边界 | 来源任务须归属/口径匹配；记录人工修改来源，不改Agent原结论；恢复链接不含SQL或凭证 | `test/v2/manual-revisions.test.mjs`、`test/v2/manual-run-recovery.test.mjs` |
| 私有传输兼容代码 | 保存恢复只允许精确GET路径，拒绝额外路径、查询参数、写请求和未允许头 | `test/v2/private-application.test.mjs` |

统一命令：`npm run ci`（Node.js 22+；部分测试需允许本机临时回环端口）。分项可使用 `node --test <测试路径>`。测试名称中的实际计时器或HTTP指本机组件；执行器/队列替身不证明真实Spark或云事件链路。

## 尚未验收与不得越过的门槛

- **浏览器交互与视觉**：Safari/Chrome，1280/768布局，文件实际下载、按钮反馈、未保存修改保护及刷新恢复。静态组件渲染与HTTP 200都不足以签收。
- **真实模型与Spark**：新输入、新结果、独立断言、失败修正与中断恢复。不得重放固定报告冒充新完成。
- **私有云增量**：当前代码部署、身份继承、云元数据/对象存储恢复及费用。新增传输路由的本机测试不等于已注册或已部署。
- **人工私有云交付**：本机人工流程已有入口，云端人工版本的交付/批准适配仍未实现；不能借用旧Agent批准。
- **完整E2E评测**：至少20条证券全链路、目标≥85%；人工救援单独计，不把新增单元测试数当E2E样本数。
- **公网与最终交付**：访问边界、登录、HTTPS、跨网络性能、预算、复刻材料和全流程PPT按原计划签收。

## 已知限制

恢复链接只保存不透明请求/资源编号。若保存请求没有到服务端且页面已关闭，编号不能恢复未保存SQL，需重新填写后沿用原编号；冲突时必须先核对原记录。人工来源是持久元数据，不是不可篡改审计账本。旧监控事件缺包摘要时不回填“成功证据”。

完成本矩阵只证明恢复增量的相应代码/本机范围；项目的当前部署与阻塞以受保护执行记录为准。下一阶段应优先完成实际交互与真实链路验收，而不是无限增加状态标签或运维工具。
