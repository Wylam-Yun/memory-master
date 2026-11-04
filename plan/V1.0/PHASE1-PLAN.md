# Memory Master V1.0 · 阶段 1 实施文档

> 面向零上下文的执行者。目标：按 `plan/V1.0/SPEC.md` §5「阶段 1 · 网页交接与权限底座」交付。
> 存储决定（用户 2026-11-04 拍板）：**不引入 SQLite**，项目状态沿用现有 Markdown FileSystem/Core
> （`filesystem_only` 项目），可行性已由 `src/test/v1-feasibility.test.ts` 四条用例验证。

## 0. 总体架构

新增一个 **记忆库服务**（library service）子系统，与既有单项目体系并存，不改动既有命令行为：

```
memaster serve                    ← 新命令：本地应用服务（前台进程 = 应用生命周期）
└─ LibraryService (Bun.serve, 127.0.0.1)
   ├─ AppSettingsStore            ← ~/.memory-master/settings.json（MEMORY_MASTER_HOME 可覆盖）
   │     libraryRoot、port、clients{codex,claude-code: enabled+token}
   ├─ ProjectRegistry             ← 扫描 libraryRoot 下每个项目目录
   │     每项目 = <library>/<name>/memaster/(config.yml+overview.md+tasks/…) + 资料/
   ├─ Core 池                     ← 每项目一个 Core（filesystemOnly，无 git 依赖）
   ├─ Web API /api/*              ← 网页用（localhost，不鉴权）
   ├─ Agent API /api/agent/*      ← Bearer token → 客户端身份 → enabled 检查
   │     写路径：入口检查 → 任务写锁 → 测试挂起点 → 授权重检 → 落盘
   └─ library-web SPA             ← 新网页：选库/项目列表/项目详情/客户端开关

memaster mcp start（MEMORY_MASTER_TOKEN 存在时 = 桥接模式）
└─ LibraryMcpBridge (stdio MCP ↔ Agent API)
      会话内保存已选项目 ID；服务不可达时返回可理解错误

memaster agent <…>                ← 受控测试连接器
      enable/disable/connect/status：管理开关、发凭据、生成/写入客户端 MCP 配置
```

已选项目在桥进程内保持到用户明确切换；项目 ID（写入 `memaster/config.yml` 的 `project_id`）
决定写入落到哪个项目目录。

## 1. 文件地图（新增在左，改动在右）

| 文件 | 职责 |
|---|---|
| `src/library/settings.ts`（新） | 应用设置读写：libraryRoot、port、双客户端 enabled/token；原子写（tmp+rename） |
| `src/library/registry.ts`（新） | 项目注册表：扫描库目录、按名/ID 解析、createProject（memaster 结构 + overview.md + 资料/ + project_id） |
| `src/library/overview.ts`（新） | `memaster/overview.md` 三段（DESCRIPTION/GOAL/CURRENT marked sections）读写 |
| `src/library/service.ts`（新） | LibraryService：Bun.serve 路由总装、Core 池、授权中间件、写门禁、测试挂起点、进程启停（web/agent 处理器内联于此） |
| `src/library/project-store.ts`（新） | 单项目读写门面：包 `Core`（无 watcher），读直走 fs，写走 Core 正规方法 |
| `src/library/types.ts`（新） | LibrarySettings、ClientSlot、LibraryProject、Overview 等类型 |
| `src/library/test-holds.ts`（新） | 确定性写入挂起点（仅 `MEMORY_MASTER_TEST_MODE=1` 启用） |
| `src/library-web/index.html`、`main.tsx`、`App.tsx`、`api.ts`（新） | 新 SPA 入口（独立 Bun HTML bundle；四页：选库/项目列表/项目详情/设置） |
| `src/mcp/library-bridge.ts`（新） | LibraryBridge：MCP SDK Server，工具代理到 Agent API，会话项目状态 |
| `src/cli.ts`（改） | 新增 `serve`/`bridge`/`connect` 命令 |
| `src/core/memaster.ts`（改） | `createTaskFromInput`/`updateTaskFromInput` 增加可选 `TaskWriteHooks.preWrite`（锁内落盘前调用） |
| `src/types/index.ts`（改） | `MemasterConfig` 增加可选 `projectId?: string`、`workingDir?: string` |
| `src/file-system/operations.ts`（改） | config YAML 序列化/解析带上两个新可选字段（仿现有可选字段写法） |
| 测试：`src/test/library-settings.test.ts`、`library-registry.test.ts`、`library-service.test.ts`、`mcp-bridge.test.ts`、`library-acceptance.test.ts` | 见 §6 |
| 文档：README、CLI-INSTRUCTIONS、DEVELOPMENT?、CHANGELOG.md（新建）、AGENTS.md 视需要 | 同源更新 |

## 2. 数据格式

### 2.1 settings.json（应用设置，独立于项目存储）

```json
{
  "version": 1,
  "libraryRoot": "/Users/x/Documents/MemoryMaster",
  "port": 6420,
  "clients": {
    "codex":       { "enabled": true, "token": "mm_codex_<32hex>" },
    "claude-code": { "enabled": false, "token": "mm_claude_<32hex>" }
  }
}
```

- `MEMORY_MASTER_HOME` 覆盖 home（默认 `~/.memory-master/`），测试用它隔离。
- token 在**首次开启**时生成并持久化；关闭只翻 `enabled`，token 保留（复用既有配置）。
- 凭据只标识身份；授权与否以 `enabled` 当前值为准 → "撤销前的会话凭据不能绕过授权"。

### 2.2 项目目录

```
<libraryRoot>/订单系统/
  memaster/
    config.yml        # project_name、filesystem_only: true、project_id、working_dir（可选）
    overview.md       # 三段 marked sections
    tasks/  docs/  decisions/  milestones/  drafts/  archive/
  资料/               # 本阶段建空目录，上传在阶段 4
```

- `project_id`：`p_<10位base36随机>`，创建时写入 config，跨目录移动/改名后仍稳定。
- overview.md：`---\nid: overview\n---\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\n…\n<!-- SECTION:DESCRIPTION:END -->\n` 同款 GOAL / CURRENT 段，复用现有 marker 约定。

## 3. API 契约

### 3.1 Web API（`LibraryService`，无鉴权）

| 方法 路径 | 说明 |
|---|---|
| GET `/api/service` | {version, libraryRoot, libraryRootSet, defaultLibraryRoot, port, url} |
| PUT `/api/library` `{libraryRoot}` | 设定/确认库位置（目录不存在则创建；路径转绝对）；返回新根+项目列表 |

安全边界：所有请求做 Host 白名单（`127.0.0.1`/`localhost`/`[::1]`），其余 → 403，
挡 DNS-rebinding——web API 无鉴权，`/api/clients` 明文凭据必须只对本机可达。
| GET `/api/projects` | [{id,name,dir,workingDir,taskCount}] |
| POST `/api/projects` `{name, workingDir?}` | 建项目 → 201 {id,name,dir}；名重 → 409 |
| GET `/api/projects/:id/overview` | {description,goal,current,updatedAt} |
| PUT `/api/projects/:id/overview` `{description?,goal?,current?}` | 写三段 → 200 |
| GET `/api/projects/:id/tasks` `?status=` | [Task]（复用现有 Task 形状子集） |
| POST `/api/projects/:id/tasks` `{title,description?,status?}` | 201 Task |
| GET `/api/projects/:id/tasks/:tid` | Task |
| PUT `/api/projects/:id/tasks/:tid` `{title?,status?,description?}` | 200 Task；404 不存在 |
| GET `/api/clients` | [{id,label,enabled,token}]（token 明文凭据，本机用） |
| PUT `/api/clients/:id` `{enabled:bool}` | 开：补发/复用 token → {id,enabled,token}；关：即时撤权 → {id,enabled:false} |

错误统一 `{error: string, code?: string}` + 合理状态码。

### 3.2 Agent API（`/api/agent/*`，Bearer 鉴权）

中间件：`Authorization: Bearer <token>` → settings.resolveToken → clientId；
未带/未知 → 401 `{error:"unauthorized"}`；`enabled=false` → 403 `{error:"access disabled for client <id>"}`。

| 方法 路径 | 说明 |
|---|---|
| GET `/api/agent/ping` | {ok:true, client, libraryRootSet}（探测连接用） |
| GET `/api/agent/projects` | [{id,name,workingDir}] |
| POST `/api/agent/projects/resolve` `{name}` | 200 {id,name,dir} / 404 / 409 {error,candidates:[{id,name}]} |
| GET/PUT `/api/agent/projects/:id/overview` | 同 web |
| GET/POST `/api/agent/projects/:id/tasks` | 同 web |
| GET/PUT `/api/agent/projects/:id/tasks/:tid` | 同 web |

**写路径走 Core 正规方法 + `preWrite` 缝**（评审 M1 决策：不自建写路径，避免丢失
状态规范化/注入校验/ID 分配/updatedDate 等既有不变量）：
1. `assertAuthorized(token)`（入口检查，在路由层）
2. `core.updateTaskFromInput` / `core.createTaskFromInput`（内部自行取 task/create 锁）
3. 锁内、落盘前调 `hooks.preWrite`：`await testHolds.waitIfAny()` → `assertAuthorized(token)` 重检
4. Core 落盘

`preWrite` 作为可选 `TaskWriteHooks` 参数加在两个 Core 方法上（`memaster.ts`），
默认不传时行为与原来完全一致。概览写：`withTaskLock({id:"overview",filePath})`
串行化 + 同样的 hold+重检；三段值按 SECTION sentinel 正则拒绝标记行注入（M2）。
读路径只走 `fs.listTasks`/`fs.loadTask` 直读盘，永不触发 ContentStore（无 watcher
会陈旧）（M3）。web 与 agent 写共用同一锁/重检通道（web 侧 token=null 只跳鉴权）。

`PUT /api/clients/:id {enabled:false}`：先翻内存态并持久化 settings，再返回；
与第 4 步的重检构成"撤权返回成功 ⇒ 之后重检必拒"的序。

### 3.3 测试挂起点

`MEMORY_MASTER_TEST_MODE=1`（构造 `TestHolds(true)`）才生效，否则路由返回 404：
- `POST /api/test/holds` `{name}` → `{id}`；`preWrite` 会等所有未释放挂起点
- `DELETE /api/test/holds/:id` → 释放
验收第 4 条用例：开 hold → 发起 task_update（挂起）→ `PUT clients/codex {enabled:false}`（200）→ release → update 返回 403，磁盘保持旧值。

### 3.4 resolve 语义（评审 M4 决策）

精确匹配（project_id / display name / 目录名）→ 直接返回；否则对 name/dirname
做子串匹配，**任何模糊命中（含恰好 1 个）都返回 409 + candidates**，强制调用方
用 ID 或全名显式打开（SPEC「模糊名称要求明确选择」）；零命中 → 404。

### 3.5 端口策略（评审 M5 决策）

`settings.port` 为首选持久端口（默认 6420）；`serve` 冲突时回退
`findNextAvailablePort` 并**持久化新端口**到 settings（`setPort`），保证
`connect` 打印的 URL 稳定。`/api/service` 返回实际绑定 `port`/`url`。

## 4. MCP 桥（独立命令 `memaster bridge`）

决策：桥接是独立子命令而非 `mcp start` 分支——客户端配置直接指向
`memaster bridge`，语义最直白，也不与 `mcp start` 的 repo 项目发现逻辑纠缠。

凭据：env `MEMORY_MASTER_TOKEN` + `MEMORY_MASTER_URL`（默认
`http://127.0.0.1:6420`），或 `--token`/`--url` 覆盖。无 token → 报错退出。
`src/mcp/library-bridge.ts` `LibraryBridge`：薄代理，工具 handler =
`fetch(url,{headers:{authorization}, signal: AbortSignal.timeout(10s)})` →
结果/错误文本；一切鉴权判定都在服务端逐请求发生，桥自身不缓存任何授权结论。
会话状态：`selectedProject: {id,name,dir} | null`（进程内）。

| 工具 | 参数 | 行为 |
|---|---|---|
| `project_list` | — | 列出项目 |
| `project_open` | `{name}`（可传 id） | resolve → 选中；409 → 错误文本列候选要求明确 |
| `project_current` | — | 当前选中或未选提示 |
| `overview_read` | — | 需已选项目 → 三段文本 |
| `overview_write` | `{description?,goal?,current?}` | 需已选项目 |
| `task_list` | `{status?}` | 需已选项目 |
| `task_get` | `{task_id}` | 需已选项目 |
| `task_create` | `{title,description?,status?}` | 需已选项目 |
| `task_update` | `{task_id,status?,title?,description?}` | 需已选项目 |

服务不可达 → 工具返回 `Cannot reach the Memory Master service … Is it running?`
类可理解文本而非堆栈。

## 5. 受控测试连接器（`memaster connect`）

命名决策：不用 `memaster agent`——与既有 `memaster agents`（agent 指令管理）撞名。
`memaster connect <codex|claude-code>` 只**打印**标准 `mcpServers` 配置片段
（command `memaster` + args `[bridge]` + env URL/TOKEN），由用户/测试脚本写进客户端配置；
阶段 4 才做一键自动写入。客户端未启用（无 token）→ 报错并指引先在网页设置页启用。

## 6. 测试与验收映射（SPEC §5 阶段 1 五行 → 断言）

| SPEC 验收行 | 测试 |
|---|---|
| 建库+两项目（一关联工作目录） | `library-acceptance` A：API 建库建项目 → 独立读两项目目录（memaster/config.yml、overview.md、tasks/）+ `readdir` 对照 |
| 无关目录按名开项目、各持所选、歧义需明确 | `library-acceptance` B + `mcp-bridge`：两个桥实例分别 open 两项目、各自改任务；磁盘+网页独立核对只落对的项目；`resolve("系统")` 类模糊名→409 候选列表 |
| 两端开关、撤权后旧+新会话全拒、另一端与网页照常、换端重复 | `library-service`：按客户端分别断言 read/write/list 403；磁盘值=关闭前最后合法值 |
| 提交前挂起→撤权→放行不落盘 | `library-service`：test-hold 确定性复现（见 §3.3） |
| 关网页不停服、停服全拒、重启恢复授权 | `library-acceptance` D：无网页请求下 agent API 读写照常 → `service.stop()` → ping/write 拒绝 → 重启服务 → enabled 态与 token 相同 |

单元层：settings（默认值/原子写/重启恢复/token 生成复用）、registry（建项目骨架/按名解析三态/重名拒绝）、overview（三段读写往返）、写门禁（入口检+锁内重检）、bridge（会话项目保持、未选报错、服务断线文案）。

## 7. 实施顺序（每步独立可验）

1. `library/types.ts` + `settings.ts` + 测试
2. `registry.ts` + `overview.ts` + config 两字段（types+operations 改动）+ 测试
3. `test-holds.ts` + `project-store.ts` + `service.ts` + 服务层测试（含撤权时序）
4. `library-web/` SPA + `cli.ts` 注册 `serve`
5. `mcp/library-bridge.ts` + `cli.ts` 注册 `bridge`/`connect` + 测试
6. `library-acceptance`（SPEC 五行，已并入 `library-service.test.ts` 覆盖）+ 文档同源更新 + 全量回归

## 8. 明确不做（本阶段）

版本检查/冲突/变更记录（阶段 2）、待决定事项与 Agent 短指令/Skill（阶段 3）、
资料上传与一键自动配置（阶段 4）、DMG（阶段 5）、WebSocket 实时推送、
看板/里程碑/文档/决定等完整任务面在记忆库项目的呈现（后续按需挂接现有 SPA）。
