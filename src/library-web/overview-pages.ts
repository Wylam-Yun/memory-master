/** Existing overview URLs open the corresponding section of the project overview. */
export const OVERVIEW_PAGES = [
	{ field: "description", path: "intro" },
	{ field: "current", path: "progress" },
	{ field: "features", path: "features" },
	{ field: "agreements", path: "agreements" },
	{ field: "criticalPaths", path: "critical-paths" },
] as const;

export type OverviewField = (typeof OVERVIEW_PAGES)[number]["field"];

export function overviewPagePath(projectId: string, path: string): string {
	return `/projects/${projectId}${path ? `/${path}` : ""}`;
}

export function isOverviewPage(projectId: string, pathname: string): boolean {
	const normalized = pathname.replace(/\/$/, "");
	return (
		normalized === overviewPagePath(projectId, "") ||
		OVERVIEW_PAGES.some((page) => overviewPagePath(projectId, page.path) === normalized)
	);
}
