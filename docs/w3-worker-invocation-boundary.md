# W3 控制面调用 Worker 边界

状态：待用户决策，尚未申请或附加新权限。日期：2026-09-21。

## 已验证事实

- 私有Worker已完成固定虚构证券Spark烟测，控制面尚未连接。
- 当前控制面与Worker共用一个仅含私有OSS前缀Get/Put的运行角色；直接给该角色增加Invoke会同时授权两端。
- FC 3.0官方授权表把`fc:InvokeFunction`标记为全部资源且无服务条件键，RAM策略只能使用`Resource:"*"`，不能限定到一个Worker ARN。
- 应用代码可以校验固定函数名和HMAC，但这不能替代RAM目标资源约束。

## 方案A：直接Invoke

新增一个只含`fc:InvokeFunction`的自定义策略并仅附加控制面运行角色；先把Worker迁到独立、无业务权限的运行角色。控制面使用FC SDK与临时凭证调用固定Worker，并继续使用请求HMAC、Nonce、防重放、大小、超时和项目白名单。

优点是实现快、调用链短。缺点是策略必须`Resource:"*"`：控制面被攻破时理论上可调用账号内其他函数。应用白名单只能降低误用，无法形成云权限硬边界。

## 方案B：私有OSS任务队列（推荐）

控制面把签名任务写入私有OSS的create-only前缀；OSS对象创建事件触发Worker。Worker执行后写入不可变结果对象，控制面按任务ID读取。任务和结果均设大小、摘要、TTL、项目及幂等约束，并持久记录提交、开始、完成、失败、取消和孤儿恢复。

优点是控制面不需要`fc:InvokeFunction`，任务在FC冻结或重启后仍存在，也为持久调度提供同一底座。缺点是需要新增OSS触发器、专用触发角色、Worker专用空权限运行角色和任务恢复代码，实施量更大。

## 推荐与验收

数舵的目标包含最小权限、持久调度和故障恢复，因此推荐方案B。第一版验收至少包括：任务create-only、同摘要幂等、对象篡改拒绝、一次触发、超时、取消、结果断言、冷启动恢复、失败告警、无公网地址、控制面角色无Invoke权限。

如果选择方案A，必须单独明确接受账号级函数调用风险；策略、代码和回滚完成审阅后再附加。任一方案都先拆分Worker运行角色，避免控制面权限向Worker继承。

## 已完成的本地队列基础

`remote-spark-queue.mjs`已经提供签名任务信封、结果签名、任务/结果/取消对象键、TTL、项目绑定、篡改拒绝和轮询超时，并复用已有OSS签名和有界重试实现create-only读写。Worker消费器只接受配置的任务前缀、校验任务签名后才执行，并将签名结果写回绑定结果键；有效取消标记会阻止运行。测试覆盖跨项目任务、伪造签名、跨任务结果替换、取消和非法对象键。

Worker现已能解析官方原生OSS触发事件，只接受`ObjectCreated:PutObject`、杭州、配置Bucket和任务前缀；然后读取签名任务、执行Spark并写回绑定结果。原有私有健康/固定烟测仍需显式开关，队列触发不允许任意HTTP执行。

该代码尚未接入云控制面，也没有创建OSS触发器、Worker专用角色或队列前缀权限；并且新增模块会改变Worker不可变包摘要，当前已验收的云Worker继续保持原包。因此不把它写成W3已完成。下一实现批次需要重新双构建、上传新包、创建专用角色和OSS触发器、真实事件执行、不可变结果、告警和恢复。

## 已准备的失败关闭云变更计划

`scripts/render-v2-w3-oss-trigger-plan.mjs` 只渲染计划，固定 `apply=false`，不调用阿里云。它要求未来 W3 包必须是一个不同于已验收 W2 包的新摘要，并要求 Worker 运行角色不同于控制面角色；否则立即失败。输出采用以下不可变边界：

- Worker 角色仅能读取新包、签名任务和取消对象，并且仅能写签名结果对象；不含 `fc:InvokeFunction`、List、Delete 或宽泛 Bucket 权限。
- 原生 OSS 触发器只接受 `oss:ObjectCreated:PutObject`，仅匹配 `data-platform-demo/v2/spark-queue/jobs/` 前缀和 `.json` 后缀；结果和取消前缀不匹配，避免自触发循环。
- 控制面保持无 `fc:InvokeFunction` 权限；它只沿既有私有 OSS 数据面创建任务、写取消标记并读取签名结果。
- 计划如实披露 `fc:CreateTrigger` 在官方 RAM 表中是账号级动作，因此在角色创建、`ram:PassRole`、Worker 更新和触发器创建前仍须一次明确审批；它不会把“代码已合并”转换为“已获得权限”。

原生 OSS 触发器的 `invocationRole` 按官方文档使用事件源角色（通常为 `AliyunOSSEventNotificationRole`）；触发器配置要求独立的事件、前缀和后缀组合，并避免以 `/` 开头的前缀。实施时只可使用计划生成的固定组合并在创建后回读验证。[CreateTrigger 参数](https://help.aliyun.com/en/functioncompute/api-createtrigger)、[OSS 原生触发器规则](https://help.aliyun.com/en/functioncompute/fc-2-0/user-guide/configure-a-native-oss-trigger)、[事件源授权角色](https://help.aliyun.com/en/functioncompute/fc/grant-an-event-source-permissions-to-access-function-compute-1)。

官方依据：[InvokeFunction](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-invokefunction)、[FC RAM授权表](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-ram)、[Web函数Invoke转换](https://help.aliyun.com/en/functioncompute/web-functions)。
