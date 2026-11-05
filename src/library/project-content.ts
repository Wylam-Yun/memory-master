/** Shared human-facing names used by project records, web content and MCP descriptions. */
export const PROJECT_CONTENT_NAMES = {
	description: "项目简介",
	current: "当前进展",
	goal: "目标",
	features: "功能与用法",
	agreements: "项目约定",
	progress: "阶段进展",
} as const;

/** Reading sections inside the same current-progress Markdown, shared with agent guidance. */
export const CURRENT_PROGRESS_HEADINGS = ["已完成", "当前停点", "未完成或未验证", "下一步"] as const;
