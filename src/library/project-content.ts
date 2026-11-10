/** Shared human-facing names used by project records, web content and MCP descriptions. */
export const PROJECT_CONTENT_NAMES = {
	description: "项目简介",
	current: "当前进展",
	goal: "目标",
	features: "功能与用法",
	agreements: "项目约定",
	criticalPaths: "关键路径",
	progress: "阶段进展",
} as const;

export const CRITICAL_PATHS_GUIDANCE =
	"每条写名称、用途和位置。本机条目标明本机或工作区。服务器条目写服务器名称和服务器内路径。";

/** Reading sections inside the same current-progress Markdown, shared with agent guidance. */
export const CURRENT_PROGRESS_HEADINGS = ["已完成", "当前停点", "未完成或未验证", "下一步", "需要你决定"] as const;
