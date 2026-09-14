# V2 阿里云部署说明

日期：2026-09-15。状态：代码包与手动工作流已准备；Linux CI、真实资源预检和部署尚未执行。

## 为什么单独打包Node 24

V2使用`node:sqlite`作为本机和首个云试点的同步索引。阿里云FC目前列出的内置Node运行时最高为Node 20，而自定义Debian 12允许随代码包携带Linux x64解释器并配置启动命令。因此V2包自带Node 24，不依赖旧函数的`/var/fc/lang/nodejs20/bin/node`。

官方依据：

- [阿里云FC自定义运行时](https://help.aliyun.com/zh/functioncompute/custom-runtime/)
- [CreateFunctionInput运行时、角色与实例并发参数](https://help.aliyun.com/zh/functioncompute/api-fc-2023-03-30-struct-createfunctioninput)
- [FC代码包和运行资源限制](https://help.aliyun.com/en/functioncompute/limits-of-usage)
- [FC环境变量与函数角色临时凭证](https://help.aliyun.com/zh/functioncompute/environment-variables)

## 包内容与门禁

`scripts/build-v2-fc-package.sh`只能在Linux x64运行，要求Node 24以上，输出路径只能位于仓库根或`/tmp`且拒绝覆盖已有ZIP。包内只包含：

- Linux x64 Node 24解释器；
- `src/`、构建后的`web-dist/`和仓库内虚构证券`fixtures/`；
- `deploy/v2/package-lock.json`锁定的mysql2及传递依赖；
- 不包含`.env`、`.env.local`、PEM或Key文件。

ZIP超过70MiB即失败，以避开FC API Base64后总请求100MB限制。GitHub主CI会在Linux实际构包并验证解释器平台、`node:sqlite`、入口、网页和fixtures。

## 部署工作流

`.github/workflows/deploy-v2-staging.yml`只能手动触发，且使用独立GitHub Environment `v2-staging`。它不会修改现有V1函数；目标函数默认为`dataplatform-v2-staging-api`，必须先由账号内操作预创建。

工作流顺序：全量CI → 构建/检查ZIP → 校验配置 → GitHub OIDC换取阿里云临时身份 → 确认独立函数存在 → 更新代码与配置 → 验证HTTPS状态、MySQL/OSS健康、公开页面和匿名写入401。

运行变量：

- `V2_FUNCTION_NAME`、`V2_PUBLIC_URL`、`V2_PUBLIC_ORIGIN`、`V2_OSS_BUCKET`
- OSS状态对象和不可变产物前缀由工作流固定为项目隔离路径，不接受页面输入

运行秘密：

- `V2_MYSQL_HOST`、`V2_MYSQL_PORT`、`V2_MYSQL_USER`、`V2_MYSQL_PASSWORD`、`V2_MYSQL_DATABASE`
- `V2_BOOTSTRAP_ADMIN_EMAIL`、`V2_BOOTSTRAP_ADMIN_PASSWORD`、`V2_BOOTSTRAP_ADMIN_NAME`
- `DASHSCOPE_API_KEY`
- 可选隔离执行：变量`V2_SPARK_EXECUTOR_URL`与秘密`V2_SPARK_EXECUTOR_SECRET`；Worker未完成真实验收前保持为空

秘密只进入GitHub受保护Environment和FC加密环境变量；仓库、日志和构建产物不保存值。函数角色负责注入临时OSS凭证，不创建或手填长期AccessKey。

## 首次云预检

在运行工作流前必须只读确认：

1. RDS规格、状态、到期/试用信息、VPC、内网地址及当前账单；
2. 独立平台数据库和最小权限账号是否存在，不复用`business_demo`业务账号；
3. 私有OSS Bucket地域、版本/生命周期和FC角色的对象权限；
4. 独立FC函数运行时、VPC、角色、HTTP触发器、实例并发1和公网HTTPS URL；
5. 以上资源在月度200元总预算内。

预检不足时不触发部署。当前已打开阿里云Cloud Shell登录页，登录完成后优先通过CLI执行只读核验。

## 仍然关闭的能力

公网函数已有远程Spark客户端和Worker协议，但尚无通过真实云验收的Java/PySpark执行资源，所以`publicReady=false`必须保持。公开浏览和受邀控制面可以先灰度，任意代码/SQL执行不能因协议测试或页面可点击就开放；执行层完成后另做私网/函数鉴权、故障、超时、权限、成本和回滚验收。

Worker运行时、Spark 3.5.9安全升级、大包构建和W0—W5门槛见[隔离Spark Worker](isolated-spark-worker.md)。
