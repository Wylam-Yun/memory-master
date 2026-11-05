import architectureFormatMd from "./agent-content/ARCHITECTURE-FORMAT.md" with { type: "text" };
import architectureSkillMd from "./agent-content/ARCHITECTURE-SKILL.md" with { type: "text" };
import contentStandardMd from "./agent-content/CONTENT-STANDARD.md" with { type: "text" };
import skillMd from "./agent-content/SKILL.md" with { type: "text" };
import upstreamMd from "./agent-content/UPSTREAM.md" with { type: "text" };
import upstreamLicenseMd from "./agent-content/UPSTREAM-LICENSE.md" with { type: "text" };

/**
 * The user-level agent content Memory Master installs into each client
 * (Phase 3 short instructions + collaboration Skill; Phase 4 installs them).
 *
 * Single source of truth: `connect` output, `client-setup.ts` installers and
 * docs all render from these constants. The managed block in CLAUDE.md /
 * AGENTS.md is deliberately short — it only contains trigger rules; the skill
 * file carries the detailed playbook. Markdown sources live in
 * ./agent-content/ and are embedded via `with { type: "text" }` imports
 * (bun build inlines them; `?raw` is not supported there).
 */

export const MANAGED_BEGIN = "<!-- memory-master:begin -->";
export const MANAGED_END = "<!-- memory-master:end -->";

/**
 * Compact trigger rules injected into the user-level instruction file.
 * Rendered between the managed markers — content outside them is untouched.
 * Kept in sync with SKILL.md: it points agents at the skill's content
 * standard instead of restating the whole playbook.
 */
export function instructionBlock(serviceUrl: string): string {
	return `${MANAGED_BEGIN}
## Memory Master 协作规则

本机运行 Memory Master（本地项目管理与交接服务，${serviceUrl}）。当用户提到继续、推进或处理某个 Memory Master 项目，或明确给出项目名时：

1. 用 \`project_open\` 按名称或 ID 打开项目；名称有歧义时它会返回候选列表，向用户确认后再打开。所选项目在本会话内保持，用户明确切换前不要换。
2. 接手时先读 \`overview_read\`、\`task_list\`，接手续作再看近期 \`history_list\`，弄清现状再动手；写任何项目正文前，按已安装的 memory-master Skill 读「内容标准」的共同写作规则和本次涉及的板块。
3. 写入前先读：所有更新都必须带刚读到的 \`base_version\`；返回 VERSION_CONFLICT 时重读最新内容，比较后再决定是否重写。
4. 在接手、遇到阻塞、解除阻塞、完成任务时主动更新任务状态与概览进展；功能或交付内容确认可用后补写概览的「功能与用法」，项目组成、职责或流程变化时更新项目架构。
5. 需要用户拍板的事（会改变预期结果的选择、缺信息、缺权限）：直接在当前对话提出具体问题；用户给出答案后更新相关概览或任务记录。
6. 与项目无关的临时杂事照常完成，但**不要**写入项目数据；归属不明确时暂缓写入。
7. 凭据被拒或服务不可达时按实际报错告知用户（如到 Memory Master 设置页重新开启访问、启动应用），不要重试刷请求。
${MANAGED_END}`;
}

/**
 * The collaboration Skill — the detailed playbook agents load on demand.
 * Written to each client's skills directory by the installer.
 */
export const SKILL_MD = skillMd;

/**
 * Everything installed into each client's skills directory: SKILL.md plus
 * every file its relative links (and the files it links to) reference —
 * CONTENT-STANDARD, ARCHITECTURE-FORMAT, the specialized architecture draft,
 * and the upstream attribution/license. installSkill writes them
 * side-by-side so those links keep working; tests assert the closure stays
 * complete.
 */
export const SKILL_FILES: Record<string, string> = {
	"SKILL.md": skillMd,
	"CONTENT-STANDARD.md": contentStandardMd,
	"ARCHITECTURE-FORMAT.md": architectureFormatMd,
	"ARCHITECTURE-SKILL.md": architectureSkillMd,
	"UPSTREAM.md": upstreamMd,
	"UPSTREAM-LICENSE.md": upstreamLicenseMd,
};

/** Marker-guarded TOML section installed into Codex config.toml. */
export const CODEX_TOML_BEGIN = "# >>> memory-master >>>";
export const CODEX_TOML_END = "# <<< memory-master <<<";
