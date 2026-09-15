# 阿里云只读预检与脱敏记录

日期：2026-09-15。状态：脚本、OAuth安全桥、脱敏测试与真实账号只读审计已执行；需启停或配置资源的检查仍待授权。

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

## 2026-09-15真实只读结果

脱敏原始证据见[`evidence/aliyun-readonly-audit-2026-09-15.json`](evidence/aliyun-readonly-audit-2026-09-15.json)：

- 身份与RDS属性、网络及BSS账单查询成功；没有记录账号ID、实例ID、地址或凭证。
- 初次审计发现RDS为`STOPPED`；经明确批准短暂唤醒后，最终证据为Running、Serverless MySQL 8.0、0.5—2 RCU、20GiB ESSD、`AutoPause=true`，只有1个内网端点、无公网端点。
- 运行态确认`business_demo`和`sync_writer`仍存在；随后创建独立`platform_meta`和Normal账号`platform_app`，只授该库ReadWrite。最终库/账号各2个，`platformDatabaseReady=true`；密码由用户隐藏输入且不进入报告。
- 2026-09税前金额与未付金额均为0.59元，支付0元；当前低于200元硬门。账单存在延迟，该快照不是未来费用承诺。
- 账号仅有1个OSS Bucket；经官方ossutil 2.3.0和官方SHA-256校验后，在进程内选择该唯一候选。候选位于杭州、Standard、private，版本控制未配置；名称不进入报告。由于FC仍不可读，不能证明它就是函数当前引用的目标Bucket。
- FC 3.0只读插件返回`AccessDenied`；随后官方Node SDK携带现有OAuth短期STS在官方区域Endpoint再查，仍返回AccessDenied/缺SecurityToken类别。无法证明专用函数、同VPC或单并发；不误报目标不存在。

## 仍需真实验证

- FC只读接口对OAuth短期STS的接入问题；已验证SDK内部有STS字段，未解决前不能读取函数规格。官方SDK临时安装在项目忽略的`.runtime`中，仓库只保留无秘密的只读脚本和脱敏测试。
- FC可读后交叉核对函数环境引用与当前唯一OSS候选；在此之前不把“账号内唯一”写成“V2已绑定”。
- 仍需由同VPC云函数使用`platform_app`完成真实建表、CAS、冷启动和错误恢复；控制面Describe通过不等于数据面连接通过。
- Serverless试用/优惠到期后的价格不能仅由实例属性推导，必须结合账单和订单信息。
- 只读结果通过后，任何创建`platform_meta`、账号、V2函数或预算的写操作仍单独遵守审批边界。

官方依据：[CLI OAuth](https://help.aliyun.com/zh/cli/oauth-credentials)、[QueryBillOverview](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querybilloverview)、[RDS DescribeDBInstanceAttribute](https://help.aliyun.com/en/rds/developer-reference/api-rds-2014-08-15-describedbinstanceattribute)、[FC 3.0 GetFunction](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-getfunction)、[OSS GetBucketInfo](https://help.aliyun.com/en/oss/developer-reference/get-bucket-info)。
