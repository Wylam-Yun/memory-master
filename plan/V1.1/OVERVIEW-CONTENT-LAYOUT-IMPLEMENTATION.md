# 概览四页内容阅读实施计划

用户已确认实施research_readability/design_proposal.md的四页内容组织。独立完成，不使用computer use。保留当前未提交的分页与命名修正，不重排一级导航。

目标：完整简介按文章阅读，当前进展突出具体交接事实，功能与用法提供真实章节定位，项目约定按条目完整阅读。四页仍读取原有Markdown和同一API，不增加摘要或新保存对象。

## 实施与验收

- [x] L1：新增overview-content.ts，使用现有Markdown解析器提取真实顶层标题及稳定目录ID；当前进展只识别共享定义的已完成、当前停点、未完成或未验证、下一步。忽略代码块中的伪标题，保留无标题旧文、前言与未知正文，分段后的引用定义仍有效。先写失败测试。
- [x] L2：新增OverviewContent.tsx负责四种阅读布局；简介完整文章，功能目录仅在至少3个主要章节时出现，原正文完整挂载；约定用清楚的列表间距；进展按真实小标题显示完整正文与突出下一步。Markdown.tsx只扩展可选标题锚点，保留HTML文本化与strict Mermaid。OverviewPage接入，保存/冲突/草稿不变。
- [x] L3：实际App连接临时真实服务验证目录与标题一一对应、点击定位的URL、少量内容无目录、引用链接、四项进展与旧文兼容、简介和约定完整、保存不覆盖其他页；执行现有回归、类型/格式检查及构建。
- [x] L4：同步Skill、内容标准、README/指南/架构/CHANGELOG和V1.1方案，安装到本机Codex与Claude Code。通过真实MCP将memmaster当前进展整理为同名四段，记录实际成果并更新使用入口；简介原文不改。重启6421，逐页HTTP及真实App的DOM核对、构建程序运行和真实文件/历史终态检查，提供用户可打开的地址。浏览器视觉不能用DOM代替。

新增文件：src/library-web/overview-content.ts、components/OverviewContent.tsx、src/test/library-overview-content.test.ts。修改Markdown.tsx、OverviewPage.tsx、project-content.ts、library-web-overview.test.tsx及配套文档。

验证：bun test src/test/library-overview-content.test.ts src/test/library-web-overview.test.tsx；bun test src/test/library-*.test.ts src/test/library-*.test.tsx；bunx tsc --noEmit；变更TS的biome check与TSX格式检查；MEMASTER_BUILD_OUTFILE=/tmp/mm-content-layout-release bun scripts/build.ts；git diff --check。

当前停点：L1–L4已完成，无阻塞。119项相关测试、948条断言通过，类型/格式检查和实际构建通过。测试覆盖Markdown标题与代码块、稳定目录ID、单个总标题、旧文与空段、引用、安全渲染、真实App目录点击、单页编辑与草稿回归。React异步归档用例仍有原有act提示。

构建程序已在隔离目录实际运行，四个地址、页面脚本、数据保存及自动历史终态均通过。6421已重启到新版，真实App连接该服务逐页核对正文完整、目录对应实际标题、当前进展四段、导航与标题去重；简介与开始前逐字一致。Codex与Claude Code的真实MCP分别核对同名四段说明，两端Skill同步并校验通过。

memmaster通过MCP更新了当前进展、功能用法、约定与架构，记录一条本轮关键成果；TASK-3保持进行中，完整视觉体验继续跟进。独立核对HTTP200、真实Markdown、阶段记录与自动历史一致。

查看：http://127.0.0.1:6421/projects/p_b7b809674c/progress 及/features。相关代码已保存为fa8c9eee并合入本机main，见[主干合并记录](MERGE-TO-MAIN.md)。未使用computer use，未将DOM/HTTP结果当作浏览器像素、窄屏或缩放验收；下一步是用户查看阅读效果后继续调整。
