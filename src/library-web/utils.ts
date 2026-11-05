import type { HistoryEntry, Task } from "./api.ts";

/**
 * Pure helpers for the five-page library web UI — kept DOM-free so the helpers
 * test can exercise them without a browser.
 */

/** 网页只展示 P0：未填优先级的旧任务按 P0 计，其余值一律不显示。 */
export function isP0Task(task: Pick<Task, "priority">, p0: string): boolean {
	if (!task.priority) return true;
	// 手改文件可能留下大小写/空白不一致的值——按服务端 normalize 语义比较。
	return task.priority.trim().toLowerCase() === p0.trim().toLowerCase();
}

/** Done matches the project's configured terminal status, case-insensitively. */
export function isDoneStatus(status: string, doneStatus: string | null): boolean {
	return doneStatus !== null && status.trim().toLowerCase() === doneStatus.trim().toLowerCase();
}

export interface HistoryDayGroup {
	/** Local yyyy-mm-dd — stable sort key for the group. */
	key: string;
	/** 今天 / 昨天 / yyyy-mm-dd */
	label: string;
	entries: HistoryEntry[];
}

function dayKeyOf(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localDayKey(ts: string): string | null {
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? null : dayKeyOf(d);
}

/**
 * 变更记录按本地日分组，组内与组间均为最新在前。无法解析时间的条目归入末尾
 * 的兜底组——实际上不会发生（服务端只写 ISO）。
 */
export function groupHistoryByDay(entries: HistoryEntry[], now: Date = new Date()): HistoryDayGroup[] {
	const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
	const todayKey = dayKeyOf(now);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const yesterdayKey = dayKeyOf(yesterday);

	const groups: HistoryDayGroup[] = [];
	const byKey = new Map<string, HistoryDayGroup>();
	for (const entry of sorted) {
		const key = localDayKey(entry.ts) ?? "";
		let group = byKey.get(key);
		if (!group) {
			group = {
				key,
				label: key === todayKey ? "今天" : key === yesterdayKey ? "昨天" : key || "未知时间",
				entries: [],
			};
			byKey.set(key, group);
			groups.push(group);
		}
		group.entries.push(entry);
	}
	return groups;
}

/** 今天 / 昨天 / yyyy-mm-dd — the day granularity used in resource and history lists. */
export function dayLabel(ts: string, now: Date = new Date()): string {
	const key = localDayKey(ts);
	if (!key) return ts;
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	return key === dayKeyOf(now) ? "今天" : key === dayKeyOf(yesterday) ? "昨天" : key;
}

export function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
	return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export interface CompositionRow {
	/** 稳定 ID — matches the mermaid node id when the table has an ID column. */
	id: string;
	name: string;
	description: string;
	/** 来源 — optional, empty when the column is absent or the cell is blank. */
	source: string;
	/** 关联任务 IDs listed in the optional 关联任务 column. */
	tasks: string[];
}

function splitTableRow(line: string): string[] {
	return line
		.trim()
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((cell) => cell.trim());
}

function isTableDelimiterRow(line: string): boolean {
	const t = line.trim();
	return t.includes("-") && /^[\s|:\-–—]+$/.test(t);
}

/**
 * 组成表解析：取 Markdown 中第一个表头同时含「名称」「说明」的表格。列按表头
 * 文字定位（ID/名称/说明/来源/关联任务，缺列给空值）。找不到表格或表头不符
 * 合返回 []，调用方据此不渲染交互区。围栏代码块里的表格不参与解析。
 */
export function parseCompositionTable(markdown: string): CompositionRow[] {
	const lines = markdown.split("\n");
	let inFence = false;
	for (let i = 0; i < lines.length; i++) {
		const trimmed = (lines[i] ?? "").trim();
		if (/^(```|~~~)/.test(trimmed)) {
			inFence = !inFence;
			continue;
		}
		if (inFence || !trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
		const headers = splitTableRow(trimmed);
		const nameIdx = headers.findIndex((h) => h.includes("名称"));
		const descIdx = headers.findIndex((h) => h.includes("说明"));
		if (nameIdx === -1 || descIdx === -1) continue;
		if (!isTableDelimiterRow(lines[i + 1] ?? "")) continue;

		const idIdx = headers.findIndex((h) => /id/i.test(h));
		const srcIdx = headers.findIndex((h) => h.includes("来源"));
		const taskIdx = headers.findIndex((h) => h.includes("任务"));

		const rows: CompositionRow[] = [];
		for (let j = i + 2; j < lines.length; j++) {
			const rowLine = (lines[j] ?? "").trim();
			if (!rowLine.startsWith("|") || !rowLine.endsWith("|")) break;
			const cells = splitTableRow(rowLine);
			const get = (idx: number) => (idx >= 0 ? (cells[idx] ?? "").trim() : "");
			rows.push({
				id: get(idIdx),
				name: get(nameIdx),
				description: get(descIdx),
				source: get(srcIdx),
				tasks: get(taskIdx)
					.split(/[，,、;；\s]+/)
					.map((s) => s.trim())
					.filter(Boolean),
			});
		}
		return rows;
	}
	return [];
}

/**
 * Mermaid flowchart SVG nodes carry DOM ids like `flowchart-signup-0` — strip
 * the wrapper to recover the diagram's node id (best-effort, may not match).
 */
export function extractMermaidNodeId(domId: string): string | null {
	const m = /^flowchart-(.+)-\d+$/.exec(domId);
	return m?.[1] ?? null;
}
