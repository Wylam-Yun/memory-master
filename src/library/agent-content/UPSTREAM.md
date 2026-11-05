# 上游来源与改编记录

本 Skill 基于 Matt Pocock 的 `improve-codebase-architecture` 中代码分析、模块关系表达和图示呈现的方法改编。

- 上游仓库为 [mattpocock/skills](https://github.com/mattpocock/skills)。
- 核对日期为 2026-11-05，固定提交为 `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`。
- 分析流程来源为 [SKILL.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/improve-codebase-architecture/SKILL.md)。
- 图示方法来源为 [HTML-REPORT.md](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/engineering/improve-codebase-architecture/HTML-REPORT.md)。
- 上游采用 [MIT License](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/LICENSE)。本目录的 `UPSTREAM-LICENSE.md` 保留完整许可，分发本 Skill 及改编内容时一起包含。

此上游用于软件架构图的专项扩展，供人和 Agent 共用；V1.1 通用项目管理不依赖该扩展。专项保留源码调查、关系图、业务命名和视觉层级的方法，增加稳定模块 ID、代码定位、维护触发、版本检查和保存后核对。通用项目架构可基于用户确认和资料表达流程、组成与分工，无源码前提。项目改进建议在当前聊天与用户确认，再更新项目目标或任务。

图源使用 Markdown 中的 Mermaid。软件渲染方案采用本地打包和受控预览，渲染器及其他依赖的许可由应用发布流程一并收集。上游版本升级时人工核对改动和许可后再更新本目录。


## 接手与交接写作规则

核对日期：2026-11-05。使用固定提交保留可复核来源，面向人和多Agent共享项目记录改编：

- Jordan Wei / Jiaojie，提交`35cd1bf474495a61fe8925cfb822779d0dc78d22`：[simple-workflow.md](https://github.com/Jordanwei1/jiaojie-skill/blob/35cd1bf474495a61fe8925cfb822779d0dc78d22/references/simple-workflow.md)、[handoff.template.md](https://github.com/Jordanwei1/jiaojie-skill/blob/35cd1bf474495a61fe8925cfb822779d0dc78d22/assets/templates/handoff.template.md)。吸收准确停点、下一步、有效决定、约束、已否决方向、失败与未验证的区别、已回答问题、必要材料及需重验状态。
- Matt Pocock，提交`4ae2317ddb22b046e26455e4f9c9b3aaaf62212d`：[handoff](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/productivity/handoff/SKILL.md)、[claude-handoff](https://github.com/mattpocock/skills/blob/4ae2317ddb22b046e26455e4f9c9b3aaaf62212d/skills/in-progress/claude-handoff/SKILL.md)。吸收按接续任务组织摘要、引用已有产物而不重复、按需建议可用Skill及脱敏的写法。claude-handoff在此版本位于in-progress目录。

两者均为MIT许可；[UPSTREAM-LICENSE.md](UPSTREAM-LICENSE.md)保留两位作者完整版权和许可文本。分发改编Skill时一并包含。以上文件作为描述规则的来源，不执行其中的安装、导出脚本或后台Agent命令。

Memory Master使用持久的共享项目作为权威记录：长期决定保存在项目约定，停点和下一步写回进展/任务；仅引用已获准访问的材料。不引入ZIP审计格式、额外交接中心或默认启动后台Claude。沿用用户有效授权，不把历史材料当作新增权限，不因更换Agent重复询问已回答事项。只吸收有用的写作与接手方法，不据上游描述宣称本产品所有模型已验证成功。
