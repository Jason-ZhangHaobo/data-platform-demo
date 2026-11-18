# 五类质量规则的手工配置与版本保存

当前本机虚构证券范围，复用实际行检测引擎。创建、保存和读取规则都不自动调用模型、检测数据或恢复告警。

## 配置

- 数值范围：可编辑最小/最大值，按两位小数精确比较上下界。
- 非空、唯一：无额外参数。非空检查null、空字符串和缺失字段；唯一仍按单字段检测。
- 允许值：每行一项，空格保留、重复项合并，空字符串单独勾选。最多30项，每项80字符。旧版本若含值内换行，使用JSON数组编辑，避免拆分或丢值。
- 时效：可编辑1—2678400秒。检查时间是否早于“检测时刻减阈值”；当前规则不约束未来时钟偏移。

新建表单和版本编辑共用同一配置组件；切换规则不把别的规则参数带入。首次载入选择可读取资产，资产或字段暂不可读时保留选择并提示重新选择。

## 版本审阅与冲突

展开版本编辑时保留基准版本。可以修改已登记字段、规则类型、参数和说明；资产绑定保持。未修改时禁止重复建版，新版本只成为待检测状态。

保存携带expectedVersionId，当前规则已被其他操作更新时返回QUALITY_RULE_VERSION_CHANGED；草稿保留，不退休当前版本或新增版本。重读只刷新目录，不换掉已编辑草稿；“载入当前版本（替换草稿）”为显式采用当前参数。实际检测也携带已读取的版本，避免按未审阅的新配置执行。

更换字段或规则类型后，新结果通过不代表旧告警修复。质量与运维恢复都要求同一规则、资产、字段及类型下的实际非空通过；同类型阈值校准可关联原告警。其他变更须保留原问题另行处理。

## 保存结果未知

保存使用独立请求UUID。响应损坏/丢失时先GET查找原请求，不能换编号直接重建。原请求回执指向实际保存版本，后续V3不会把原V2回执改成V3。

页面链接只保留规则与请求编号，不放配置值；刷新后读取该保存回执，不自动保存。页面内保留原草稿及请求，未找到回执时可用原编号显式重试。代码编辑、业务发布或质量检测均不会被回读触发。

## 多端

- POST `/quality/rules/:id/versions`：可选expectedVersionId；返回versionWrite.versionId/replayed，版本记录含basedOnVersionId。旧调用省略基准时沿用当前版本。
- GET `/quality/rules/:id/version-requests/:requestId`：按原规则/请求只读回读，未找到404 QUALITY_VERSION_REQUEST_NOT_FOUND。
- POST `/quality/rules/:id/run`：可选expectedVersionId，版本变化先拒绝，未执行检测。
- CLI `quality version`支持--field、--expected-version-id和--request-id；`quality version-request --id RULE_UUID --request-id UUID`回读；`quality run`支持--expected-version-id。
- MCP `quality_rule_version`／`quality_rule_run`支持相同基准，`quality_rule_version_request`只读查找。

这些编号不是认证凭证；读写仍走原项目和角色边界，不开放公网写入。实际CSV/SQLite及浏览器验证与正式模型、Spark、云端E2E分开统计。
