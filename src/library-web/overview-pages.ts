import { PROJECT_CONTENT_NAMES } from "../library/project-content.ts";

/** Each overview subject has its own URL and reading/editing scope. */
export const OVERVIEW_PAGES = [
	{ field: "description", path: "", label: PROJECT_CONTENT_NAMES.description },
	{ field: "current", path: "progress", label: "进展与目标" },
	{ field: "features", path: "features", label: PROJECT_CONTENT_NAMES.features },
	{ field: "agreements", path: "agreements", label: PROJECT_CONTENT_NAMES.agreements },
] as const;

export type OverviewField = (typeof OVERVIEW_PAGES)[number]["field"];

export function overviewPagePath(projectId: string, path: string): string {
	return `/projects/${projectId}${path ? `/${path}` : ""}`;
}

export function isOverviewPage(projectId: string, pathname: string): boolean {
	const normalized = pathname.replace(/\/$/, "");
	return OVERVIEW_PAGES.some((page) => overviewPagePath(projectId, page.path) === normalized);
}
