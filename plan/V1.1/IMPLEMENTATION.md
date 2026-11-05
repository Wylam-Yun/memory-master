# V1.1 实施文档（执行用）

基线：`86f3e07a`（main HEAD）。实现范围 = SPEC.md 的 R1（内容与写入能力）+ R2（五页前端）+ R3（Skill 安装），并补齐 R2 需要的项目元信息接口。R4 为用户验收阶段，不在本实施内，但每段按 R1–R3 验收条目自验。

执行者假定对代码库零上下文：以下逐文件给出改动。风格：TypeScript、tab 缩进、biome；注释只解释非显然约束（沿用现有文件头注释风格）。

---

## A. R1 后端：内容与写入能力

### A1 `src/library/types.ts`

- `ProjectOverview` 增加 `features: string`（功能与用法）；相关注释「The three maintained sections」改为四节。

### A2 `src/library/overview.ts`

- `OVERVIEW_SECTION_KEYS`：`["DESCRIPTION","GOAL","CURRENT","FEATURES"]`（FEATURES 追加在末尾；`applyOverviewUpdate` 已按数组顺序自动在文件尾部补齐缺失小节，旧文件兼容自动成立）。
- `SECTION_HEADINGS` 加 `FEATURES: "功能与用法"`；`SECTION_FIELD` 加 `FEATURES: "features"`。
- `readOverview` 返回 `features`（旧文件无此标记 → 空字符串，只读不改盘）。
- `initialOverviewContent` 末尾追加 `renderOverviewSection("FEATURES", "待补充当前可用的能力或交付内容及使用方法。")`，小节顺序保持 简介/目标/当前进展/功能与用法（文件顺序，网页展示顺序由前端决定）。

### A3 新文件 `src/library/architecture.ts`

```ts
import { join } from "node:path";
export const ARCHITECTURE_FILE_NAME = "architecture.md";
export function architectureFilePath(projectDir: string): string {
  return join(projectDir, "memaster", ARCHITECTURE_FILE_NAME);
}
/** 项目架构是一份整体 Markdown（图源+组成说明+核对信息）。缺失按空内容处理。 */
export async function readArchitecture(projectDir: string): Promise<string> {
  const file = Bun.file(architectureFilePath(projectDir));
  return (await file.exists()) ? await file.text() : "";
}
```

- 文件头注释：一份版本化记录，网页与 Agent 共用同一写入单元；关联任务等结构由 Markdown 解析派生，服务端不校验格式。

### A4 `src/library/history.ts`

- `HistoryTarget.type` 联合类型追加 `"architecture"`。

### A5 `src/library/project-store.ts`

- `TaskWriteInput` 增加 `priority?: string`。
- 新 import：`resolvePriorityValue`、`getPriorityValues`（`../utils/priority-config.ts`），`getTerminalStatus`（`../utils/terminal-status.ts`）。
- 新方法：
  - `private async requireConfig()`：`loadConfig()`，null → `LibraryError(PROJECT_NOT_FOUND, "…no readable configuration", 404)`（复用 assertValidStatus 里那段，重构共用）。
  - `assertValidPriority(priority: string): Promise<string>`：effectiveLabels = config.priorities 非空 ? `[...config.priorities]` : `["P0","P1"]`；若 effectiveLabels 规范化后不含 "P0"/"P1" 则追加之（按 normalize 值去重）。`resolvePriorityValue(priority, effective)` → undefined → `LibraryError(VALIDATION, "Invalid priority …Valid priorities: <effective labels 实列>…", 400)`；返回规范化值（小写，如 "p0"）。
  - `ensureTaskPriorities()`：**只在写锁内调用**。effective 同上；若与 config.priorities 不同 → `config.priorities = effective` 并 `filesystem.saveConfig(config)`。注意：`saveConfig`/`serializeConfig` 是已知键整文件重写（注释与未知键丢失、`memaster_directory` 等特殊处理），这是无 history 记录的幂等迁移——对 initializeProject 产出的配置无损，对手工加过自定义键的老配置会丢未知键（评审确认可接受，如实描述）。
  - `projectMeta()`：返回 `{ statuses: string[], doneStatus: string | null, p0: string, p1: string }`；doneStatus = `getTerminalStatus(statuses)`（即 statuses 末位），p0/p1 = `resolvePriorityValue("P0"/"P1", effective) ?? "p0"/"p1"`（effective 保证含 P0/P1，兜底仅为类型收窄）。

### A6 `src/library/registry.ts` `createProject`

- `config.projectId = id` 之后追加 `config.priorities = ["P0", "P1"];`（新项目一出生就是 P0/P1 语义）。

### A7 `src/library/service.ts`

1. imports：`architectureFilePath, readArchitecture`（新文件）；`getTerminalStatus` 等按 A5 需要。
2. `taskInputFrom`：加 `...(typeof body.priority === "string" ? { priority: body.priority } : {})`。
3. `writeTask`：
   - create 分支：`const priority = input.priority !== undefined ? await store.assertValidPriority(input.priority) : "p0";`（前置 400）；锁内 `await store.ensureTaskPriorities()` 后把 `priority` 传进 `createTaskFromInput`；history `changes` 增加 `priority: task.priority`（存在时）。
   - update 分支：`input.priority !== undefined` → 前置 `assertValidPriority`；锁内 `ensureTaskPriorities()` 后传 `priority`；`diffFields` 的 before/after map 增加 `priority`（before.priority 可能 undefined）。
4. `writeOverview`：签名 `update` 类型加 `features?: string`；`handlePutOverview` body 透传 `features`；`diffFields` 加 features（marker 注入检查已对全部 entries 生效）。
5. 新私有方法：
   - `handleGetProject(projectId)`：project + `store.projectMeta()` → `{...project, statuses, doneStatus, p0, p1}`。
   - `handleGetArchitecture(projectId)`：`{ content, version: contentVersion(bytes或"") }`（读缺失文件 version = `contentVersion("")`）。
   - `writeArchitecture(identity, projectId, content, baseVersion)`——镜像 `writeOverview` 写入单元，返回 `{content, version}`：
     - `baseVersion === undefined` → 400（同 overview 文案）；`typeof content !== "string"` → 400。
     - `store.withWriteLock` 内：`const existed = await Bun.file(path).exists()`；`!existed && baseVersion !== contentVersion("")` → 直接 `versionConflictError({content:"",version:emptyVersion},v)`（不碰盘，无残留）。
     - 不存在则 `Bun.write(path, "")`（withTaskLock realpath 需要目标存在，同 overview）。
     - `filesystem.withTaskLock({id:"architecture", filePath:path})` 内：重读 `lockBytes`；`contentVersion(lockBytes) !== baseVersion` → 若 `!existed && lockBytes.length===0`（占位文件没被他人写）先 `unlink(path)` 再抛 `versionConflictError({content:当前文本,version},v)`；他人已写则保留其内容直接抛。
     - `holds.waitIfAny()` → `assertRunning()` → agent 时 `assertAuthorized(token)`。
     - `Bun.write(path, content)`；`afterBytes` 版本与 `lockBytes` 相同 → 直接返回（无记录）。
     - `holds.throwIfHistoryFailpoint()`（armHistoryFailure 测试依赖此调用点）→ `appendHistory`：`target:{type:"architecture"}`，`action: existed ? "update" : "create"`，`changes: diffFields({content:lockBytes文本}, {content:新文本})`，version=afterVersion。
     - history 失败回滚：existed → `Bun.write(path, lockBytes)`；否则 `unlink(path)`。首次创建失败必须回到未创建状态。
   - `handlePutArchitecture(req, projectId, identity)`：parseBody → `content`（必须 string）、`baseVersion`（必须 string）→ `writeArchitecture`。
6. 路由注册（web 与 agent 双通道，handler 复用）：
   - `GET /api/projects/:id` → `withRoute(handleGetProject)`；`GET /api/agent/projects/:id` → `withAgentRoute`。
   - `/api/projects/:id/architecture` GET/PUT；`/api/agent/projects/:id/architecture` GET/PUT（PUT 走 identity）。
   - `GET /api/projects/:id/resources/:name` → `withRoute(handleGetResource)`（web 授权下补齐单文件读取；下载由前端用同一响应自组装 Blob，无需独立 download 路由）。
   - SPA：`/projects/*` 已存在，确认多级路径（`/projects/x/resources/y`）仍返回 index.html，否则补一条。

### A8 `src/mcp/library-bridge.ts`

- `overview_write`：keys 数组加 `"features"`，schema 加 `features: str("可用能力或交付内容及其使用方法")`。
- `task_create`：body 加 `priority: args.priority`；schema 加 `priority: str("Priority: P0 (current focus, default) or P1 (later)")`。
- `task_update`：keys 数组与 schema 加 `priority`。
- `callTool` 新分支：
  - `architecture_read` → GET `/api/agent/projects/${id}/architecture`。
  - `architecture_write` → `requireBaseVersion(args)` + content 必填（`typeof args.content !== "string"` → throw `content is required`，防止漏传静默清空）；schema `required: ["content","base_version"]` → PUT。
- `listTools` 追加两者描述（参考 SPEC 契约：`architecture_read()`、`architecture_write({content, base_version})`）；`task_create/update` 描述补一句 P0/P1。
- 更新 `question_ask`/`question_answer` 工具 description：保留 API 兼容但去掉「问题会在网页显示」的承诺（五页方案已移除问题页，决策应在当前对话提问）。

### A9 R1 测试 `src/test/library-v11.test.ts`（黑盒 HTTP + 磁盘断言，复用 library-service.test.ts 的 req/enableClient 模式）

- 架构：空读 `{content:"",version}`→ web PUT 创建（baseVersion=空读version）→ 磁盘 `memaster/architecture.md` 内容与提交一致 + history 有 `target.type==="architecture"` `action==="create"` → agent PUT 用旧 version → 409 带 current → 网络/agent 双通道一致。
- 架构回滚：`holds.armHistoryFailure()`，已有文件更新 → 500 后磁盘与 history 都保留上一次提交；首次创建失败 → 文件不存在。
- 架构撤权/停服：codex 与 claude-code **分别** disable 后 agent GET/PUT 均 403、web 通道仍可用；`holds` 挂起 PUT → revoke → 释放后 403 且磁盘未变；`holds` 挂起 PUT → `service.stop()` → 请求失败且磁盘未变（复用 library-service.test.ts 的 stop 模式）。
- 双项目隔离：A 项目写架构，B 项目读仍空；B 项目无架构时任务读写正常。
- features：PUT `{features}` → `overview.md` 出现 `SECTION:FEATURES` 标记与文本 → 重读返回；MCP `overview_write({features,base_version})` 端到端 → 磁盘含标记（SPEC R1 要求双通道实测）；手工构造无 FEATURES 标记的旧 overview 文件 → 读 `features===""` → 仅 PUT `{description}` 后旧三节完整、FEATURES 小节**不落盘**（applyOverviewUpdate 只补 update 中出现的字段）。
- priority：默认创建 → 磁盘 `priority: p0` 且响应含之；显式 `"P1"` → `p1`；非法值 → 400；update 改 P0→P1 + history diff 含 priority + 一条 priority 字段的旧 baseVersion → 409 专例；MCP `task_create` 带 priority；**老项目**：手工删除 config.yml 的 priorities 键（或拷贝 homemaster 式 config）→ 创建/更新 P0 成功且 config 被懒迁移补上 `priorities:`；带旧值 `priority: high` 的任务文件仍可读且原值保留。
- meta：`GET /api/projects/:id` 返回 statuses 与 `doneStatus==="Done"`、p0==="p0"。
- web 资料单读：web key 读 text 资源返回 `text`；二进制返回 `base64`；不存在 → 404；agent token 打 web 路由 → 401（沿用现有断言模式）；revoke 后 agent 路由 403 但 web 仍 200。

---

## B. R2 前端：五页拆分（`src/library-web/`）

共用：`api.ts` 扩展；样式沿用 `../web/styles/source.css`（Tailwind4），设计 token 用 arbitrary values（`bg-[#FAFAF8]`、`text-[#202124]`、强调 `#3B57D0`、选中 `#EEF2FF`）。**页面文案与状态文案一律照 SPEC/蓝图，不自造术语。**

### B1 `api.ts`

- `ProjectOverview` 加 `features: string`；`Task` 加 `priority?: string`；`HistoryEntry.target.type` 联合类型加 `"architecture"`。
- 新：`ProjectMeta = LibraryProject & {statuses:string[]; doneStatus:string|null; p0:string; p1:string}` → `getProject(id)`。
- 新：`ArchitectureRecord {content,version}` → `getArchitecture(id)`、`putArchitecture(id,content,baseVersion)`。
- 新：`ResourceContent {name,size,contentType,text?,base64?}` → `getResource(id,name)`（name 用 `encodeURIComponent`）。
- `createTask` body 不变（服务端默认 P0）；`updateTask` 的 update 类型加 `priority`。

### B2 结构

`App.tsx` 只留：KeyPage（原样）、SetupPage（按蓝图微调文案）、状态加载、`<BrowserRouter>` 路由表：

```
/ → ProjectsPage
/settings → SettingsPage
/projects/:id → ProjectLayout（壳）
    index → OverviewPage
    tasks → TasksPage
    architecture → ArchitecturePage
    resources → ResourcesPage
    resources/:name → ResourceViewPage
    history → HistoryPage
```

新文件：

- `components/AppShell.tsx`（即 ProjectLayout）
  - 侧栏：`hidden lg:flex lg:w-[224px]`，`lg` 以下折叠为顶栏（`lg` breakpoint≈1024 —— 规范断点 960，用 `min-[960px]:` arbitrary：`min-[960px]:w-[200px] min-[1200px]:w-[224px]`，`<960px` 顶栏）。侧栏含：品牌「Memory Master」、项目切换器（button + 下拉列出所有项目，点击跳对应 overview）、五个 NavLink（概览/任务/项目架构/资料/变更记录，当前页 `bg-[#EEF2FF] text-[#3B57D0]`）、底部「所有项目」「设置」。
  - `<960px`：顶栏显示当前项目名 + 「项目导航 ▾」下拉（同样五入口+所有项目+设置）；当前页名显示在页头。
  - 主区：`px-4 min-[640px]:px-6 min-[960px]:px-8 min-[1200px]:px-10`，内容 `max-w-[1160px]`，页头标题 28px（窄屏24）+ 右侧操作位（各页面通过 props/children 注入）。
  - 通过 `Outlet context={{project}}` 向页面传项目；`useParams` 取 id；项目不存在 → 「项目不存在」+ 返回列表。
- `components/Markdown.tsx`
  - `MDEditor.Markdown` 封装：复制 `MermaidMarkdown.tsx` 的 `treatHtmlAsText`（去掉 TaskIdIndex plugin 与 context 依赖，保留 `keepHashLinksInCurrentRoute`），effect 里调 `renderMermaidIn`（从 `../../web/utils/mermaid.ts` import——注意是两级 `../`，该文件无 web 业务依赖）。
- `components/drafts.ts`：`Map<string,string>` 模块级草稿存取（key=`${projectId}:${which}`）+ `getDraft/setDraft/clearDraft`。概览、架构编辑草稿跨页保留；另存选中态（`sel:task:{id}`、`sel:node:{id}`）使切页返回时恢复展开的任务描述/选中的结构节点（SPEC 验收条目）。
- `components/StatusMessage.tsx`：统一的错误/重试/空态小件（就地错误红字+重试按钮；成功短暂提示）。
- `pages/OverviewPage.tsx`
  - 读态：四区按 **简介→当前进展→目标→功能与用法**，区标题 20px，正文用 `Markdown` 渲染；空区显示「未填写」+「编辑」链接；页头右上「编辑」；底部一条「查看项目架构 →」文字链接。
  - 编辑态：四区原位换为带标签的可增高 textarea（`onInput` 自适应 scrollHeight，min-h 4 行），顶条「保存」「取消」（长页底部再给一条同样操作条），保存中禁用重复提交。
  - 草稿：进入编辑即写 draft store（onChange 同步）；保存成功/取消才清除；重新进入页面发现草稿存在 → 直接回到编辑态。
  - 冲突：PUT 409 → 展示「内容已更新」面板：最新四字段只读展示 + 按钮「以我的内容覆盖」（用返回的 version 重试 PUT）/「放弃本次修改」。窗口 focus 时 GET 校验 version：读态静默刷新；编辑态只弹「内容已更新，查看最新内容」提示，不碰草稿。
  - 空字段不渲染示例内容。
- `pages/TasksPage.tsx`
  - 取 `getProject`（statuses/doneStatus/p0）+ `listTasks`；P0 判定：`!t.priority || t.priority === meta.p0`（其他值不显示；无 P0 → 「暂无 P0 任务」+ 新增入口）。
  - 未完成在上；已完成组 `已完成（n）` 默认折叠可展开；行 = checkbox + 名称 + 状态下拉（含全部 configured statuses）；勾选 → `updateTask(status=doneStatus)`；下拉改回任意状态。行内失败 → 回滚该行状态并在该任务处显示「保存失败，重试」。
  - 点任务名展开描述（空描述不展开、不占位）；「＋ 添加任务」弹小输入行（名称→POST）。
  - 不显示 ID 主位、不显示验收/负责人/P1 切换。
- `pages/ArchitecturePage.tsx`
  - GET：空 → 「尚未整理项目架构」+「编辑」入口（手输 Markdown 也可建）+ 一句「也可以在聊天里让 Agent 整理」。
  - 读态：页头「编辑」「放大」；正文 `Markdown` 全量渲染（含 mermaid）。
  - 组成节点交互：解析 markdown 中第一个表头含「名称」「说明」的表格为组成表（容错：找不到则此交互区不渲染）；图下方渲染组成列表行（id 隐藏，显示名称）；点击某行 → 行下原位展开：说明、来源（空不显示）、关联任务（P0 的链接到 `/projects/:id/tasks`）；mermaid SVG 内节点点击事件代理尝试匹配节点 id→组成 id（best-effort，成功同样选中该行）。
  - 「放大」→ 全屏 modal 展示 SVG（可关）。
  - 编辑态：整篇 textarea + 下方实时 `Markdown` 预览 + 保存/取消；草稿同 Overview 机制；冲突面板同 Overview。
- `pages/ResourcesPage.tsx`
  - 页头「上传资料」+「每份最多10MB」；列表行：文件名（整行可点，正常字号）、大小、更新时间、→；空 → 「暂无资料」+上传按钮。
  - 同名上传 → 就地确认条「已存在同名文件，替换还是取消」（不自造 window.confirm 文案，用小 modal/inline confirm）。
  - 上传中/失败状态跟随文件名；点击名 → `navigate(`resources/${encodeURIComponent(name)}`)`。
- `pages/ResourceViewPage.tsx`
  - 「← 返回资料」+ 文件名 + 「下载原件」；内容：`.md` → `Markdown`；其他 text → `<pre>` 保留换行；`base64` 返回 → 「此格式暂不支持网页预览」+ 下载按钮。
  - 下载：base64/text → Blob → `a[download=name]`。
  - 404 → 「文件不存在」+ 返回链接；加载失败 → 「读取失败」+ 重试；加载中只内容区显示。
- `pages/HistoryPage.tsx`
  - 页头时间范围下拉：全部/今天/近7天/近30天（本地算 since ISO）。
  - 按日分组（今天/昨天/yyyy-mm-dd）；行：HH:mm、操作者（actorLabel 复用）、动作摘要（`create→创建`/`update→更新` + targetLabel + title + 变更字段名列表），▸ 可展开；展开显示逐字段 from→to 全文（窄屏上下、宽屏左右）。
  - 首屏约30条 +「显示更多」；空 → 「暂无变更」；失败 → 重试。
  - 工具函数（actorLabel/targetLabel/FIELD_LABELS）搬来并加 `features→功能与用法`、`architecture→项目架构`、`priority→优先级`、`content→内容`（architecture diff 的字段名）；create 动作 from:"" 渲染为「—」。
- `pages/ProjectsPage.tsx`：项目名行列表（≥64px 行高、仅名称+→）；「＋ 新建项目」开 480px modal：项目名称必填、「关联本地文件夹（可选）」折叠输入、取消/创建；创建成功 `navigate(/projects/:id)`。
- `pages/SettingsPage.tsx`：现有逻辑原样搬入，换用与壳一致的页头/表面样式（不改业务行为；仍是一级路由）。
- `components/Modal.tsx`：简单可控 modal（Esc 关闭、焦点回触发）。

### B3 前端测试（尽量小）

- `src/test/library-web-helpers.test.ts`：把 P0 判定、历史按日分组、组成表解析抽成纯函数（`src/library-web/utils.ts`）做单测（P0/P1/缺失/其他值；分组边界；表格解析容错）。
- App 级 jsdom 冒烟：可选 —— 若 react-dom preload 可用则渲染 `<TasksPage>` 假数据冒烟一次；不做全页面 DOM 测试。

---

## C. R3 Skill、指令与自动安装

### C1 新目录 `src/library/agent-content/`（真理源，复制 plan/V1.1 定稿并去草案声明）

- `SKILL.md` ← COLLABORATION-SKILL.md 全文，**删除**第 8 行草案声明段（「本文件是 V1.1 协作 Skill 草案…」）。
- `CONTENT-STANDARD.md` ← 同名文件原样。
- `ARCHITECTURE-FORMAT.md` ← 同名文件原样。
- `ARCHITECTURE-SKILL.md` ← 同名文件原样（专项草案保留为引用资料）。
- `UPSTREAM.md` ← 同名文件原样（ARCHITECTURE-SKILL.md 内有指向它的相对链接，不装会成为死链——评审 BLOCKER）。
- `UPSTREAM-LICENSE.md` ← 同名文件原样（分发携带上游许可）。

### C2 `src/library/agent-content.ts`

- `import skillMd from "./agent-content/SKILL.md" with { type: "text" }` 等（用仓库已验证约定 `with { type: "text" }`，见 `src/guidelines/index.ts`，**不用 `?raw`**——bun build 对 `?raw` 有已知缺陷）。
- `export const SKILL_MD = skillMd`；`export const SKILL_FILES: Record<string,string> = {"SKILL.md":…,"CONTENT-STANDARD.md":…,"ARCHITECTURE-FORMAT.md":…,"ARCHITECTURE-SKILL.md":…,"UPSTREAM.md":…,"UPSTREAM-LICENSE.md":…}`（6 个文件）。
- `instructionBlock` 重写为与新 Skill 同步的短规则：①明确项目名/ID→`project_open`，歧义问用户；②接手读 `overview_read`/`task_list`/近期 `history_list`，写正文前按 Skill 读内容标准；③写入先读版本带 `base_version`，冲突重读再定；④接手/阻塞/解除/完成节点更新任务与进展，功能可用后补「功能与用法」；⑤需拍板直接在当前对话提问（不再引导 `question_ask`），答后更新相关记录；⑥无关杂事不写入；⑦凭据被拒/服务不可达按实际报错告知用户。

### C3 `src/library/client-setup.ts`

- `installSkill`：对 `SKILL_FILES` 逐文件 `writeAtomic(join(dirname(skillPath), name), content)`；返回全部写入路径（installed 列表变为 config + instructions + 6 个 skill 文件 = 8 项）。

### C4 `src/library/service.ts`

- `handleAgentInstructions` 返回 `{instructions: instructionBlock(baseUrl), skill: SKILL_MD, skillFiles: Object.keys(SKILL_FILES)}`。

### C5 R3 测试（并入 library-v11.test.ts 或追加至 library-phase34.test.ts 既有断言的更新）

- 更新既有断言：`installed.length` 3 → **8**；claude-code 与 codex 两端各断言 6 个 skill 文件逐一落盘（SKILL.md 含 `name: memory-master`，CONTENT-STANDARD.md 含「共同写作规则」）。
- **必须改**：`library-phase34.test.ts` 中 `claudeMd` 含 `"question_ask"` 的断言会炸——改为断言新指令要点（如含 `project_open`/`base_version`、不含 `question_ask`）。
- 引用闭包：**遍历 SKILL_FILES 中每一个文件**（不只 SKILL.md），提取所有 `](*.md)` 相对链接（排除 http/锚点），断言每个都在集合内且逐文件解析正确——否则 ARCHITECTURE-SKILL→UPSTREAM.md 这类死链会漏（评审 BLOCKER 的测试面）。
- `bridge.listTools()` 含 `architecture_read`/`architecture_write`；`overview_write` schema 含 `features`；`question_ask` 描述不再含网页可见性承诺。

---

## D. 验收与收尾

1. `bun test src/test/library-v11.test.ts src/test/library-web-helpers.test.ts` 全绿；`bun test src/test/library-*.test.ts src/test/mcp-client-setup.test.ts` 回归；`bun --check`；`bunx biome check src/` 新文件无 warning；`bun scripts/build.ts` 产物正常。
2. 实服冒烟：`MEMORY_MASTER_HOME=$(mktemp -d)` 起 `bun src/cli.ts serve`，按 R1 验收逐条 curl 走一遍（双项目、冲突、撤权、web 读资料），并按 SPEC「前端具体示例」在浏览器过一遍五页（1440/1024/640/390 宽度人工核对留给用户，自动部分先过 1280 与 640 截图/DOM）。
3. 提交：一个 commit 或按 R1/R2/R3 三个 commit；commit message 本身写完整 changelog 条目（改什么+为什么+影响）。
4. 顺手 dogfood：`bun src/cli.ts task create` 建三条任务（R1/R2/R3）并随进度更新状态（本仓库自己的 memaster 板）。

## 明确不做（YAGNI）

- 不做验收项/负责人/待决定网页板块（SPEC 明确取消；接口兼容保留）。
- 不做实时轮询推送、在线心跳；仅 focus 重读 + 手动刷新。
- 不做可视化拖拽架构编辑器、自动生成按钮。
- 不做资料删除/版本恢复、PDF/Office 预览、全文搜索。
- 不动 `src/web` 既有界面与 `memaster` CLI 任务系统。
