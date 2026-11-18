# 数据质量：非空检测与恢复证据

当前为虚构证券数据的本机实际行检测，JavaScript在CSV／SQLite／已登记资产行上计算规则结果，不以固定质量评分代替检测，不代表Spark或云端质量验收。

## 结果含义

- `PASSED`：实际非空数据全部满足本次规则，计数一致，才可作为规则健康和告警恢复依据。
- `FAILED`：至少一行未满足规则，保存失败计数与有界行摘要，不把业务行送入质量Agent。
- `NO_DATA`：实际读到0行，没有可验证的行；`passRate=null`，显示“无数据待核验”，保持原告警状态。非空预期需要另外定义，空数据本身不自动视为所有行约束失败。
- `UNCONFIRMED`：历史通过回执的实际执行或计数证据不足，不能当成健康或恢复。

不存在的字段与显式undefined按缺失处理：非空、唯一、范围、枚举和时效检测都不能因此通过。枚举规则中，实际null不能伪装成文本“null”；字面文本仍按允许值配置比较。唯一规则保留原有null重复策略，是否必填由非空规则单独约束。

## 版本、批次与历史

规则初建和新版本都为待检测，不继承旧版本的通过。每次运行保留原ruleVersionId、配置摘要、资产摘要及可用资产版本；已核对同步来源另存syncRunId和metadataVersionId。来源未核对时不补造同步批次，旧未记录字段也不从当前资产补历史。

页面按每次原版本、同步批次和数据摘要回看。健康摘要表示最近一次当前规则版本的检测结论，不代表实时持续监控或完整证券业务正确率。

旧0行PASSED回执只读解释为NO_DATA，返回storedStatus=PASSED与QUALITY_LEGACY_EMPTY_PASS，保留原存储值；其他缺证据通过为UNCONFIRMED。原RESOLVED告警若没有同规则非空通过证据，显示OPEN及recoveryUnconfirmed，保留storedStatus。读取不会改写旧回执或启动检测。后续实际非空通过可恢复该告警，并用previousRecoveryRunId保留原不足的恢复编号。

运维自动关联和人工提供恢复证据都要求实际非空通过；旧空表不会计入质量成功活动或解除事故。

## 多端与使用

GUI、CLI、MCP共用现有规则API：POST `/quality/rules/:id/run`保存检测，GET `/quality/rules`和`/quality/overview`回看；相同请求编号和证据返回原回执，不自动新增检测。CLI `shuduo quality run --id RULE_ID`、`quality list`／`overview`；MCP `quality_rule_run`／`quality_rule_list`／`quality_overview`。

复现例：证券代码非空规则，原有一行代码为空会失败；后续同步移除security_code，两行缺字段仍失败。空落地表检测为NO_DATA、原告警仍开放；补回非空正确证券代码并显式检测后才恢复。

CSV源目前拒绝仅表头文件。空数据验收使用实际SQLite空落地状态，不宣称已通过真实MySQL空快照接入。原发布冻结质量回执保留现有非空协议；本次未扩展到任意归档数据选择或云端调度。

规则的参数与版本可在[手工配置编辑器](quality-rule-editor.md)维护。恢复还需原资产、字段与规则类型一致，更换类型的新通过不自动解除原类型告警。
