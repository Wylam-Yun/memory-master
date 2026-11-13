---
id: TASK-10
title: 补充 README 中交给 Agent 的部署与项目管理指令
status: Done
assignee:
  - '@codex'
created_date: '2026-11-13T02:30:00Z'
updated_date: '2026-11-13T03:38:00Z'
labels: []
dependencies: []
type: docs
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
用户需要把 README 直接交给 Agent，完成本地部署、启动并打开前端，以及在聊天中建立、关联和持续管理项目。现有文档缺少可复制的完整操作指令与启动成功判断。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 README 提供可复制的安装部署和打开前端指令，说明实际地址、进程保留与服务复用
- [x] #2 README 提供客户端接入、聊天建项目、相似项目确认和持续管理的指令示例
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
核对 CLI 和接入实现，在中文 README 快速开始之后补充 Agent 操作段落，核验命令和文档链接后提交推送。
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
已在中文 README 快速开始后增加 Agent 部署和使用章节及导航。包含首次下载与安装、复用服务、持续进程与日志、实际端口与 HTTP 验证、打开前端、任务工作台、客户端接入和聊天项目管理示例。命令与 CLI 帮助及实现核对，MCP 工具名和版本字段核对，README 本地链接和代码块检查通过，git diff --check 通过。独立文档审查未发现阻塞问题。

根据用户反馈，将 Agent 使用章节精简为五个一句话示例，覆盖部署、打开前端、建立与关联项目、相似项目确认及继续工作，仅保留首次接入提示。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
补齐可直接复制给 Agent 的本地部署、前端启动和项目管理指令，说明首次选择记忆库、客户端启用与重连、相似项目确认、目录关联和持续交接。文档与当前 CLI/MCP 实现一致。本轮为文档改动，核对了当前服务 HTTP 200，未重新执行首次安装流程。
<!-- SECTION:FINAL_SUMMARY:END -->
