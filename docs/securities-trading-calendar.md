# 证券交易日历与新交付文件

## 已实现范围

本机“调度与发布”可预检沪深A股交易日、前后交易日及T+1业务日期，并明确选用一个登记版本生成新SQL交付包。API、CLI、MCP共用相同解析器；读取和预检不启动计算，不创建定时器或发布。

当前登记版本为`20261119.1`，覆盖2025-01-01至2026-12-31。日历按周一至周五减去所列交易所休市日期推导，标记为`EXCHANGE_NOTICE_DERIVED`，不是实时交易所数据服务。调休周末仍休市，不能套用行政工作日。例如2026-02-24的前一交易日为02-13，2026-01-05的前一交易日为2025-12-31。

日级事实来源：

- [上交所2025年休市安排](https://www.sse.com.cn/disclosure/dealinstruc/closed/c/c_20241223_10767110.shtml)、[上交所2026年休市安排](https://www.sse.com.cn/disclosure/announcement/general/c/c_20251222_10802507.shtml)。
- [深交所2025年休市安排](https://www.szse.cn/disclosure/notice/general/t20241223_611283.html)、[深交所2026年休市安排](https://www.szse.cn/disclosure/notice/t20251222_618087.html)。
- 周末规则：[上交所交易规则](https://www.sse.com.cn/lawandrules/sselawsrules2025/stocks/exchange/c/c_20260424_10816482.shtml)、[深交所交易规则](https://docs.static.szse.cn/www/lawrules/rule/trade/current/W020260424690713155663.pdf)。

代码内只保存日期事实、来源链接和版本元数据，不复制公告全文。不包含后续临时调整、个股停牌、港股通、基金开放日、清算交收或日内交易时段，不能据此声称已完成生产日历接入。

## 使用与冻结

1. 本机打开“调度与发布”，选择市场和计划日期。春节、跨年与调休周末有快捷预检。
2. 查看覆盖、摘要、公告日期及原文；点击“选用此版本生成新文件”。只是选日历，不是批准业务发布。
3. 选择真实Spark执行并核验通过的原SQL运行，生成新的八文件包。`calendar.json`采用`shuduo-calendar/v2`，包含完整日期及来源引用；manifest继续逐文件绑定摘要。
4. 调度解析使用包内同一版本。即使重算manifest，日期或来源与登记版本不一致仍拒绝。首次覆盖的交易日若缺前一交易日，T+1不具备条件；2027等覆盖外日期不能推断。

原默认样例`shuduo-calendar/v1`、旧文件、旧演练与批准保持原语义。当前选择开放于本机经典SQL及[原生SQL Agent新交付](agent-calendar-delivery.md)；持久远程Agent、Python、基金专用及云发布的日历选择未适配，不自动换用。生成时只复用已有执行证据，不能把文件生成计为新Spark或完整Agent成功。跨年业务数据也不会因选日历而自动补齐。

版本ID不可原地替换。未来登记新年度或更正时新增ID与版本，保留旧定义供旧包核验；经重新生成、演练、人审才可发布新包。单纯升级软件不能替换已批准版本。

## 多端契约

所有路径相对于`/api/v2`；仅本机开发回环、无云入口的范围开放。

- `GET /calendars`：市场、版本、覆盖、摘要与来源；不写业务状态。
- `GET /calendars/:id`：完整登记日期及来源。
- `GET /calendars/:id/resolve?date=YYYY-MM-DD&calendarDigest=SHA256`：日级只读预检；摘要可选，GUI生成前必须带摘要。未知ID404、过期摘要409、无效日期或覆盖外422；拒绝额外或重复查询参数。
- `POST /delivery/packages`：原请求体可增`calendarSelection:{calendarId,calendarDigest}`，必须两项齐全。相同幂等编号及相同请求回读原包；更换日历或名称须使用新编号，冲突时不新增制品。

```sh
shuduo calendars list
shuduo calendars show --id sse-equities-2025-2026-v1
shuduo calendars resolve --id sse-equities-2025-2026-v1 --date 2026-01-05
shuduo delivery create --source-run-id RUN_ID --name '虚构客户持仓T+1' --calendar-id sse-equities-2025-2026-v1 --calendar-digest CALENDAR_SHA256
```

MCP工具为`trading_calendar_list`、`trading_calendar_detail`、`trading_calendar_resolve`，以及原`delivery_package_create`的可选`calendarSelection`；不新增执行或发布授权。

## 验收证据与剩余工作

`test/v2/trading-calendar.test.mjs`独立核对两年节假日、调休周末、跨年、覆盖边界、摘要冲突、返回值隔离、重新哈希篡改、默认包兼容、幂等制品写入及GUI客户端／CLI／MCP一致性。

本机真实浏览器复用了此前实际Spark通过的原持仓运行，只生成一个新日历包；核对旧八文件不变、市场切换、覆盖外清除旧结果、刷新无重提以及桌面／窄屏无溢出。本轮无新模型、Spark或云操作。该文件功能不计正式20例E2E；部署及新包按文件计算、审阅、发布仍各需自己的真实验收。

后续范围是持久远程Agent/Python/基金专用选择、日历年度维护及目标环境适配，不在当前源码交付中宣称完成。

## Agent内的原包调度预检

已有交付的独立Agent可在文件预览前直接查看“这份交付会加工哪一天？”。默认按原冻结业务日查找包内下一交易日，显示原调度时刻、实际对应业务日、有限样例／公告推导日历及覆盖、部署适配器和三个依赖步骤。用户可以更换日期做只读对照；此处不修改文件或已批准调度。

原包只有三天样例时，仍严格按这三天判断，不采用当前新增的年度日历补足。日期对应另一业务日时标记不一致；休市、覆盖外、缺前一交易日或无下一交易日分别呈现。日期匹配也只证明原包的日期关系，不能替代运行环境、按文件演练、人审或发布。

`GET /delivery/packages/:id/schedule-preview?packageDigest=SHA256&scheduledFor=YYYY-MM-DDT09:00:00%2B08:00`要求完整原包摘要，时点可省略以查看冻结输入的建议时点。先核对原来源账号权限、摘要与完整保存文件，再返回`shuduo-frozen-schedule-preview/v1`；不创建任务、运行、审批或制品。游客401、其他工程师／无权限成员403，原属人及授权管理员可读取。参数额外／重复／格式错422，摘要不符409。包损坏不能只凭编号或摘要展示正向结果。

CLI使用`shuduo delivery schedule-preview --id PACKAGE_ID --package-digest SHA256 [--scheduled-for YYYY-MM-DDT09:00:00+08:00]`；MCP为`delivery_schedule_preview`，GUI/API/CLI/MCP共用同一回执校验。缺字段、错版本、错时点或与冻结业务日矛盾的乐观回执均拒绝。页面换日期／包或读失败后清除旧结果，明确重读恢复；不会因刷新重复提交。

验收新增`test/v2/frozen-schedule-preview.test.mjs`，并扩展邀请只读隔离测试；实际原生Agent浏览器复用已有Spark通过包，只读验证错业务日、休市、原覆盖外、响应损坏后的清旧／恢复及窄屏。原包和八文件不变，模型／Spark／云操作为零，不计正式20例。
