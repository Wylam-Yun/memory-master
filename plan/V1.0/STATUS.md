# V1.0 Phase 1 · 会话交接状态

## 当前状态（最新在前）

**Phase 1 实现已完成并通过全部新增测试 + 无回归。** 待提交。

- 分支：`feat/v1.0-phase1`（基于 main）
- 测试：`bun test src/test/library-*.test.ts src/test/v1-feasibility.test.ts` → 32 全绿
  （settings 7 + registry 7 + service 14 + feasibility 4）；`bun run check` 0 错；
  `bun --check` 干净；全量套件后台跑过无失败。
- SPA bundle 冒烟通过：`/` 返回 200 + JS bundle 正常构建。

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

- `src/library/`：types, settings, registry, overview, project-store, service, test-holds
- `src/library-web/`：index.html, main.tsx, App.tsx（四页内联）, api.ts
- `src/mcp/library-bridge.ts`；`src/cli.ts`（serve/bridge/connect 命令）
- `src/core/memaster.ts`：`TaskWriteHooks` + 两处 `preWrite` 挂点
- `src/types/index.ts` + `src/file-system/operations.ts`：config `projectId`/`workingDir`
- 测试：`library-settings/registry/service.test.ts` + `v1-feasibility.test.ts`

## 下一步

1. git commit（分支 feat/v1.0-phase1）
2. CHANGELOG（仓库无 CHANGELOG 文件——SPEC 要求文档同源，已在 README 记新能力）
3. 真机验收演示（SPEC 五行场景，对应 service 测试逐条可重放）
4. 后续阶段：版本/变更记录（2）、决定事项+短指令（3）、上传+一键配置（4）、DMG（5）

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
