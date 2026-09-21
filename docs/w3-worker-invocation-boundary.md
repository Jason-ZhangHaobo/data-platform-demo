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

`remote-spark-queue.mjs`已经提供签名任务信封、结果签名、任务/结果/取消对象键、TTL、项目绑定、篡改拒绝和轮询超时。测试覆盖跨项目任务、伪造签名、跨任务结果替换和取消标记。

该代码尚未接入云控制面，也没有创建OSS触发器、Worker专用角色或队列前缀权限；因此不把它写成W3已完成。下一实现批次需要把队列对象接入现有OSS签名客户端、Worker触发消费、不可变结果、告警和恢复。

官方依据：[InvokeFunction](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-invokefunction)、[FC RAM授权表](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-ram)、[Web函数Invoke转换](https://help.aliyun.com/en/functioncompute/web-functions)。
