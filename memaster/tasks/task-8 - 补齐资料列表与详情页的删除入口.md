---
id: TASK-8
title: 补齐资料列表与详情页的删除入口
status: Done
assignee:
  - '@codex'
created_date: '2026-11-12T08:12:00Z'
updated_date: '2026-11-12T08:23:00Z'
labels: []
dependencies: []
type: bug
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
用户在更新前端后查看资料页，发现没有删除操作。当前资料页只有上传、阅读和下载，服务端也没有删除路由，需要贯通确认删除、文件移除与历史记录。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 资料列表和详情页均提供删除入口，确认显示文件名，取消保留资料，删除后刷新或回到列表
- [x] #2 删除按文件版本检查冲突，拒绝路径穿越与符号链接，历史失败可恢复文件
- [x] #3 相关界面和服务测试、类型检查与构建通过，运行中的预览可显示新增入口
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. 为资料列表和读取结果提供内容版本，增加网页删除路由及变更历史。
2. 在资料列表和详情页加入复用的确认弹窗，沿用现有样式并处理失败和冲突。
3. 用真实服务和 DOM 测试验证确认、取消、删除、冲突和历史回滚，重启现有预览加载新版。
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
资料列表和详情页均新增删除入口，复用确认弹窗，取消保留文件，详情页成功后返回列表。服务增加内容版本和网页 DELETE 路由，历史标明删除，版本冲突、路径穿越、符号链接和历史失败恢复均有测试。43 项服务与 DOM 测试通过，类型检查与构建通过。已重启 50331/50332 临时预览，并核对 50331 返回的页面脚本包含确认删除入口。用户提供的 homemaster 项目仅用于核对页面，功能开发记录保存在本仓库任务中。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
删除入口缺失来自资料前端和后端均未实现删除。现已贯通列表与详情页的确认删除、文件版本冲突校验和变更历史，并补充资料使用说明。43 项相关测试、类型检查和构建通过，当前预览已加载新版。修改保存在 fix/library-resource-delete 分支工作区。
<!-- SECTION:FINAL_SUMMARY:END -->
