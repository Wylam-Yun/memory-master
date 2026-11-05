import { join } from "node:path";
import type { ProjectOverview } from "./types.ts";

/**
 * Project overview persistence.
 *
 * Each library project keeps its overview in `memaster/overview.md`: maintained
 * sections using the same `<!-- SECTION:NAME:BEGIN/END -->` marker convention
 * as task files. The file is the authoritative record of what the project is,
 * what it should achieve, where it currently stands, and what it offers.
 */

export const OVERVIEW_FILE_NAME = "overview.md";

// New optional sections trail the array so older files preserve untouched content.
export const OVERVIEW_SECTION_KEYS = ["DESCRIPTION", "GOAL", "CURRENT", "FEATURES", "AGREEMENTS"] as const;
export type OverviewSectionKey = (typeof OVERVIEW_SECTION_KEYS)[number];

const SECTION_HEADINGS: Record<OverviewSectionKey, string> = {
	DESCRIPTION: "项目简介",
	GOAL: "目标",
	CURRENT: "当前进展",
	FEATURES: "功能与用法",
	AGREEMENTS: "项目约定",
};

const SECTION_FIELD: Record<OverviewSectionKey, keyof ProjectOverview> = {
	DESCRIPTION: "description",
	GOAL: "goal",
	CURRENT: "current",
	FEATURES: "features",
	AGREEMENTS: "agreements",
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

/** Match the same trimmed whole lines that section parsing recognizes. */
export function hasOverviewSectionMarker(value: string): boolean {
	return value.split("\n").some((line) => /^<!-- SECTION:[A-Z][A-Z0-9_]*:(BEGIN|END) -->$/.test(line.trim()));
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
		renderOverviewSection("FEATURES", "待补充当前可用的能力或交付内容及使用方法。"),
		"",
	].join("\n");
}

function renderOverviewSection(key: OverviewSectionKey, body: string): string {
	return [`## ${SECTION_HEADINGS[key]}`, "", beginMarker(key), body.trimEnd(), endMarker(key)].join("\n");
}

/**
 * Markers bind only as whole lines (same convention as task sections) — an
 * inline mention inside prose is just text, never a section boundary.
 */
function findMarkerLine(lines: string[], marker: string, fromIndex = 0): number {
	for (let i = fromIndex; i < lines.length; i++) {
		if (lines[i]?.trim() === marker) return i;
	}
	return -1;
}

function extractSection(content: string, key: OverviewSectionKey): string {
	const lines = content.split("\n");
	const start = findMarkerLine(lines, beginMarker(key));
	if (start === -1) return "";
	const stop = findMarkerLine(lines, endMarker(key), start + 1);
	if (stop === -1) return "";
	return lines
		.slice(start + 1, stop)
		.join("\n")
		.trim();
}

/** Parse the maintained sections out of file text; missing sections yield "". */
export function parseOverviewContent(content: string): ProjectOverview {
	return {
		agreements: extractSection(content, "AGREEMENTS"),
		description: extractSection(content, "DESCRIPTION"),
		goal: extractSection(content, "GOAL"),
		current: extractSection(content, "CURRENT"),
		features: extractSection(content, "FEATURES"),
	};
}

/** Read the maintained sections; a missing or partial file yields empty strings. */
export async function readOverview(projectDir: string): Promise<ProjectOverview> {
	const file = Bun.file(overviewFilePath(projectDir));
	const content = (await file.exists()) ? await file.text() : "";
	return parseOverviewContent(content);
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
		const lines = next.split("\n");
		const start = findMarkerLine(lines, beginMarker(key));
		const stop = start === -1 ? -1 : findMarkerLine(lines, endMarker(key), start + 1);
		if (stop === -1) {
			// Old clients and unrelated edits do not migrate a missing, empty agreement section.
			if (key === "AGREEMENTS" && !value.trim()) continue;
			// Section missing entirely: append it in the canonical order at the end.
			next = `${next.trimEnd()}\n\n${renderOverviewSection(key, value)}\n`;
			continue;
		}
		next = [...lines.slice(0, start + 1), value.trimEnd(), ...lines.slice(stop)].join("\n");
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
