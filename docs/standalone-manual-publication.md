# 独立手工交付的确切版本审阅、发布与监控

更新：2026-11-10。已实现并完成本机合成签名队列、认证HTTP、SQLite重开及完整页面验收；尚未部署或验收真实云端，不计当前v3 Agent自主E2E。

## 1 背景

独立手工SQL已有成功来源、八文件和持久演练，但旧发布引擎强制要求Agent任务。工程师应能从经典开发直接完成交付，不能通过创建假Agent或借用运行编号来满足发布接口。

## 2 价值

复用现有持久发布引擎，将本人手工交付作为真实来源：逐项审阅确切包和成功演练，创建两个冻结虚构证券样例批次，读取运行、告警和恢复事件。页面关闭与服务重开不丢原发布；所有渠道保留同一来源、原请求及人工归因。

## 3 问题

- 不能把手工交付编号写成sourceAgentTaskId，也不能把人工作者成果算Agent自主完成。
- 文件核对期间原来源、身份或授权窗口可能变化；旧批准不能代替当前包与演练的审阅。
- 发布回执丢失不等于失败，重提可能重复批准或调度。停止原发布又不能依赖一次成功的Worker回执读取。
- 顶层导航与权限投影也要认识独立手工来源，否则子面板有功能，整页却按不存在的Agent定位或禁用。

## 4 需求与验收

### 流程与归因

本人成功手工版本 → 八文件与成功演练 → 四项审阅 → 发布确切版本 → 两个受控调度批次 → 原发布运行、告警和恢复监控。

四项为：当前代码／业务口径、独立结果／五场景断言、调度／部署等交付文件、两个冻结虚构样例的非生产范围。页面不预勾，不自动批准；CLI需提供人工审阅JSON，MCP需显式四项确认及confirm。发布本身登记调度，不即时调用模型或计算。

review、approval、release、release_run保留 `manualDeliveryTaskId` 与 `source.kind=MANUAL_RUN`，绑定原run／revision／revisionHash。归因固定 `MANUAL／ENGINEER_AUTHORED`、`agentIndependentE2E=false`；没有sourceAgentTaskId或新Agent记录。原代码、运行和历史保持不变。

沿用既有持久发布引擎、不可变产物验证、签名定时事件、预算、预留、失败告警和恢复关联。读取只核对原回执；外部事件才提交新批次。两个同业务日样例不是两个交易日，也不是生产持续调度。

### 来源及权限

审阅前核对原作者、手工成功证据摘要、确切交付资源、包摘要、八文件、成功隔离演练和五场景／测试SQL。产物读取后重读全部来源并检查授权；改变时不创建批准或发布记录。会话由后端确定，不能从请求选择作者；另一管理员也不能冒领。

默认仍为既有Agent发布范围。只有显式配置 `V2_PUBLIC_PUBLICATION_SOURCE_KIND=MANUAL_DELIVERY` 才把 `V2_PUBLIC_PUBLICATION_TASK_ID` 解释为手工交付编号；默认 `AGENT_TASK` 不开放此范围。即使UUID相同，两类身份也不能互换。

独立手工发布还要求已配置持久隔离执行器、`V2_DURABLE_MANUAL_DELIVERY_ENABLED=true`、私有签名发布驱动和指定管理员、包摘要、演练、最多两小时窗口。复用原窗口日期、签名规则与预算门，不自动创建触发器、IAM或资源。代码合并不构成配置这些环境项或运行真实批次的授权。

窗口只给指定账号SESSION／DELIVERY，不开放开发、其他模块或账号管理。到期后可读原历史，不再批准或开始新计算；现有已结束的云授权不会因本功能恢复。

### API、CLI、MCP

| API | 作用 |
|---|---|
| `GET /api/v2/delivery/manual/:id/publication` | 指定sourceKind=MANUAL、sourceRunId、packageDigest、verificationId及可选releaseId，读取同源发布／批次／告警／事件 |
| `POST /api/v2/delivery/manual/:id/publication` | 同一来源选择、四项attestations及稳定Idempotency-Key，审阅并登记两个批次 |
| `POST /api/v2/delivery/manual/:id/publication/cancel` | 同源选择及确切releaseId，停止原发布并保留历史 |

POST只接收正文选择，不能混用查询、作者或其他字段。回执协议为 `shuduo-standalone-manual-publication/v1`；无发布和读取失败分别呈现，不能把错误当空历史。

CLI：`shuduo manual publication|publish|stop-publication`，均指定 `--source-run-id`、手工交付 `--id`、`--package-digest`、`--verification-id`。发布另需 `--file REVIEW_JSON --request-id UUID --confirm`，文件仅含四项attestations；停止另需 `--release-id --confirm`。

MCP：`manual_publication_detail`、`manual_publication_create`、`manual_publication_cancel`。与GUI／CLI共用来源、清单字节、发布关系、测试SQL摘要和五场景回执核对，不因HTTP200确认成功。

原请求未知先读原发布，显式重试沿用原请求／正文。GUI根据确切来源／包／演练生成稳定的非秘密请求UUID，跨刷新和关页保持一致；该编号不授予任何权限。停止不先读产物或Worker回执；客户端只返回 `STOP_ACK_ONLY`，该回执不代表结果核验，完整监控另读。

私有转发须独立开启手工发布能力（预览参数 `--manual-publication`）。旧Agent转发开关不隐含此权限；只允许同源规范路径和确切来源查询，绝对URL、路径归一化别名、重复参数、作者注入和开发写入均拒绝。后端仍独立执行会话、CSRF与窗口检查。

### 界面与证据

顶层身份只在确切手工来源解析成功后提供原版本入口，清除旧Agent／请求选择；没有解析成功不回退其他任务。开发区只读，发布资格独立计算。文件演练显示已通过，发布阶段显示自己的当前状态，避免发布完成后仍标“待审阅”。

发布结果未知时保留文件和原请求，关闭再次发布；只读找回原发布后显示原批次。监控按用户刷新，不通过页面高频请求驱动计算；停止确认与读取错误分开，原任务可在有效权限内停止。

完整本机CI1719项：1718通过、0失败、1既有跳过；类型、构建和入口体积门通过。新增验收覆盖真实手工生产者、来源／归因损坏、异步证据／窗口变化、另一账号、CSRF、旧Agent范围、原请求恢复、签名事件、SQLite重开、窗口到期、CLI／MCP、停止无预读、导航与私有转发。

完整页面使用合成来源、签名队列和Worker回执：逐项审阅后一次发布请求，丢失回执只读恢复；页面关闭后两个事件批次推进，并经过两次SQLite重开；重开页面保持原包、发布、批次及两条监控事件，零模型、零Agent记录。所有临时进程已停止。该证据不证明真实云冷启动、公网性能或自主完成率。

## 5 Demo

证券财富场景：股票持仓＋可用现金T+1（非客户全资产）。工程师从已核验手工SQL查看八文件，审阅后登记两个固定样例批次；页面关闭后调度器推进，回来看到同一发布的两批独立核验结果。下一步将这些确切发布结果接到DAPI／XAPI消费，继续保留独立手工来源。
