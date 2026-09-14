# V2 云端持久化与冷启动恢复

日期：2026-09-15。状态：代码与本机模拟云环境已验收；真实阿里云连接及公网部署待验证。

## 目标

公网函数重启后，不能只恢复菜单和任务名称，还必须恢复受邀账号、版本、运行、离线落地行、实时Checkpoint、DAPI实际查询快照和报表快照。HTTP写请求只有在相关状态达到耐久存储后才能返回成功。

## 存储分工

| 存储 | 内容 | 并发保护 |
|---|---|---|
| 独立MySQL元数据库 | 控制面文档、代码/发布版本、运行证据、邀请/用户/会话、权限、审计、幂等记录 | `revision`条件UPDATE，陈旧版本返回409 |
| 私有OSS状态对象 | 离线落地行、实时事件/最新状态/Checkpoint、DAPI业务快照、报表数据快照 | 首次`If-None-Match: *`，后续`If-Match: ETag` |
| 函数内存SQLite | 当前单实例的同步查询索引 | 由MySQL/OSS在冷启动时恢复，不作为持久化证据 |

业务状态对象不包含密码、令牌、模型Key或公司数据。当前仅处理仓库内虚构证券数据。

## 写入与恢复

1. 请求进入时刷新MySQL与OSS修订；冲突后的实例先丢弃陈旧本地状态并恢复胜出版本。
2. 数据写入SQLite索引，同时标记业务状态为待保存；控制面写入标记MySQL元数据为待保存。
3. 响应前先提交OSS业务状态，再提交MySQL元数据。这样不会产生“元数据已经引用、业务快照尚未落盘”的成功响应。
4. 实时后台处理、DAPI物化和报表快照不依赖下一次HTTP请求，写入监听会自动触发同一协调器。
5. 冷启动校验快照格式、项目、表结构、主键、DAPI快照外键与JSON字段，再恢复各SQLite索引；损坏状态拒绝启动。

MySQL与OSS之间没有分布式事务。若OSS成功而MySQL CAS失败，可能留下一个暂时无引用的OSS修订，但不会让元数据指向未保存数据。首个公网试点必须把FC最大实例数固定为1；扩大并发前迁移到事务性业务库或增加正式提交协议。

## 云端环境变量

只列键名，不在仓库保存值：

- `V2_MYSQL_HOST`、`V2_MYSQL_PORT`、`V2_MYSQL_USER`、`V2_MYSQL_PASSWORD`、`V2_MYSQL_DATABASE`
- `V2_MYSQL_POOL_SIZE`、`V2_MYSQL_CONNECT_TIMEOUT_MS`、`V2_MYSQL_SSL`
- `OSS_BUCKET`、`OSS_ENDPOINT`、`V2_OSS_STATE_OBJECT_KEY`、`V2_OSS_STATE_MAX_BYTES`
- `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET`、`ALIBABA_CLOUD_SECURITY_TOKEN`（由FC角色临时注入，不手填长期AccessKey）

默认OSS对象：`data-platform-v2/state/project-securities-lab.json`；默认上限40MiB。扩大数据量时不提高对象上限来掩盖架构问题，应改用真实业务数据库/湖存储。

## 已验收证据

- 四类SQLite数据面全部写入后关闭并重建，离线行、实时事件/状态/Checkpoint、DAPI查询数据和报表快照均恢复。
- 两个陈旧实例竞争时，MySQL与OSS CAS均拒绝覆盖胜出修订。
- HTTP链路创建虚构证券CSV源、测试连接、扫描元数据、创建并运行FULL同步；成功响应后模拟冷启动，运行记录与落地行同时存在。
- 全量`npm run ci`为159/159，源码检查、旧版构建、V2 TypeScript/Vite构建通过。

## 尚未验收

- 真实RDS中是否已建立独立平台元数据库/最小权限账号，以及内网地址和SSL配置。
- 真实OSS Bucket、FC服务角色的对象读写权限和ETag条件更新行为。
- FC Node 24运行时/自带二进制、最大实例数1、HTTPS域名、冷启动时延及月度账单。
- 多实例并发、跨区域灾备、对象版本保留/生命周期、事务性业务RDS适配。

因此当前状态不能标记为“公网已部署”或“生产级云持久化”。
