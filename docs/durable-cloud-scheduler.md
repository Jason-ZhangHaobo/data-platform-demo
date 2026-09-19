# V2 云端持久调度

日期：2026-09-19。状态：核心、签名入口和默认关闭的外部驱动已本机验收；真实云发布创建、FC冻结恢复、Spark Worker和公网调用尚未验收。

## 为什么不能继续使用本机计时器

本机M2b/M2c的`LocalReleaseScheduler`依靠Node进程中的`setTimeout`。FC请求结束后可能冻结或释放实例，内存计时器无法作为未来批次一定被触发的证据。因此云端批次必须先持久化，再由函数实例之外的调度源周期性唤醒。

## 当前实现

- `DurableReleaseScheduler`不创建进程内计时器，只处理元数据库中到期且所属版本为`ACTIVE_CLOUD`的批次。
- 执行前把批次改为`RUNNING`、写入租约到期时间并强制持久化，然后才调用执行器。
- 实例中断后，后续tick只恢复已经过期的`CLOUD_DURABLE_SCHEDULE`租约；本机`ACTIVE_LOCAL`历史保持不变。
- `POST /api/v2/internal/scheduler/tick`使用独立HMAC域、毫秒时间戳、随机Nonce和原始正文摘要。有效Nonce在元数据库保存为最多100条的短窗口，冷启动后仍能拒绝重放。
- `.github/workflows/tick-v2-scheduler.yml`是个人试点的外部驱动适配器，按标杆T+1任务在工作日北京时间09:00触发并最多领取一批，也可手动触发。只有`V2_SCHEDULER_ENABLED=true`才运行；默认跳过，域名或密钥未配置时不会连接公网或产生执行费用。
- 客户端只输出恢复数、到期数、执行数和剩余数，不输出URL、Nonce、签名或共享密钥。

## 尚未完成

1. 当前发布API仍只创建`ACTIVE_LOCAL`版本，尚未把经过远程Spark、云审批和部署校验的包转换为`ACTIVE_CLOUD`；因此外部tick目前没有真实云批次可领取。
2. 还没有把`V2_RELEASE_SCHEDULER_MODE=DURABLE_TICK`和`V2_SCHEDULER_TICK_SECRET`注入受保护FC配置；不能用本机API测试冒充云调度。
3. GitHub cron适合作为低成本个人试点，不是证券公司生产级调度器。公司复刻应通过统一原子API适配DataWorks、公司调度平台或具备SLA的云调度服务。
4. 仍需真实验证FC冻结/释放后租约恢复、重复tick、执行超时、远程Spark取消、告警和回滚。

## 验收门槛

- 云函数最大实例1、实例并发1，领取状态在执行前已进入MySQL快照；
- 同一批次在并发/重放tick下最多一个有效租约；
- 强制中断后，租约未过期不重跑，过期后只恢复一次；
- 至少两个由外部调度源实际触发的Spark批次，包含一个故障、告警和恢复；
- 所有记录继续标明`publicDeployed=false`，直到HTTPS、公网身份、云Spark及完整验收同时通过。
