# 概览四页阅读 Implementation Plan

用户已确认直接实施并提供可打开的版本。独立完成，不使用computer use。采用writing-plans梳理改动，按本计划在当前功能分支执行，不额外请求执行方式。

**Goal:** 保留完整简介作为项目默认页，把进展与目标、功能与用法、项目约定分到独立地址，消除同页长文堆叠。

**Architecture:** 保留五个一级入口。概览使用四个子路由，同一受控正文组件按页读取已有overview字段；存储与MCP协议不变。单页编辑只提交本字段，草稿按项目和字段隔离，旧草稿拆分保留；乐观版本和冲突检查继续生效。

**Tech Stack:** 现有React、React Router、Bun服务与测试、jsdom。无新依赖。

## 文件与步骤

- [x] P1：src/test/library-web-overview.test.tsx补真实App的导航与直达测试。默认页断言简介全文存在、进展/用法正文不在DOM；四个地址分别只读对应字段；编辑一个字段不覆盖其他字段，切页恢复各自草稿。现有目标、归档、日期、冲突测试移动到进展页。先运行确认旧实现失败。
- [x] P2：新增src/library-web/overview-pages.ts维护field/path/label，修改App.tsx注册四个真实路由，并修改AppShell.tsx让这些路由都选中“概览”。核心路径锁定如下：

```ts
[
 { field: "description", path: "", label: "项目简介" },
 { field: "current", path: "progress", label: "进展与目标" },
 { field: "features", path: "features", label: "功能与用法" },
 { field: "agreements", path: "agreements", label: "项目约定" },
]
```

- [x] P3：重写OverviewPage.tsx的展示与编辑范围。顶部四个可换行页面链接，下方正常标题与单项编辑；简介完整常显，约定独立常显，进展页只显示简报、目标与按需打开的历史。保存形如`api.putOverview(id, { [field]: draft.value }, draft.baseVersion)`；冲突仅比较当前字段。旧overview草稿各有效字段迁到`overview:字段名`，缺失字段不猜值，不清其他页草稿。
- [x] P4：GoalProgress.tsx的阶段记录在整体展开后仍只显示每条标题与实际日期，点单条才挂载完整成果说明与修正入口；日期、分页、版本和去重不变。测试核对未展开的正文没有挂载，以及打开指定记录后内容正确。
- [x] P5：同步Skill与内容标准的页面位置、README、用户指南、架构、CHANGELOG、V1.1审查稿/蓝图/SPEC/STATUS。保留原内容标准；简介不缩写，详细进展比目标充分，无第二份摘要。安装源与本机已启用客户端的Skill同步，不动凭据。
- [x] P6：相关library回归、类型/格式检查、实际构建。重启6421，HTTP分别核对四个地址和新版脚本；真实App连接6421核对默认简介、子页切换、一级导航选中与正文隔离；隔离测试的真实服务核对单页写入的磁盘及冲突终态。本机真实项目正文不因测试编辑而改变。通过MCP更新本轮进展与对应任务，保存后独立核对文件/HTTP/历史。

验证命令：`bun test src/test/library-web-overview.test.tsx`，`bun test src/test/library-*.test.ts src/test/library-*.test.tsx`，`bunx tsc --noEmit`，`bunx biome check`（变更TS），`git diff --check`，`MEMASTER_BUILD_OUTFILE=/tmp/mm-overview-pages-release bun scripts/build.ts`。不将DOM与HTTP检查称为浏览器像素验收，给用户实际地址查看。

## 当前状态

P1–P6完成，基线4959b191，无阻塞。先用8个真实App/服务用例确认旧版无法满足分页；实施后8项通过。相关library回归112项、908条断言全部通过；类型、格式与diff检查通过。React异步归档用例仍有原有act提示。

实际构建程序已在隔离目录启动，四个地址、页面脚本、保存与自动历史核对通过。6421已重启到新版；真实App连接该服务逐一核对四页：HTTP均200，完整正文与服务器内容一致，其他页进展操作不混入当前页，一级概览选中，约定页全文直接可读。真实项目的简介与开始前逐字一致，未用其正文做测试编辑。

Skill已同步本机Codex与Claude Code，两个安装包校验通过，凭据和个人指令保持原样。memmaster已更新功能用法、约定、最新进展与架构，记录一次四页交付成果；TASK-3仍进行中，等待用户查看阅读感受及完整体验验收。MCP保存后独立核对HTTP、磁盘、任务和自动历史一致。

查看入口：http://127.0.0.1:6421/projects/p_b7b809674c，进展页为同址加/progress。未使用computer use，未做浏览器像素、实际窄屏和200%缩放验收；不将DOM检查冒充视觉验收。

## P7：用户反馈的统一命名与重复标题修正

已定位根因为选中导航item.label和通用PageHeader的page.label重复显示。新增真实App失败用例后合并导航与操作区，保留语义h1，视觉正文直接开始。project-content.ts统一存储、网页和MCP名称，Skill与内容标准同步。用户指定九个参考入口及公开案例已独立调查，见[调研](research_readability/findings.md)与[设计建议](research_readability/design_proposal.md)。本轮只修正命名和外壳重复，更全面的四页布局仍为建议。

- [x] P7验证：相关回归、构建、真实服务四页去重与双端MCP名称核对，更新共享记忆及两端Skill。

P7结果：113项相关测试、913条断言通过，类型/格式检查与实际构建通过；构建程序已实际运行。6421已重启，真实App逐页核对正文、导航、去重页头与保留的可访问标题。Codex与Claude Code配置的MCP分别核对共享名称，两端Skill同步和校验通过。共享记忆已保存决定、当前进展与任务，HTTP、磁盘和自动历史核对一致。没有使用computer use或完成浏览器像素验收。
