# V1.1 方案交接

更新时间为 2026-11-05（实施后更新）。

## 当前状态

[动态概览改造](DYNAMIC-OVERVIEW.md)已实现：目标独立维护和完成/调整归档，阶段成果记录、修正与分页，精准最新简报，网页及6个新增MCP工具，两端Skill均已接通。104项library测试、类型/格式检查及实际构建程序的HTTP+磁盘+历史验收通过。6421服务已更新，真实两端MCP配置均读到同一份状态；实际页面DOM的折叠历史与完整说明已核对。详见[DYNAMIC-IMPLEMENTATION.md](DYNAMIC-IMPLEMENTATION.md)。

下一步仍是完整五页视觉验收和真实LLM会话主动接手；未使用computer use，不把程序化或MCP桥接核对说成这些验收已完成。

**R1–R3 已在分支 `feat/v1.1-project-workspace` 实现**（基线 `86f3e07a`），经独立设计评审与独立 code review 两轮修正。R4（真实用户多 Agent 验收）尚未做，需用户在真实环境验收五页、双端 Agent 与安装。

已实现：
- **R1**：概览四节（新「功能与用法」）；任务 P0/P1 优先级（老项目懒迁移补 `priorities:` 配置，读取不改写）；`memaster/architecture.md` 版本化项目架构（web+agent 双通道、乐观并发、首建失败回滚到未创建态）；`GET /api/projects/:id` 元信息（statuses/doneStatus/p0/p1）；web 通道单文件资源读取；MCP `architecture_read`/`architecture_write`、overview_write+features、task_*+priority；问题 API 保留兼容、描述去掉网页承诺。
- **R2**：`src/library-web/` 重写为五页（概览/任务/项目架构/资料+文件名点击阅读/变更记录）+ 侧栏壳（≥960px）/顶栏菜单（<960px）；任务只显示 P0、勾选写 doneStatus；编辑草稿跨页保留、409 冲突面板；Markdown 渲染沿用 strict mermaid + HTML 文本化。
- **R3**：`src/library/agent-content/` 六个安装真理源（SKILL+CONTENT-STANDARD+ARCHITECTURE-FORMAT+ARCHITECTURE-SKILL+UPSTREAM+UPSTREAM-LICENSE）；`installSkill` 全量安装（installed=8）；客户端短指令改为七条新规则（不再引导 question_ask，决策在对话内提问）。

独立评审修复要点：历史页改为取最新 N 条（原实现误取最旧）；组成行按 `id||name` 选中；版本与内容单读防 TOCTOU；create 路径优先级迁移前重跑撤权闸；同名资源上传回滚恢复旧字节（原为删除）；资源读取拒绝 symlink；上传按钮可键盘操作。

验证：新增 `src/test/library-v11.test.ts`（16 用例）+ `library-web-helpers.test.ts` 全部黑盒断言磁盘终态/HTTP/MCP；全量 `bun test --timeout=15000` 见提交说明；`bun --check` 595 文件零错；`bun scripts/build.ts` 通过；前端 agent 做过真服务冒烟（全端点实测）。

## 下一步

R4 验收：真实 Codex/Claude Code 安装→连接→读写→人+Agent 协同走查（按 SPEC R4 清单）；浏览器人工核对响应式断点与 200% 缩放；DMG 发布后验证属发布期工作。

## 已知验证情况

- 浏览器内逐页点击的人工验收与宽度断点未人工核对（自动冒烟覆盖端点级）。
- `bun test`（默认 5s 超时）下若干 CLI 子进程/git 测试因环境负载超时——用 `--timeout=15000` 重跑为准；与本次改动无关（未触相关代码）。

## 环境关键事实

- 实现基线 `86f3e07a` → 分支 `feat/v1.1-project-workspace`。
- 存储：Markdown 为权威；`memaster/` 下 overview.md（四节标记）、architecture.md、changelog.jsonl、tasks/、`资料/`。
- 版本契约：写必须带读到的 version；架构缺失文件 version = 空内容哈希。
- 任务完成态 = config.yml `statuses` 末位（勿硬编码 "Done"）；P0 值经 normalize 为小写 `p0`。
- `?raw` 导入不可用——Markdown 文本用 `with { type: "text" }`。
- memaster 板有 TASK-2/3/4 追踪三段实施。
</content>

## 2026-11-05：架构页阅读修正

组成表在原位置显示为一份职责说明，不再与底部折叠列表重复。职责常显，补充信息按需展开；图节点定位并短暂突出说明，编辑预览一致。同步Skill安装源与本机Codex/Claude Code标准，已通过MCP清理memmaster架构里的测试过程文字。

62项相关测试、类型检查、格式检查通过；6421服务已重启，HTTP核对新版资源及真实项目数据，独立核对磁盘和自动变更记录。未使用computer use，浏览器视觉、完整五页及另一真实客户端接手仍不计为已验收。详见[本次修正记录](ARCHITECTURE-READING-FIX.md)。

## 2026-11-05：修正系统深色偏好下的黑底正文

固定浅色的项目空间与自动跟随系统主题的Markdown组件发生冲突。现已在页面与正文组件声明浅色，正文外层和预览层背景透明、文字继承页面，覆盖概览、架构、资料及预览。上一轮漏测的系统深色场景已由加载真实依赖CSS的回归测试覆盖。64项相关测试、类型检查与格式检查通过；6421服务已重启，HTTP核对新的页面、脚本和样式成功。未使用computer use，未进行浏览器视觉验收。
