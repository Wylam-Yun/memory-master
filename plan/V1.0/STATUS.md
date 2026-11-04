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
- 双 serve 实例无单实例锁（同端口会失败，改端口双开各自写 settings）。
- `memaster` 需在客户端 PATH（connect 打印的 command 是 `memaster`）；dev 环境可改
  配置为 `bun <repo>/src/cli.ts`。
- 撤权重检→落盘之间残留 µs 级窗口（评审已接受，文档化）。
