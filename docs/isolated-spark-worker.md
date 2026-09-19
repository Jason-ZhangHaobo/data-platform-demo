# V2 隔离Spark Worker

日期：2026-09-19。状态：协议、客户端、Worker服务和版本化交付已本机验收；W1 Linux大包已在GitHub Runner真实构建，Java启动、FC网络与真实运行待验证。

## 设计目标

公网控制面保持轻量，不在处理登录、资产查询或页面请求的进程内运行Spark。只有通过身份、项目权限和代码安全检查的任务，才将有限合成上下文发送给单独执行函数。

这不是通用任意代码沙箱。第一版只执行本项目允许的单条Spark SQL，并只接收`accounts`、`positions`、`cash`三张虚构证券表；Python、外部文件、任意JAR/UDF和公司数据均不在范围内。

## 调用协议

控制面发送`shuzhan-spark-execution/v1` JSON：请求ID、提交时间、SQL、一个主上下文、最多五个回归上下文和可选测试SQL。

应用层签名：

`HMAC-SHA256(secret, timestamp + "\n" + nonce + "\n" + SHA256(body))`

- 时间戳为13位毫秒，默认允许60秒偏差；
- Nonce为24字节随机值，Worker在有效窗口内拒绝重复；
- 签名绑定完整正文，修改SQL、数据或断言都会失败；
- 默认请求/响应各2MiB，执行最长120秒，单Worker同时只运行1项；
- 非回环地址必须HTTPS，重定向被拒绝；
- Worker返回`SUCCEEDED`但独立断言未通过时，控制面仍按无效结果拒绝。

HMAC是应用层纵深防御，不足以单独抵御恶意流量带来的函数调用费用。真实部署还必须使用FC私网、函数级鉴权或其他账号级调用保护，不能开放匿名公网Worker。

## 运行时与安全升级

本机历史验收使用Spark 3.5.7，相关证据保持不可变。2026-09-15检查发现PyPI为3.5.7列出已在3.5.8修复的安全问题，而Apache已经发布3.5.9稳定维护版。因此：

- 历史3.5.7只保留为本机既有证据，不打入新云Worker；
- 新Worker锁定`pyspark==3.5.9`和`py4j==0.10.9.9`，requirements包含PyPI文件SHA-256；
- 云交付包必须由实际3.5.9 Worker运行产生，并把引擎版本、`FUNCTION_PROCESS`隔离和2GiB内存写入版本化部署清单；
- 远程运行如果报告3.5.7，交付包生成失败关闭；本机历史3.5.7包仍可复验，不被改写。

同日已把项目隔离的本机运行时升级为Spark3.5.9/py4j0.10.9.9，并在新版本重新执行35项引擎、交叉口径与测试SQL用例，35/35通过、耗时23.891秒。该证据仍属于本机，不替代W1—W5云端门槛。

官方依据：[Apache Spark 3.5.9发布](https://spark.apache.org/news/)、[Apache Spark下载与安全提示](https://spark.apache.org/downloads)、[PySpark 3.5.9 PyPI元数据](https://pypi.org/pypi/pyspark/3.5.9/json)。

## 构建包

`scripts/build-v2-spark-worker-package.sh`要求Linux x64与Python3.10，安装哈希锁定依赖，复制最小Node Worker和Python执行器，拒绝秘密文件与覆盖已有ZIP。包最大480MiB；PySpark源码包约303MiB，不能通过FC API的Base64代码字段上传，应先放入私有OSS，再由FC代码位置引用。

手动GitHub工作流`.github/workflows/build-v2-spark-worker.yml`将：

1. 运行协议测试；
2. 构建并检查Spark 3.5.9 JAR、包完整性和秘密文件；
3. 上传仅保留1天的GitHub构建产物，供受控云验证。

2026-09-19首次真实运行`35427706320`在GitHub Linux Runner完成Python3.10哈希依赖安装、协议测试、Spark3.5.9 JAR检查、秘密文件检查和短期Artifact上传。ZIP为318,451,671字节，GitHub记录摘要`sha256:a2becee6…c3133`并设置1天到期；该产物仅用于受控云验证，不提交Git。Node24 Action升级后的运行`35428122388`同样成功且弃用告警消失，但相同大小的包摘要变为`sha256:e4afa3b2…c38e`，暴露ZIP时间戳/扩展属性导致的不可复现问题。构建脚本已改为固定1980时间戳、字节序排序并去除ZIP扩展属性；需由两次独立Linux构建摘要完全一致后，才把W1升级为“可复现”。

## 目标FC规格（待账号核验）

- 独立函数，不与V2控制面共进程；
- Custom Debian 10，使用内置Node20和Python3.10；
- Java17公共/自定义层的ARN和`JAVA_HOME`通过账号CLI核验后填写，不猜测路径；
- 1 vCPU、2GiB内存、实例并发1、最大实例1、最小实例0；
- 无公网出站需求；临时目录`/tmp`，运行后删除输入/输出；
- Worker触发器不得匿名公网开放；控制面使用受保护调用路径；
- 共享密钥只存云秘密配置，控制面和Worker两端一致，仓库不保存。

环境键：`V2_SPARK_WORKER_SECRET`、`V2_SPARK_WORKER_RUN_TIMEOUT_MS`、`V2_SPARK_WORKER_MAX_BODY_BYTES`、`V2_SPARK_WORKER_MAX_SKEW_MS`、`V2_ARTIFACT_ROOT=/tmp`、`V2_RETAIN_SPARK_ARTIFACTS=false`、`V2_PYTHON`、`JAVA_HOME`、`PYTHONPATH=/code/python`。

## 分级验收

| 等级 | 门槛 | 当前状态 |
|---|---|---|
| W0 协议 | HMAC、篡改、重放、白名单、大小、超时、错误结果 | 已本机验收 |
| W1 Linux包 | Python3.10构建、哈希依赖、ZIP<480MiB、Spark3.5.9 JAR | 已真实构建；可复现摘要修复待双构建复验 |
| W2 云健康 | Java/Python/Spark可启动，私网/函数鉴权，最小实例0 | 待真实FC |
| W3 单任务 | 标杆SQL+测试SQL+五回归真实执行，控制面保存结果 | 待真实FC |
| W4 故障恢复 | 篡改、超时、取消、并发、Worker冷启动和失败重试 | 待真实FC |
| W5 公网E2E | 受邀用户从需求到发布监控，至少20条且≥85% | 待公网评测 |

只有W2—W4通过后，控制面设置中的Spark才可显示“云端已验证”；只有W5通过后，才可把本机完整E2E结论升级为公网结论。
