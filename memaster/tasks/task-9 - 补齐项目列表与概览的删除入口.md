---
id: TASK-9
title: 补齐项目列表与概览的删除入口
status: Done
assignee:
  - '@codex'
created_date: '2026-11-12T08:43:00Z'
updated_date: '2026-11-12T08:51:00Z'
labels: []
dependencies: []
type: bug
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
用户要求删除能力覆盖项目页，上一轮只实现资料删除，项目列表和概览仍缺入口。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 所有项目与项目概览均可打开有名称和影响说明的删除确认框，取消保留原项目
- [x] #2 确认后项目从列表、搜索及接口移除，关联本地目录保持，记忆可从回收目录恢复
- [x] #3 并发写入、过期确认、失败回滚和前端返回列表有测试覆盖
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. 增加项目删除服务，使用项目写锁、版本校验及原子移入回收目录，防止删除后排队写入重建项目。 2. 复用确认组件，在项目列表和概览加入入口并刷新项目列表。 3. 验证 API、前端取消确认及导航，更新用法并重启预览。
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
项目列表与概览新增删除确认。web DELETE 使用全项目内容版本校验并原子移入 .trash；失败回滚历史和目录，保留 workingDir。独立审查发现旧请求延迟取得 store 的竞态，已改为每次写锁内检查当前配置身份并补确定性回归。51 个相关测试、类型检查、构建通过。浏览器已强刷并确认四个真实项目右侧显示删除项目按钮；真实项目保持原有数据。恢复需文件管理器移回完整项目目录。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
补齐项目列表与概览的删除入口，确认后移入可恢复的回收目录并刷新列表。覆盖取消、冲突、回滚、恢复、排队和延迟旧请求，51 项回归通过，类型检查与构建通过，预览已更新。当前改动尚未提交。
<!-- SECTION:FINAL_SUMMARY:END -->
