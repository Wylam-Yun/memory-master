# 全局与项目 Agent 权限实施计划

**目标：** 用户能分别管理整套记忆库的 Agent 连接、默认修改权限，以及单个项目的例外。

**已确认方案：** 全局连接是总开关；项目不能绕过。打开连接即允许读取可访问的项目。全局「默认允许修改」适用于继承它的项目；单个项目可以开启或关闭修改。项目也可单独禁止连接，禁用时同时禁止读取和修改。恢复继承会删除项目例外，之后继续跟随全局变化。用户自己的网页编辑不受影响。

**技术栈：** Bun HTTP、TypeScript、React、既有 MCP stdio 桥接和本机设置文件。

| 全局连接 | 项目连接 | 全局默认修改 | 项目修改 | Agent 结果 |
| --- | --- | --- | --- | --- |
| 关闭 | 任意 | 任意 | 任意 | 无法连接 |
| 开启 | 禁止 | 任意 | 任意 | 项目不出现在列表，无法打开 |
| 开启 | 继承 | 关闭 | 继承 | 只读 |
| 开启 | 继承 | 关闭 | 允许 | 读写该项目 |
| 开启 | 继承 | 开启 | 禁止 | 只读 |
| 开启 | 继承 | 开启 | 继承 | 读写 |

- [x] 在 `src/test/library-agent-access.test.ts` 先通过隔离 HTTP 服务和 MCP 验证权限表。覆盖旧启用客户端保留读写、全新客户端默认只读、项目/客户端相互隔离、部分名称解析不泄露、撤权后已打开项目不能继续访问、同一权限在重启后保留。新接口实现前运行测试确认失败。
- [x] 扩展 `src/library/settings.ts` 与 `src/library/types.ts`。已有启用配置无新字段时保留修改权限，新配置默认只读。项目例外只存本机设置，按库和稳定项目 ID 隔离；独立更新每个字段，`null` 清除该字段。全局修改默认值单独保存，不触发客户端安装。
- [x] 在 `src/library/service.ts` 集中检查所有 Agent 项目路由，先过滤列表和名称解析，再校验按 ID 的每次访问。只读修改返回 `403 / WRITE_DISABLED`，隐藏项目返回 `404 / PROJECT_NOT_FOUND`。检查概览、目标、阶段进展、架构、任务、历史、资料、兼容的待决定事项。每条写路径提交前重新核对权限；在测试中把写入挂起、保存撤权、再释放，并核对返回和磁盘无变化。通过 `src/mcp/library-bridge.ts` 让 `project_current` 也重查权限。项目权限编辑端点仅供网页端，保留本机 Web 与 Agent 接口的现有信任边界。
- [x] 修改 `src/library-web/pages/SettingsPage.tsx`、`ProjectsPage.tsx`、`components/AppShell.tsx`、`App.tsx` 和 `api.ts`，新增 `ProjectSettingsPage.tsx`。确认首页进入全局设置，项目内进入本项目设置，继承与例外在页面可辨认。用实际 React 页面连接隔离 HTTP 服务检查保存、恢复继承及导航。
- [x] 更新 `README.md`、`docs/USER-GUIDE.md`、`docs/ARCHITECTURE.md`、`CHANGELOG.md` 和随客户端安装的 Skill；运行权限、服务、设置、历史、架构、概览和浏览器相关检查。独立核对获准/拒绝的 HTTP 或 MCP 状态及每个目标的磁盘终态，验证编译产物能启动；不改当前运行的正式服务和访问设置。


## 验收结果

- 权限专项通过 5 项，188 条断言。每条内容写入路径分别检查只读拒绝、写入期间撤权、原始项目目录快照相同。全局默认修改撤销和项目连接撤销分别核对返回码与文件终态。
- 网页导航与权限操作测试通过，实际 App 连接临时 HTTP 服务，核对全局与项目设置地址、保存、恢复继承，以及对应 Agent 请求结果。
- 最终项目空间相关测试通过 128 项，14 个文件，1261 条断言，0 失败。类型检查通过 614 个文件。
- 类型检查通过。独立编译产物的 smoke checks 通过。
- 在隔离项目用 Chrome 核对 1280px 桌面和 390px 移动布局，移动视口的 documentElement.scrollWidth 和 innerWidth 均为 390。开关使用仓库已有 rounded-circle 类。
- 权限限制适用于 Memory Master 的 Agent 接口。本机网页接口沿用现有用户访问边界，用户自己的文件访问由操作系统管理。

## 实现选择

新客户端默认只读。升级时，原来已经启用的客户端保留修改能力。项目例外存储在本机应用设置中，以记忆库目录及稳定项目 ID 区分，因此复制项目到另一记忆库时权限独立。这两项选择已在用户指南说明。


## 交接

分支为 feat/project-agent-permissions，工作区为本机 /Users/wylam/Documents/workspace/memory-master-agent-permissions。实现、验证和文档已完成，下一步可审阅分支并决定合入安排。正式项目的共享任务为 TASK-13。完成时本机 6421 服务不可达，project_open 返回 Cannot reach the Memory Master service，共享任务状态与最新简报尚待服务恢复后同步。临时浏览器与测试服务已关闭。

## 补充全量验证

对提交 ad108d5a 执行完整 bun test --timeout=10000。346 个文件共 3853 项，3836 通过，13 跳过，4 失败，19495 条断言，用时 663.09 秒，进程退出码 1。全仓库测试未通过。

| 失败用例 | 分支复核 | 原 main 复核 |
| --- | --- | --- |
| cli-launcher.test.ts，browser cleanup after group SIGTERM | 再次出现 fixture binary 启动超时 | 相同超时 |
| cli-launcher.test.ts，second Ctrl+C during mcp cleanup | 单独重跑通过 | 单独运行通过 |
| cli-doc-archive.test.ts，interactive archived line | 再次出现文字空格缺失 | 相同断言失败 |
| git.test.ts，timed-out process group | 再次出现 child.pid 未生成 | 相同文件缺失 |

上述测试及对应旧启动器、终端和 Git 实现与原 main 无差异。第二项仅在全集出现，超时根因尚未确认。不能把单独重跑通过记为全集通过。

另以独立编译产物启动实际服务及 stdio MCP 子进程，逐项检查默认只读拒绝、单个项目授权后创建任务且文件落盘、项目关闭连接后列表隐藏、已选中项目拒绝继续读取、恢复继承后重新只读，全部通过。类型检查与编译 smoke checks 重跑通过。Biome 全项目检查退出码 0，保留 21 条现有警告。

本机验证日志保存在 /tmp/mm-agent-permissions-full-tests.log、/tmp/mm-agent-permissions-failure-recheck.log、/tmp/mm-agent-permissions-main-comparison.log 与 /tmp/mm-agent-permissions-biome.log。完整测试结果保留为失败，当前功能的 128 项相关测试通过。
