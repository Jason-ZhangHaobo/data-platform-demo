# 阿里云只读预检与脱敏记录

日期：2026-09-15。状态：脚本与脱敏测试已完成；真实账号尚未执行。

## 目的

在创建数据库、函数、触发器或预算前，用一次只读CLI检查回答五个问题：

1. RDS是否运行、是否Serverless/自动暂停、版本/存储/到期时间是什么；
2. `business_demo`与独立`platform_meta`、`sync_writer`与最小权限`platform_app`是否存在；
3. 现有FC规格、实例并发、VPC、角色和环境变量键是否满足V2；
4. 私有OSS是否在杭州、ACL/存储类/版本状态如何；
5. 当月账单是否可读、税前/支付/未付金额和产品范围是否低于200元门槛。

脚本：`scripts/aliyun-v2-readonly-audit.sh`。它只调用STS、RDS Describe、FC Get、OSS GetBucketInfo和BSS QueryBillOverview，不创建、修改、启停或删除资源。

## 脱敏边界

输出`shuzhan-aliyun-readonly-audit/v1` JSON只保留决策需要的状态：规格、数量、布尔存在性、环境变量键、金额和交叉检查。

明确不输出：账号ID/ARN、函数名、RDS实例ID、VPC/vSwitch/安全组ID、Bucket名、连接地址、数据库账号名列表、环境变量值、AccessKey、密码和Token。VPC ID只在进程内比较RDS/FC是否一致，写文件前删除。

输出始终用`mktemp`创建新`/tmp`文件并设0600，避免覆盖用户文件。命令失败只记录`UNAVAILABLE`，不把可能包含请求信息的stderr写入报告。

## 使用方式

Cloud Shell登录后，由Codex在当前终端设置本次审计参数并执行，不要求用户复制长命令。参数只在Shell会话中存在：

- `V2_AUDIT_RDS_INSTANCE_ID`
- `V2_AUDIT_FC_FUNCTION_NAME`
- 可选`V2_AUDIT_OSS_BUCKET`（为空时从函数环境中进程内读取，但不输出）
- 可选`V2_AUDIT_REGION`，默认`cn-hangzhou`
- 可选`V2_AUDIT_BILLING_CYCLE`，默认北京时间当月

脚本最后只打印受保护的报告路径。Codex读取脱敏JSON做决策；原始API响应位于随机临时目录并在脚本退出时删除。

## 自动测试

测试用假CLI响应故意放入账号ID、ARN、连接地址、Bucket、角色、VPC、函数名、RDS ID和环境变量秘密值。最终报告准确得到同VPC、MySQL8、平台库/账号、单并发和账单阈值，同时逐项确认上述原值均不存在，文件权限为0600。

## 仍需真实验证

- Cloud Shell身份是否具备RDS/FC/OSS只读权限；BSS需财务只读权限，账单存在延迟。
- `ossutil`是否已安装；缺失时只标记OSS不可用，不临时安装未知工具。
- Serverless试用/优惠到期后的价格不能仅由实例属性推导，必须结合账单和订单信息。
- 只读结果通过后，任何创建`platform_meta`、账号、V2函数或预算的写操作仍单独遵守审批边界。

官方依据：[QueryBillOverview](https://help.aliyun.com/zh/user-center/developer-reference/api-bssopenapi-2017-12-14-querybilloverview)、[RDS DescribeDBInstanceAttribute](https://help.aliyun.com/en/rds/developer-reference/api-rds-2014-08-15-describedbinstanceattribute)、[OSS GetBucketInfo](https://help.aliyun.com/en/oss/developer-reference/get-bucket-info)。
