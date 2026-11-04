/**
 * The user-level agent content Memory Master installs into each client
 * (Phase 3 short instructions + collaboration Skill; Phase 4 installs them).
 *
 * Single source of truth: `connect` output, `client-setup.ts` installers and
 * docs all render from these constants. The managed block in CLAUDE.md /
 * AGENTS.md is deliberately short — it only contains trigger rules; the skill
 * file carries the detailed playbook.
 */

export const MANAGED_BEGIN = "<!-- memory-master:begin -->";
export const MANAGED_END = "<!-- memory-master:end -->";

/**
 * Compact trigger rules injected into the user-level instruction file.
 * Rendered between the managed markers — content outside them is untouched.
 */
export function instructionBlock(serviceUrl: string): string {
	return `${MANAGED_BEGIN}
## Memory Master 协作规则

本机运行 Memory Master（本地项目管理与交接服务，${serviceUrl}）。当用户提到继续、推进或处理某个 Memory Master 项目，或明确给出项目名时：

1. 用 \`project_open\` 按名称打开项目；名称有歧义时它会返回候选列表，向用户确认后用项目 ID 打开。所选项目在本会话内保持，用户明确切换前不要换。
2. 接手时先读 \`overview_read\`、\`task_list\`、\`question_list\`，弄清现状再动手。
3. 在接手、遇到阻塞、解除阻塞、完成任务时主动用 \`task_update\` 更新进度：先读最新 \`version\` 作为 \`base_version\`；返回 VERSION_CONFLICT 时重读再决定是否重写。
4. 需要用户拍板的事（会改变用户预期结果的选择、缺信息、缺权限）：在当前对话提出具体问题，并用 \`question_ask\` 把问题记入项目（可关联任务 ID）。常规执行自行决定，不打断用户。
5. 用户在对话里给出答案后，用 \`question_answer\` 把答案写回该事项。
6. 与项目无关的临时杂事照常完成，但**不要**写入项目数据；归属不明确时暂缓写入。
7. 写入前先读：所有更新都必须带最新 \`base_version\`，拒绝凭记忆直接覆盖。
${MANAGED_END}`;
}

/**
 * The collaboration Skill — the detailed playbook agents load on demand.
 * Written to each client's skills directory by the installer.
 */
export const SKILL_MD = `---
name: memory-master
description: Memory Master 项目协作——按名开项目、读写概览与任务、提问留痕、接手续作。
---

# Memory Master 协作 Skill

Memory Master 是用户本机的项目管理与交接服务。你通过 MCP 工具读写项目：项目状态的唯一权威来源是记忆库里的项目存储，不是你看到的工作目录。用户在网页上能看到全部进度和变更记录——你的每次读写都会留下带身份的记录。

## 工具速查

| 工具 | 用途 |
| --- | --- |
| project_list | 列出记忆库里的全部项目 |
| project_open | 按名称或 ID 打开项目（会话内保持；歧义返回候选） |
| project_current | 查看当前打开的项目 |
| overview_read / overview_write | 读/写项目概览（是什么、目标、当前进展） |
| task_list / task_get / task_create / task_update | 任务读写；更新必须带 base_version |
| question_ask / question_list / question_get / question_answer | 待决定事项的提出、查看与答案回填 |
| resource_list / resource_read | 查看项目资料清单、按需读取指定文件 |
| history_list | 项目变更记录（谁、何时、改了什么、前后值） |

## 接手流程

1. 用户提到项目（名称或"继续某项目"）→ \`project_open\`。歧义返回候选时把候选交给用户确认，不要自行猜。
2. \`overview_read\` + \`task_list\` + \`question_list\` 一次读全：项目意图、任务状态、未决问题。
3. 若要接着上次进度，先看 \`history_list\` 里最近几条变更，确认别人已做到哪。
4. 开始动手时把要接的任务 \`task_update\` 为进行中（带上读到的 \`version\` 作 \`base_version\`）。

## 进度更新纪律

- 接手 / 阻塞 / 解除阻塞 / 完成 四个节点主动更新；没有实质进展变化不写。
- 更新永远先读后写：读到的 \`version\` 就是本次写的 \`base_version\`。
- 收到 VERSION_CONFLICT：说明有另一方（用户或另一个 Agent）先改了。读最新值，判断你的意图是否仍然成立——成立就在最新版本上重写，不成立就停。
- 完成时把 \`current\` 进展写进概览（同样带 base_version），让下一个接手的会话不用问用户。

## 提问与回答

- 判断标准：这个选择会改变用户预期得到的结果吗？会→\`question_ask\`（写清问题、选项、你的建议，\`task_id\` 关联相关任务），同时在对话里把问题抛给用户。不会→自己决定继续。
- 用户在对话里回答后 → \`question_answer\` 回填答案（带该事项的 \`version\`）。用户也可能直接在网页回答——\`question_list\` 里状态变成 Answered 的就按答案继续。
- 提问不等于停工：与该决定无关的常规部分照常推进。

## 资料

- \`resource_list\` 先看清单，\`resource_read\` 按需读取。不要凭空假设资料内容。
- 方案正文、测试数据等只有用户明确选入才算资料；你自己产出的工作文件放在工作目录，不要写进项目存储。

## 边界

- 与项目无关的杂事（顺手帮忙的小事）做完即可，绝不写进项目数据。
- 归属不明确的写入暂缓，先问。
- 凭据被撤销（403 ACCESS_DISABLED）：明确告诉用户到 Memory Master 设置页重新开启，不要重试刷请求。
- 服务不可达：同样直说，提示用户启动 Memory Master 应用。
`;

/** Marker-guarded TOML section installed into Codex config.toml. */
export const CODEX_TOML_BEGIN = "# >>> memory-master >>>";
export const CODEX_TOML_END = "# <<< memory-master <<<";
