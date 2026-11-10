---
id: TASK-5
title: 改版项目概览与 Agent 交接
status: Done
assignee: []
created_date: '2026-11-10T05:33:00Z'
updated_date: '2026-11-10T05:51:00Z'
labels: []
dependencies: []
type: feature
ordinal: 5000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
集中展示项目现状与交接信息，网页和 Agent 共享关键路径及内容规则。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 项目首页、任务直达、进展和目标历史在宽窄屏可用
- [x] #2 关键路径由网页与 Agent 双向读写并保留版本校验和历史
- [x] #3 新版 Skill 和文档与实现同步并通过相关检查
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
完成概览与导航；增加共享关键路径；同步 Skill 与文档；验证隔离项目的浏览器、MCP 与安装终态。
<!-- SECTION:PLAN:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
新版概览、任务直达和历史入口已实现。关键路径通过网页与 MCP 共享并记入变更记录。隔离项目的 1280px 和 390px 浏览器验收、真实 stdio MCP 双向读写、Codex 与 Claude Code Skill 安装、123 项相关测试、类型检查和构建全部通过。Biome 通过并保留主干已有的 21 条警告。
<!-- SECTION:FINAL_SUMMARY:END -->
