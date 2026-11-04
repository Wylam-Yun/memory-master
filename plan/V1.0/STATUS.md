# V1.0 · 会话交接状态

## 当前状态（最新在前）

**Phase 2（版本检查 + 变更记录 + 原子写单元）已实现，38/38 library 测试全绿。**
实施文档：`plan/V1.0/PHASE2-PLAN.md`。Phase 1 全部机制保持有效。

- 分支：`feat/v1.0-phase1`（基于 main）
- 测试：`bun test src/test/library-*.test.ts src/test/v1-feasibility.test.ts` → 38 全绿
  （settings + registry + service 13 + history 7 + feasibility）；tsc 干净；biome 无错。
- 关键新机制：
  - 记录版本 = 文件内容 sha256；更新必传 `baseVersion`，否则 400；
    冲突返回 `409 VERSION_CONFLICT` + `{current, version}` 最新值。
  - 变更记录 = `memaster/changelog.jsonl`（ts/actor/target/changes/version），
    web `GET /api/projects/:id/history`、agent `GET /api/agent/projects/:id/history`，
    MCP `history_list`；项目页底部"变更记录"区。
  - 原子性：`ProjectStore.withWriteLock` 串行化项目写；[Core 写→历史追加→失败回滚]
    不可切；测试钩子 `holds.armHistoryFailure()` 确定性复现断点回滚。
  - actor：web=user、agent=已验证 clientId；写入身份即变更记录身份。

## 架构决策（已定，不要再改）

- 存储 = 现有 Markdown/FileSystem/Core，**无 SQLite**（用户明确划掉）。每项目 =
  库目录下独立文件夹 + `memaster/`（filesystemOnly）+ `overview.md` + `资料/`
  + `changelog.jsonl`（阶段 2 起）。
- 写路径走 `Core.createTaskFromInput`/`updateTaskFromInput` + `TaskWriteHooks.preWrite`
  （锁内落盘前：test-holds→stopping→授权重检→版本断言）。不自建写路径。
- 读路径只走 `fs.listTasks`/`fs.loadTask` 直读盘（Core 无 watcher，ContentStore 会陈旧）。
- resolve：精确（id/name/dirname）→ 开；子串模糊 → 409 candidates（含仅 1 个）；0 → 404。
- 入口：`memaster serve`（前台进程=应用生命周期）、`memaster bridge`（stdio MCP 桥，
  env `MEMORY_MASTER_TOKEN`/`MEMORY_MASTER_URL`）、`memaster connect <id>`（打印配置）。
- 授权：`~/.memory-master/settings.json`（0600），`MEMORY_MASTER_HOME` 可覆盖；
  撤权持久化先于返回 → 重检必拒。
- 安全：Host 白名单（127.0.0.1/localhost/[::1]）挡 DNS-rebinding；overview 写走
  task 锁 + SECTION sentinel 行校验。
- 端口：settings.port 首选（默认 6420），冲突回退并持久化新端口；`/api/service` 返回实际 port/url。
- **并发**：项目写互斥（`ProjectStore.withWriteLock`）；版本检查双点（mutex 入口 +
  preWrite 锁内重检）；回滚快照在 Core 写之前取（顺序曾踩坑）。
- **更新必传 baseVersion**——Phase 1 时代的裸 PUT 示例全部要带版本。

## 架构决策（已定，不要再改）

- 存储 = 现有 Markdown/FileSystem/Core，**无 SQLite**（用户明确划掉）。每项目 =
  库目录下独立文件夹 + `memaster/`（filesystemOnly）+ `overview.md` + `资料/`。
- 写路径走 `Core.createTaskFromInput`/`updateTaskFromInput` + 新 `TaskWriteHooks.preWrite`
  （锁内落盘前调用：test-holds + 授权重检）。不自建写路径。
- 读路径只走 `fs.listTasks`/`fs.loadTask` 直读盘（Core 无 watcher，ContentStore 会陈旧）。
- resolve：精确（id/name/dirname）→ 开；子串模糊 → 409 candidates（含仅 1 个）；0 → 404。
- 入口：`memaster serve`（前台进程=应用生命周期）、`memaster bridge`（stdio MCP 桥，
  env `MEMORY_MASTER_TOKEN`/`MEMORY_MASTER_URL`）、`memaster connect <id>`（打印配置）。
- 授权：`~/.memory-master/settings.json`（0600），`MEMORY_MASTER_HOME` 可覆盖；
  撤权持久化先于返回 → 重检必拒。
- 安全：Host 白名单（127.0.0.1/localhost/[::1]）挡 DNS-rebinding；overview 写走
  task 锁 + SECTION sentinel 行校验。
- 端口：settings.port 首选（默认 6420），冲突回退并持久化新端口；`/api/service` 返回实际 port/url。

## 文件清单

- `src/library/`：types, settings, registry, overview, project-store, service, test-holds,
  **history**（阶段 2：changelog.jsonl + contentVersion + diffFields）
- `src/library-web/`：index.html, main.tsx, App.tsx（四页内联 + 时间线区）, api.ts
- `src/mcp/library-bridge.ts`；`src/cli.ts`（serve/bridge/connect 命令）
- `src/core/memaster.ts`：`TaskWriteHooks` + 两处 `preWrite` 挂点
- `src/types/index.ts` + `src/file-system/operations.ts`：config `projectId`/`workingDir`
- 测试：`library-settings/registry/service/history.test.ts` + `v1-feasibility.test.ts`

## 下一步

1. git commit 阶段 2（分支 feat/v1.0-phase1）
2. 真机验收演示阶段 2 四场景（history 测试逐条可重放；外加 curl 冒烟）
3. 后续阶段：决定事项+短指令+真实客户端（3）、上传资料+一键配置（4）、DMG（5）

## 已知边界 / 未做

- `loadLibraryProject` 对坏 config 仍静默跳过该目录（评审 M7 完整版未做）。
- **授权边界**：`/api/*`（web 通道）要求 per-process 会话密钥 `webKey`——只经
  `memaster serve` 终端打印的 `?k=` URL 分发，不落盘、不经任何 HTTP 接口发放；
  服务重启即轮换。`/api/agent/*` 用各客户端凭据。两条通道凭据互不通用，
  停用客户端后它经任何 MM 接口都无法读写。残留边界：同 UID 进程若能读
  用户终端 scrollback/浏览器存储可窃取密钥——但直接读项目文件更省事，
  同权限进程本就在边界外。
- 双实例已防（`~/.memory-master/service.lock` + stale 检测）；跨进程改动也已同步
  （assertAuthorized 前按 mtime 重读 settings）。
- 停服语义已定义：`stop()` 同步置 `stopping` → drain 在途请求；`preWrite` 重检
  命中 stopping → 取消，**未提交的写永不落盘**。已过 preWrite 的 µs 级写入会完成。
- `ProjectPage.advance` 推进按钮硬编码 [To Do/In Progress/Done]，未读 config.statuses。
- `memaster` 需在客户端 PATH（connect 打印的 command 是 `memaster`）；dev 环境可改
  配置为 `bun <repo>/src/cli.ts`。
- 撤权重检→落盘之间残留 µs 级窗口（评审已接受，文档化）。
- bridge 10s 超时后服务端写可能已落盘（错误文案已提示"先核查再重试"）。

## 评审修复记录（commit a1dd1c92）

独立 review 发现 4 Major 已修：overview whole-line marker 解析（修子串注入腐蚀）、
mutating 路由强制 application/json（封 CSRF simple-POST 面）、服务边界拒 Draft
（demote 旁路绕过 preWrite）、waitForWaiter 让挂起写验收不再是空转通过。
Minor 已修：缺 overview.md 先建再锁、createProject 自校验防悬挂 ID、拒 `/` 库根、
字符串强校验、锁冲突→409、settings chmod 前置、bridge 超时文案、IPv6 Host、
App 瞬断显示重试而非 Setup 页。
