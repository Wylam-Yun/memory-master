---
id: TASK-6
title: 聊天中建立项目、查找相似项目并维护本地目录关联
status: Done
assignee:
  - '@codex'
created_date: '2026-11-12T06:20:00Z'
updated_date: '2026-11-12T06:32:00Z'
labels: []
dependencies: []
type: feature
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
用户希望在与 Agent 聊天时直接建立项目，或发现记忆库里相似的项目后在聊天中决定更新哪一个。已有网页项目也需要能补充或更换关联的本地目录。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Agent 能创建并选中项目，网页可读，创建历史标识实际客户端；重复和并发创建保持一致
- [x] #2 Agent 能按名称、项目正文和目录查找候选，候选查询保持当前选择；协作指令要求在聊天确认潜在归属
- [x] #3 网页和 Agent 能读取并按版本修改或解除工作目录关联，保留其他配置，授权撤销与失败不留错误状态
- [x] #4 使用说明覆盖首次启动、聊天建项目、相似项目确认、已有项目关联目录，相关测试与检查通过
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. 复用项目注册层，加入可检索的项目摘要和并发安全的创建提交，保留授权与历史一致性。
2. 提供 Agent 创建、搜索、读取和关联工具及对应服务路由，更新关联要求配置版本并保持原配置。
3. 在项目页加入关联目录弹窗，刷新项目数据，按版本处理冲突。
4. 更新协作 Skill、触发指令和中英文使用说明，验证聊天建项目、候选查询、目录修改、冲突与撤销流程。
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
已实现 project_create、project_search、project_update，并让 project_current 获取最新配置。创建采用记忆库锁和隐藏暂存目录提交，目录更新使用配置版本、授权复核与历史失败回滚。网页支持关联/更换/解除目录并同步 Agent 更新。独立审查发现的无概览旧项目搜索失败、旧 Windows 路径和关联显示刷新问题均已修复。12 个相关测试文件共 139 项通过，最终 UI 15 项复测通过，类型检查与构建通过，Biome 退出 0 并报告 21 个 warning。中英文 README、用户指南、协作 Skill 与注入指令已更新。
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
用户可在聊天中创建并选中项目，按名称、概览正文或关联目录查找潜在相关项目后，在聊天确认更新已有项目还是新建。网页与 Agent 可按版本维护本地目录关联，保留原配置并记录实际操作者。已通过相关自动化测试、类型检查与构建，独立审查问题已修复。相似检索采用本地文本匹配，语义相关性由聊天 Agent 判断。当前运行服务及客户端需重新加载新版源码、协作内容和工具清单后生效。
<!-- SECTION:FINAL_SUMMARY:END -->
