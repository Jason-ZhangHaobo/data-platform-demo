# 阿里云只读预检与脱敏记录

日期：2026-09-16。状态：脚本、Cloud Shell临时身份、脱敏测试与真实账号只读审计已执行；RDS已按授权复核后停止；独立V2 FC创建仍受包、受保护配置和域名门禁约束。

## 目的

在创建数据库、函数、触发器或预算前，用一次只读CLI检查回答五个问题：

1. RDS是否运行、是否Serverless/自动暂停、版本/存储/到期时间是什么；
2. `business_demo`与独立`platform_meta`、`sync_writer`与最小权限`platform_app`是否存在；
3. 现有FC规格、实例并发、VPC、角色和环境变量键是否满足V2；
4. 私有OSS是否在杭州、ACL/存储类/版本状态如何；
5. 当月账单是否可读、税前/支付/未付金额和产品范围是否低于200元门槛。

脚本：`scripts/aliyun-v2-readonly-audit.sh`。它只调用STS、RDS Describe、FC Get、OSS GetBucketInfo和BSS QueryBillOverview，不创建、修改、启停或删除资源。

## 脱敏边界

输出`shuzhan-aliyun-readonly-audit/v1` JSON只保留决策需要的状态：规格、数量、布尔存在性、已知V2环境键是否齐备、金额、目标函数/域名哈希和交叉检查。未知环境键列表不进入报告。

明确不输出：账号ID/ARN、函数名、RDS实例ID、VPC/vSwitch/安全组ID、Bucket名、连接地址、数据库账号名列表、环境变量值、AccessKey、密码和Token。VPC ID只在进程内比较RDS/FC是否一致，写文件前删除。

输出始终用跨平台`mktemp`创建新临时文件并设0600，避免固定路径覆盖。命令失败只记录`UNAVAILABLE`和脱敏错误码，不把可能包含请求信息的stderr、RequestID或错误原文写入报告。

## 使用方式

优先使用本机阿里云CLI OAuth：浏览器一次授权后取得短期STS凭证并自动刷新，不创建或保存用户手工输入的长期AccessKey。OAuth配置文件必须是0600；审计进程只在内存环境中把临时AK/SK/Token传给官方插件，退出即清除。也可在Cloud Shell临时会话执行。

由Codex设置本次审计参数并执行，不要求用户复制长命令：

- `V2_AUDIT_RDS_INSTANCE_ID`
- `V2_AUDIT_FC_FUNCTION_NAME`
- 可选`V2_AUDIT_OSS_BUCKET`（为空时从函数环境中进程内读取，但不输出）
- 可选`V2_AUDIT_REGION`，默认`cn-hangzhou`
- 可选`V2_AUDIT_BILLING_CYCLE`，默认北京时间当月
- 本机OAuth可选`V2_AUDIT_OAUTH_PROFILE`；只接受安全名称并验证配置文件不是符号链接且权限为0600

脚本最后只打印受保护的报告路径。Codex读取脱敏JSON做决策；原始API响应位于随机临时目录并在脚本退出时删除。

## 自动测试

测试用假CLI响应故意放入账号ID、ARN、连接地址、Bucket、角色、VPC、函数名、RDS ID和环境变量秘密值。最终报告准确得到同VPC、MySQL8、平台库/账号、单并发和账单阈值，同时逐项确认上述原值均不存在，文件权限为0600。

## 2026-09-16真实只读结果

脱敏原始证据见[`evidence/aliyun-readonly-audit-2026-09-16.json`](evidence/aliyun-readonly-audit-2026-09-16.json)：

- STS身份、RDS属性/网络、BSS账单和OSS属性读取成功；没有把账号ID、实例ID、Bucket名、地址或凭证写入脱敏报告。Cloud Shell主机时钟与本机有偏差，脱敏报告`generatedAt`按本机收到结果的时间记录，用于24小时新鲜度门，不把远端时钟当作统一时间源。
- RDS最终已回到`STOPPED`，Serverless MySQL 8.0，`AutoPause=true`、0.5—2 RCU；端点为Private、1个，公网0个。经授权临时唤醒期间读到2个数据库（含`business_demo`、`platform_meta`）和2个账号（含`sync_writer`、`platform_app`），`platform_app`为Available且对`platform_meta`为ReadWrite；这些库/账号结果标记为`observedWhileRunning`，不把停止后的状态误报为当前可连接。
- RDS库/账号在本次授权唤醒窗口内实际读取并在核验后停止；最终状态仍为STOPPED，后续连接前必须再次唤醒，避免持续计费。
- 当月税前金额约0.60元、支付0元、未付约0.60元，低于200元硬门；账单仍可能有延迟，不是未来费用承诺。
- OSS账号内可见1个候选，杭州、Standard、private、LRS；ossutil未安装，版本控制状态本次未单独读取。Bucket名、端点和Owner字段只在Cloud Shell进程内处理，没有进入报告。
- FC账号内可读3个函数，V2命名候选0；其中仅1个配置VPC、0个单并发、角色配置1个，运行时为custom-container/custom.debian10混合。无法证明V2专用函数、同VPC、单并发或目标绑定，部署门保持失败关闭。

## 2026-09-16独立V2 FC创建前置复核

- 在不创建或更新云资源的情况下重新读取：杭州账号有7个RAM角色，其中2个信任FC（1个名称符合V2/部署候选）；角色策略可读，未发现管理员级策略文本匹配。
- VPC、交换机和安全组查询均成功；RDS当前实例所在VPC存在，至少有1个交换机和1个安全组可供后续最小绑定。资源标识只在Cloud Shell进程内比较，没有写入报告。
- FC 3.0函数列表仍为3个，无V2专用目标；没有复用旧函数。RDS保持STOPPED，不因前置检查再次唤醒。
- 本机分支已推送并在GitHub Linux x64手动CI完成构建/Node24运行时门禁；Cloud Shell系统为glibc 2.27，无法运行官方Node24二进制，因此不在Cloud Shell降级为Node14/Node22构包。函数创建继续关闭，直到通过受控Linux包获取和受保护MySQL/OSS/管理员配置注入。

## 仍需真实验证

- FC列表和函数摘要已可读取，但账号内没有V2命名候选；仍需明确专用函数并交叉核对环境引用、VPC、并发与OSS绑定，不能把现有函数冒充V2目标。
- 仍需由同VPC云函数使用`platform_app`完成真实建表、CAS、冷启动和错误恢复；控制面Describe通过不等于数据面连接通过。
- Serverless试用/优惠到期后的价格不能仅由实例属性推导，必须结合账单和订单信息。
- 只读结果通过后，任何创建`platform_meta`、账号、V2函数或预算的写操作仍单独遵守审批边界。

官方依据：[CLI OAuth](https://help.aliyun.com/zh/cli/oauth-credentials)、[QueryBillOverview](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querybilloverview)、[RDS DescribeDBInstanceAttribute](https://help.aliyun.com/en/rds/developer-reference/api-rds-2014-08-15-describedbinstanceattribute)、[FC 3.0 GetFunction](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-getfunction)、[OSS GetBucketInfo](https://help.aliyun.com/en/oss/developer-reference/get-bucket-info)。
