# Repository guidance

This is a public learning repository. Never add company code, real user data, internal URLs, credentials, screenshots containing private information, or production configuration.

## Product rules

- Keep all demo organizations, tables, users, and data fictional.
- Preserve the module boundaries for sync tasks, data development, masking, and data assets.
- Legacy V1 simulates most workflows; keep that labeling. V2 must use real execution and independent assertions, as specified in docs/PRD.md.
- Do not deploy the local V2 developer identity or process runner publicly. Invite authentication, isolated execution, cloud persistence and the monthly budget must pass their gates first.
- User-facing copy is Simplified Chinese. Code, API fields, and commit messages use English.

## Engineering rules

- Keep browser code, server code, shared validation, and persistence separated.
- Prefer the Node.js standard library for the MVP; add dependencies only with a clear product benefit.
- Validate every API input on the server.
- Add or update tests for behavior changes.
- Run `npm run ci` before handing off changes.
- Never commit `.env`, access keys, tokens, database passwords, or generated `.data` files.

## 高效执行约定

以下为用户要求长期遵守的执行规则；不因切换模型、会话或上下文压缩而主动放弃。它们不替代安全约束，也不构成新的部署、付费、扩权或删除授权。

### 开始前

1. **先恢复事实，再行动。** 读取本文件与 `docs/goal-mode-next.md` 的最新状态，检查 Git 状态及本轮需要的少量证据；不要默认重读所有历史。需求与边界看 `docs/PRD.md`，已确认决策看 `docs/decisions.md`。历史记录不当当前待办；状态冲突时以较新的实际验收证据核实。
   如果本机存在 `docs/private-execution-state.md`，同时读取其私有运行状态；该文件及其引用的私有证据禁止推送或公开转述。公开仓库中的开发计划不能替代受保护的实际部署记录。
2. **只选一条主线。** 用简短说明确定“本轮交付、通过标准、明确不做什么”。优先当前 P0 和用户直接可见的端到端价值；不为增加菜单、模块数量或中间产物扩散工作。备案等独立事项可并行核验，但不让等待吞掉整个迭代。

### 实施中

3. **复用已通过的底座。** 优先复用函数、Worker、存储、凭证、构建包、接口及测试脚本。没有新证据表明失效，不重新创建资源、重置密码或从头搭建。旧验收不代表当前永远有效；只刷新本轮确实需要且会失效的证据。
4. **CLI/API 优先。** GUI 用于必要登录、用户旅程和视觉验收。需要用户参与时直接打开准确界面或给链接；能够自行完成的已授权步骤不转交用户。已有授权仅在原范围内沿用，新费用、权限、不可逆操作或范围变化仍单独处理。
5. **先小验证，再大动作。** 先用最小请求/定向测试定位故障，再构建和部署；同一可回滚范围内的修复合并发布。复用同一已核验产物，不因网络重试重复构建或上传未变化的大包；优先使用已验证有效的传输路径。
6. **重试必须有依据。** 同类失败连续两次且没有新证据时，停止原样重试，记录失败点、新假设及替代路径。调用设合理超时，长操作返回任务编号并保留恢复点；写入结果未知时先按原任务/幂等标识查证，不能盲目再提交。安全拦截不得通过换工具或入口绕过。
7. **临时环境不是产品入口。** Cloud Shell 等只用于临时验收；操作前核验会话和进程，不把缓存页面当在线服务。到期时优先自动恢复已验证产物，不能靠反复让用户登录维持产品体验；长期入口另按上线门槛完成。
   云端验收编号、检查点和日志不能唯一保存在临时环境的 `/tmp`；开始前设置受保护的可恢复位置并及时导出。先验证实际运行时与后台驱动已启动，再执行后续验收；配置更新后核对实例启动标识，不假设开关回读成功就已完成进程切换。
8. **控制等待、成本和信息量。** 只并行独立且不会互相修改状态的检查；同一资源的写入顺序执行。等待期间推进独立测试或文档，不高频轮询不变状态。不重复输出大段帮助、完整历史或无关日志。每轮记录验收结果与必要的耗时/成本信息，用事实识别瓶颈。

### 验收与交付

9. **按业务结果验收。** 区分“已确认、已实现、已部署、已验收”，本机/私有云/公网分别记录。配置成功、HTTP 200、按钮出现、SQL 跑通均不等于完整业务成功。验证新任务、独立预期、恢复/失败路径及必要的权限边界；不把人工救援或手动 SQL 计作 Agent 自主完成。修复先做定向回归，交付继续遵守本文件的完整 CI 门槛。
10. **界面与功能一起验收。** 检查结果是否真的可见、操作反馈是否清楚、错误是否能恢复；不能只看接口和无障碍树。给用户实际可用的界面、链接或本机文件，标明临时入口及未完成范围，不交付未验证的“可用链接”。
11. **只保留一份当前执行状态。** 收尾更新 `docs/goal-mode-next.md` 顶部：完成结果、证据入口、剩余缺口、唯一下一步和真实阻塞；过时状态归入历史，相关路线图引用该入口，避免多份冲突待办。代码、接口及验收记录随本轮范围更新，不为更新日期重写全部文档。
12. **保密和预算不打折。** 所有案例用虚构证券数据。私有云标识、清单、凭证和详细运维证据留在本机或受保护位置，公开仓库仅保留适合公开的代码、虚构测试与脱敏结论。运行费用遵守已确认月预算，不为赶进度扩权、扩容、绕过审批或提前公开写入口。

交付时简明回答：本轮完成了什么、怎样验证、在哪里查看、还差什么、是否确实需要用户配合。没有真实阻塞时不重复索要确认；有阻塞则明确其范围，继续不受影响的工作。
