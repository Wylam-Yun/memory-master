import { join } from "node:path";
import type { ProjectOverview } from "./types.ts";

/**
 * Project overview persistence.
 *
 * Each library project keeps its overview in `memaster/overview.md`: three
 * sections using the same `<!-- SECTION:NAME:BEGIN/END -->` marker convention
 * as task files. The file is the authoritative record of what the project is,
 * what it should achieve, and where it currently stands.
 */

export const OVERVIEW_FILE_NAME = "overview.md";

export const OVERVIEW_SECTION_KEYS = ["DESCRIPTION", "GOAL", "CURRENT"] as const;
export type OverviewSectionKey = (typeof OVERVIEW_SECTION_KEYS)[number];

const SECTION_HEADINGS: Record<OverviewSectionKey, string> = {
	DESCRIPTION: "项目简介",
	GOAL: "目标",
	CURRENT: "当前进展",
};

const SECTION_FIELD: Record<OverviewSectionKey, keyof ProjectOverview> = {
	DESCRIPTION: "description",
	GOAL: "goal",
	CURRENT: "current",
};

function beginMarker(key: OverviewSectionKey): string {
	return `<!-- SECTION:${key}:BEGIN -->`;
}

function endMarker(key: OverviewSectionKey): string {
	return `<!-- SECTION:${key}:END -->`;
}

export function overviewFilePath(projectDir: string): string {
	return join(projectDir, "memaster", OVERVIEW_FILE_NAME);
}

/** Initial overview content for a freshly created project. */
export function initialOverviewContent(projectName: string): string {
	return [
		"---",
		`title: "${projectName.replace(/"/g, '\\"')}"`,
		"---",
		"",
		renderOverviewSection("DESCRIPTION", `${projectName} —— 待补充这个项目是什么。`),
		"",
		renderOverviewSection("GOAL", "待补充想达成什么效果。"),
		"",
		renderOverviewSection("CURRENT", "项目刚创建。"),
		"",
	].join("\n");
}

function renderOverviewSection(key: OverviewSectionKey, body: string): string {
	return [`## ${SECTION_HEADINGS[key]}`, "", beginMarker(key), body.trimEnd(), endMarker(key)].join("\n");
}

function extractSection(content: string, key: OverviewSectionKey): string {
	const begin = beginMarker(key);
	const end = endMarker(key);
	const start = content.indexOf(begin);
	if (start === -1) return "";
	const bodyStart = start + begin.length;
	const stop = content.indexOf(end, bodyStart);
	if (stop === -1) return "";
	return content.slice(bodyStart, stop).trim();
}

/** Read the three maintained sections; a missing or partial file yields empty strings. */
export async function readOverview(projectDir: string): Promise<ProjectOverview> {
	const file = Bun.file(overviewFilePath(projectDir));
	const content = (await file.exists()) ? await file.text() : "";
	return {
		description: extractSection(content, "DESCRIPTION"),
		goal: extractSection(content, "GOAL"),
		current: extractSection(content, "CURRENT"),
	};
}

/**
 * Apply a partial update to the overview file, preserving untouched sections,
 * unmanaged headings and any free text outside the marked sections.
 */
export function applyOverviewUpdate(content: string, update: Partial<ProjectOverview>): string {
	let next = content;
	for (const key of OVERVIEW_SECTION_KEYS) {
		const field = SECTION_FIELD[key];
		const value = update[field];
		if (value === undefined) continue;
		const begin = beginMarker(key);
		const end = endMarker(key);
		const start = next.indexOf(begin);
		const stop = start === -1 ? -1 : next.indexOf(end, start + begin.length);
		if (stop === -1) {
			// Section missing entirely: append it in the canonical order at the end.
			next = `${next.trimEnd()}\n\n${renderOverviewSection(key, value)}\n`;
			continue;
		}
		next = `${next.slice(0, start + begin.length)}\n${value.trimEnd()}\n${next.slice(stop)}`;
	}
	return next;
}

/** Persist an overview update; returns the full updated overview. */
export async function writeOverview(projectDir: string, update: Partial<ProjectOverview>): Promise<ProjectOverview> {
	const path = overviewFilePath(projectDir);
	const file = Bun.file(path);
	const content = (await file.exists()) ? await file.text() : initialOverviewContent("");
	await Bun.write(path, applyOverviewUpdate(content, update));
	return await readOverview(projectDir);
}
