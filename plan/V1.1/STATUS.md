# V1.1 方案交接

更新时间为 2026-11-05（实施后更新）。

## 当前状态

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
