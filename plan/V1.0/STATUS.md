# V1.0 · 会话交接状态

## 当前状态（最新在前）

**Phase 3+4（待决定事项 + 一键客户端配置 + 连接门控 + 项目资料）已实现，52/52 library 测试全绿。** Phase 1–2 全部机制保持有效。Phase 5（DMG）未做。

- 分支：`feat/v1.0-phase1`（基于 main）
- 测试：`bun test src/test/library-*.test.ts src/test/v1-feasibility.test.ts` → 52 全绿
  （settings 7 + registry + service 13 + history 7 + phase34 7 + feasibility）；tsc 干净；biome 0 错。
- Phase 3 新机制：
  - 待决定事项 = `memaster/questions/question-N - slug.md`（frontmatter：id/title/status/
    task/asked_by/asked_date/answer/answered_by/answered_date + body detail）。
  - web/agent 同一路由族 + 同一写入单元；回答 = 一次性写（Open→Answered），二次回答 409。
  - 历史记录 question create/update，actor 区分 user/codex/claude-code。
  - `agent-content.ts` = 短指令 + Skill 单一真源；`/api/agent/instructions` 下发，
    安装器与 connect 同源渲染。
- Phase 4 新机制：
  - 一键配置：web 启用 → `ensureToken` → `installClient`（MCP 配置 + 指令块 + Skill）
    → `markConfigured`；失败 → 502 + `installError` + 设置页重试按钮。
  - 安装器：Claude=`~/.claude.json` JSON 合并 + `~/.claude/CLAUDE.md` 受管块 +
    `~/.claude/skills/memory-master/SKILL.md`；Codex=`~/.codex/config.toml` marker 守卫
    TOML 块 + `~/.codex/AGENTS.md` 受管块 + `~/.codex/skills/memory-master.md`。
    用户已有内容全部保留；重复启用幂等（受管块替换不追加）。
  - bridge 命令用 `process.execPath` + 绝对 `cli.ts` 路径，不依赖 PATH 上的 memaster。
  - `MEMORY_MASTER_CLIENT_HOME` 重定向安装目标（测试/验收必用，别污染真实配置）。
  - 连接状态机 `none → configured → connected`：enable≠connected；agent 路由全门控
    （enabled+connected），唯独 `/api/agent/ping` 走探针门（enabled+configured）；
    bridge 启动即发 ping——真实客户端一接入即翻转。
  - 资料 = 项目 `资料/` 目录；web 上传（JSON {name,base64}，10MB 上限）、web/agent 列表、
    agent 读取（文本直返 / 二进制 base64）；basename 白名单挡路径穿越与隐藏文件；
    停用客户端连列表都拿不到（403）。
- MCP 工具新增：`question_ask/question_list/question_get/question_answer`、
  `resource_list/resource_read`。

## 架构决策（已定，不要再改）

- 存储 = 现有 Markdown/FileSystem/Core，**无 SQLite**（用户明确划掉）。每项目 =
  库目录下独立文件夹 + `memaster/`（filesystemOnly）+ `overview.md` + `questions/` +
  `资料/` + `changelog.jsonl`。
- 写路径走 `Core.createTaskFromInput`/`updateTaskFromInput` + `TaskWriteHooks.preWrite`
  （锁内落盘前：test-holds→stopping→授权重检→版本断言）。不自建写路径。
- 读路径只走 `fs.listTasks`/`fs.loadTask` 直读盘（Core 无 watcher，ContentStore 会陈旧）。
- resolve：精确（id/name/dirname）→ 开；子串模糊 → 409 candidates（含仅 1 个）；0 → 404。
- 入口：`memaster serve`（前台进程=应用生命周期）、`memaster bridge`（stdio MCP 桥，
  env `MEMORY_MASTER_TOKEN`/`MEMORY_MASTER_URL`，启动 ping 翻转连接态）、
  `memaster connect <id>`（打印与安装器同源的 mcpServers JSON）。
- 授权：`~/.memory-master/settings.json`（0600），`MEMORY_MASTER_HOME` 可覆盖；
  撤权持久化先于返回 → 重检必拒；**授权≠连接**，双门控见 Phase 4。
- 安全：Host 白名单挡 DNS-rebinding；overview 写走 task 锁 + SECTION sentinel 行校验；
  mutating 路由强制 application/json（挡 CSRF simple-POST）。
- 端口：settings.port 首选（默认 6420），冲突回退并持久化新端口；`/api/service` 返回实际 port/url。
- 并发：项目写互斥（`withWriteLock`）；任务/概览更新必传 `baseVersion`（sha256 内容哈希），
  版本检查双点（mutex 入口 + preWrite 锁内重检）；回滚快照在 Core 写之前取。
- 原子性：历史追加失败 → 回滚记录文件（create 删新文件 / update 写回旧字节），
  `holds.armHistoryFailure()` 确定性复现。

## 文件清单

- `src/library/`：types, settings, registry, overview, project-store, service, test-holds,
  history, **agent-content**（指令+Skill 真源）, **client-setup**（安装器）,
  **questions**, **resources**
- `src/library-web/`：index.html, main.tsx, App.tsx（项目页+待决定事项区+资料区+设置页连接态）, api.ts
- `src/mcp/library-bridge.ts`（15 工具 + 启动 ping）；`src/cli.ts`（serve/bridge/connect）
- `src/core/memaster.ts`：`TaskWriteHooks` + 两处 `preWrite` 挂点
- 测试：`library-settings/registry/service/history/phase34.test.ts` + `v1-feasibility.test.ts`

## 下一步

1. 派三个独立子 agent 评审 Phase 3+4（安全 / 外部配置集成 / SPEC 符合度）
2. 用户在真实 Claude Code / Codex 会话里验收：启用 → 打开客户端 → 桥自动 ping →
   设置页变"已连接" → 按名开项目 → 提问 → 网页回答 → agent 读到
3. Phase 5：macOS DMG 打包（未开始）

## 已知边界 / 未做

- `loadLibraryProject` 对坏 config 仍静默跳过该目录（评审 M7 完整版未做）。
- **授权边界**：`/api/*`（web 通道）要求 per-process 会话密钥 `webKey`——只经
  `memaster serve` 终端打印的 `?k=` URL 分发，不落盘、不经任何 HTTP 接口发放；
  服务重启即轮换。`/api/agent/*` 用各客户端凭据 + 连接门控。两条通道凭据互不通用。
  残留边界：同 UID 进程若能读用户终端 scrollback/浏览器存储可窃取密钥——但直接读
  项目文件更省事，同权限进程本就在边界外。
- 双实例已防（`~/.memory-master/service.lock` + stale 检测）；跨进程改动也已同步
  （assertAuthorized 前按 mtime 重读 settings）。
- 停服语义：`stop()` 同步置 `stopping` → drain 在途请求；preWrite 重检命中 stopping
  → 取消，**未提交的写永不落盘**。
- `ProjectPage.advance` 推进按钮硬编码 [To Do/In Progress/Done]，未读 config.statuses。
- 撤权重检→落盘之间残留 µs 级窗口（评审已接受，文档化）。
- bridge 10s 超时后服务端写可能已落盘（错误文案已提示"先核查再重试"）。
- TOML 安装是 marker 块 upsert，不理解块外 TOML 语义——用户同名 `[mcp_servers.memory-master]`
  手写块与 marker 块并存时后定义者生效（TOML 规范），属可接受边界。
- 资料上传 10MB 上限在服务端强制；同名文件覆盖（无版本管理，资料定位为只读参考物）。

## 评审修复记录

- `a1dd1c92`（Phase 1 review）：overview whole-line marker 解析、mutating 路由强制
  application/json、服务边界拒 Draft、waitForWaiter 确定性挂起写验收；10 个 Minor。
- Phase 2 测试曾抓到回滚快照顺序 bug（快照须在 Core 写之前取）。
