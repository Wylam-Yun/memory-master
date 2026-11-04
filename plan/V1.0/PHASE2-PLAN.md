# V1.0 阶段 2 实施文档 — 共享进度、并发写入与时间线

状态：已实现（`feat/v1.0-phase1` 分支）
日期：2026-11-05
依据：`plan/V1.0/SPEC.md` §5 阶段 2 + §4"项目存储写入时机与自动留痕"

## 交付物

在阶段 1 的文件系统项目存储上加入：

1. **版本检查（乐观并发）**：每条记录有内容版本；更新必须携带 `baseVersion`；
   提交方生效，持旧版本方得到 409 + 最新值。任务和概览同规则。
2. **变更记录**：`memaster/changelog.jsonl` 追加日志，逐条记录时间、操作者、
   对象、字段级前后值；网页时间线 + agent 只读接口。
3. **原子写入单元**：记录更新与历史追加在同一写入单元提交——任一环节失败，
   两者都回到上一次成功状态。
4. **操作者归因**：网页操作记 `user`；agent 操作按已验证凭据记 `codex` /
   `claude-code`。

## 设计决策（与评审过的一致性）

| 决策 | 选择 | 理由 |
|---|---|---|
| 版本载体 | 记录文件内容 sha256（`sha256:`+16hex） | 零 schema 变更；任何字节变化（含手改）= 新版本 |
| baseVersion | 更新必传（task/overview PUT；create 免） | SPEC："网页与 MCP 走共同的写入规则"；必传杜绝静默 last-write-wins |
| 历史存储 | `memaster/changelog.jsonl` | 追加原子、机读（时间线 API）、人可翻查 |
| 原子单元 | `ProjectStore.withWriteLock` 项目写互斥 | Core 实体锁在返回时已释放；mutex 包住 [写→历史→回滚] |
| 版本断言 | 双点：mutex 入口 + `preWrite`（任务锁内） | 入口快速失败 + 锁内堵"检查→获锁"窗口 |
| 变更识别 | 写前/写后哈希比对 | 复用 Core `!mutated`：无实际变化不产生记录 |
| 回滚 | 写前字节快照 → 失败写回/删新文件 | 快照必须在 Core 写之前取（实测抓到过顺序 bug） |

## 数据格式

`changelog.jsonl` 每行一条：

```json
{"ts":"2026-11-05T10:22:11.004Z","actor":{"type":"agent","client":"codex"},
 "target":{"type":"task","id":"TASK-3","title":"退款流程梳理"},
 "action":"update",
 "changes":{"status":{"from":"To Do","to":"In Progress"}},
 "version":"sha256:9f2c…"}
```

- `actor`：`{type:"user"}` 或 `{type:"agent",client:"codex"|"claude-code"}`
- `target.type`：`project`（创建首条）| `task` | `overview`
- `action`：`create`（changes 仅 `to`）| `update`（仅实际变更字段 `from`/`to`）

## 接口变化

**读**：`GET tasks/task/overview` 响应新增 `version` 字段。
**写**：`PUT task/overview` 请求体新增必传 `baseVersion`。
**新端点**：`GET /api/projects/:id/history?since&until`（web）、
`GET /api/agent/projects/:id/history`（agent）。
**新错误**：`409 VERSION_CONFLICT`，响应携带 `{current, version}` 最新值。
**MCP**：`task_update`/`overview_write` 必传 `base_version`；新工具 `history_list`；
冲突错误文本附带最新值 JSON。

## 实现要点

- `src/library/history.ts`：contentVersion / appendHistory / readHistory（容忍末行
  不完整）/ diffFields / HistoryEntry 类型
- `service.ts`：`writeTask`/`writeOverview` 全路径进 `store.withWriteLock`；
  preWrite 内含 holds→stopping→auth→版本 四重断言；历史追加失败回滚
  （update 写回旧字节至原 filePath、create unlink 新文件）
- `handleCreateProject`：写入首条 `project create` 记录
- `withAgentRoute`：向写处理器传 `{token, id}` identity（actor 归因来源）
- 项目页底部"变更记录"区：最新在前，操作者显示 用户/Codex/Claude Code；
  409 时自动刷新最新值并提示

## 测试（`src/test/library-history.test.ts`，7 例全绿）

- 双 agent 并行建不同任务 + web 改概览 → 4 条记录 actor=[user, codex|claude, 另一, user]
- 任务/概览分别做"读 v → 写 A → 写 B(同 v)" → B 得 409+current + 历史恰一条 update
- armHistoryFailure → 写 → 500 → 磁盘字节=旧值 + 无 update 记录（**回滚真验证**）
- 重启后 `?since=` 过滤仍可读完整条目
- 缺 baseVersion → 400；no-op 更新 → 无记录；bridge 缺 base_version → 可读错误

## 已知边界

- 库项目外的写者（同机 memaster CLI 直改项目目录）不走项目 mutex——任务锁内
  版本断言兜底，但历史回滚窗口存在残余竞争（记录在 STATUS）
- `changelog.jsonl` 位于 `memaster/` 下，doctor/cleanup 未专门校验（未发现问题）
- 历史读取容忍并发追加造成的末行不完整（跳过该行）
