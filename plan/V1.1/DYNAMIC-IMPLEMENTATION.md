# 动态概览实施计划

用户已授权按 DYNAMIC-OVERVIEW.md 完整实施。独立在当前分支执行，保留此前未提交的架构与浅色修正，不使用 computer use。

## 目标与实现边界

沿用 overview.md 及版本协议。在新增 TRACKING 标记节的 JSON 围栏保存 schema=1、currentUpdatedAt、goals 与 progress。每条有固定 ID、创建/更新时间；目标状态 active/completed/adjusted，日期可明确未知。旧 GOAL 正文完整保留，网页在创建结构化目标后将旧文折叠为原有目标，不自动推断历史状态。读取不改写文件。

所有写入经过项目队列、实体锁、版本检查、停服/撤权复核和历史失败回滚。目标完成可同时提交阶段成果与最新简报，整份文件及一条历史共同保存。创建要求持久化 key；相同 key 与相同内容重试返回同记录，异内容冲突；标题归一化进一步防止另一客户端重复创建同一成果。旧版 goal 文本不覆盖已建立的结构化目标，需明确报错引导工具。

## 文件和契约

- 新增 src/library/tracking.ts：记录类型、无副作用解析、严格输入与日期校验、创建/状态转换/成果修正、序列化。
- 修改 src/library/service.ts：共用 overview 写入事务；overview_read 附加活动目标、归档数量及进展更新时间。
- 新增双通道 goals 与 progress GET/POST、单记录 PUT。GET 返回 items/total/offset/limit/version，默认分页20，最多100；按完成/调整时间最新在前，未知时间用记录时间排序但不冒充完成时间。
- 新增 MCP goal_list/create/update、progress_list/record/update，写入使用 overview_read 或对应列表的 base_version。goal_update 可带 status、confirmed、occurred_at、replacement_title、current 和 progress 对象；主观目标由 requires_confirmation 标记，Agent 未 confirmed=true 时拒绝完成；网页人类点完成即本人确认。
- 目标调整保留原对象，可在一次保存创建替代目标。已归档目标不直接改写成另一目标；错误的历史日期可明确修正。阶段记录可以修正说明与日期；不提供静默删除。
- 网页 OverviewPage 保留简介/当前进展/目标/功能与用法顺序；新 GoalProgress 组件显示活动目标和默认折叠的阶段、完成/调整历史；展开才加载20条，显示更多分页。最新简报不截断，旧文可找回。目标与成果使用简单的名称/正文/可选日期控件，无负责人或验收表。
- 同步安装源与两端 Skill；明确精准简报、关键成果门槛、先读后写、确认规则、归档/记录工具与日期语义。

## 分步执行与外部验收

- [x] D1：先写 HTTP+磁盘失败用例，再实现记录及服务事务。断言旧文保留、目标归档/替换、精准简报覆盖、实际日期/未知日期、去重、失败回滚、并发冲突、撤权、隔离、分页及重启。
- [x] D2：接通 MCP 工具与参数 schema；实测两种桥接身份同项目读写，未知字段拒绝，工具清单与实现一致。
- [x] D3：实现网页管理、归档折叠与分页、冲突保留输入和明确重读重试；用实际 React 页面的 DOM 操作验证成功/失败及保存结果，不使用浏览器。
- [x] D4：同步内容标准、Skill、用户指南、架构、README、CHANGELOG 和本机已安装文件；核对相对链接闭环。
- [x] D5：重启6421服务，HTTP核对实际网页与资源；通过真实配置MCP整理memmaster目标与本轮阶段成果，独立核对磁盘、HTTP、MCP和变更记录。不声称未进行的浏览器像素检查或真实LLM会话已通过。

验证命令：bun test src/test/library-dynamic.test.ts src/test/library-web-overview.test.tsx 及所有 library-* 回归；bunx tsc --noEmit；bunx biome check 变更TS文件；git diff --check；真实MCP和HTTP验收脚本保留于临时目录。源码构建用 Bun HTML 服务实际编译资源和正式 build 脚本分别核对。

## 交接状态

当前：D1–D5已实现并完成程序化验收。104项library测试通过，类型与格式检查通过；实际构建的程序独立运行后，HTTP返回、目标/成果文件和自动历史一致。6421已更新，真实Codex与Claude Code配置的stdio MCP各自提供25个工具，均可读取同一项目，其中包含6个新增工具。

memmaster原有五项目标已显式整理，旧原文保留；动态概览目标已完成归档并记录本轮关键成果。实际页面DOM连接6421验证当前目标、折叠归档、完整成果说明及新版资源。浏览器像素、响应式视觉与两个真实LLM会话主动接手仍不计为本轮已验证。

下一步：按原TASK-2/3继续真实会话与完整五页体验验收。无实现阻塞。服务6421；项目memmaster=p_b7b809674c；凭据只在进程内读取，禁止输出或提交。

## 实施补充

为支持人类核对冲突和修正历史日期，goals/progress单条也提供GET；列表默认20条，原文保留，不推断历史完成状态。已归档目标可修正日期，方向调整可创建替代目标。最新简报重写、归档和阶段成果可同一写入保存。纯日期按本地日而非UTC日校验，编辑保留未知日期与原时间粒度。
