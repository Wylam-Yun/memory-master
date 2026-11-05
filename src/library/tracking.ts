import { randomUUID } from "node:crypto";
import { diffFields, type HistoryTarget } from "./history.ts";
import { LIBRARY_ERROR_CODES, LibraryError } from "./types.ts";

export type GoalStatus = "active" | "completed" | "adjusted";
export interface Goal {
	id: string;
	key: string;
	title: string;
	status: GoalStatus;
	requiresConfirmation: boolean;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	adjustedAt: string | null;
	replacementId?: string;
}
export interface Progress {
	id: string;
	key: string;
	title: string;
	summary: string;
	goalId?: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
}
export interface Tracking {
	schema: 1;
	currentUpdatedAt: string | null;
	goals: Goal[];
	progress: Progress[];
}
export interface TrackingPage<T> {
	items: T[];
	total: number;
	offset: number;
	limit: number;
	version: string;
}
const BEGIN = "<!-- SECTION:TRACKING:BEGIN -->";
const END = "<!-- SECTION:TRACKING:END -->";
const empty = (): Tracking => ({ schema: 1, currentUpdatedAt: null, goals: [], progress: [] });
const invalid = (message: string): never => {
	throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, message, 400);
};
const conflict = (message: string): never => {
	throw new LibraryError(LIBRARY_ERROR_CODES.VERSION_CONFLICT, message, 409);
};
const normalized = (title: string) => title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
function text(value: unknown, field: string, oneLine = false): string {
	if (typeof value !== "string" || !value.trim()) return invalid(`${field}不能为空。`);
	if (oneLine && /[\r\n]/.test(value)) return invalid(`${field}请用一句话填写。`);
	if (/^<!-- SECTION:[A-Z][A-Z0-9_]*:(BEGIN|END) -->$/m.test(value)) return invalid(`${field}包含保留标记。`);
	return value.trim();
}
export function checkFields(input: Record<string, unknown>, allowed: string[]) {
	for (const key of Object.keys(input))
		if (!allowed.includes(key)) invalid(`不支持字段 ${key}，请使用工具提供的字段。`);
}
export function occurrence(value: unknown, now: string): string | null {
	if (value === undefined) return now;
	if (value === null) return null;
	if (typeof value !== "string") return invalid("完成或调整日期必须是日期字符串，未知时传null。");
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
	const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
	const parsed = new Date(value);
	if ((!dateOnly && !iso) || Number.isNaN(parsed.getTime())) return invalid("日期格式不正确。");
	// Date parses February 30 by rolling forward; reject that silent normalization.
	if (dateOnly && parsed.toISOString().slice(0, 10) !== value) return invalid("日期不存在。");
	if (!dateOnly) {
		const ymd = value.slice(0, 10);
		const d = new Date(ymd);
		if (d.toISOString().slice(0, 10) !== ymd) return invalid("日期不存在。");
	}
	const localNow = new Date(now);
	const localToday = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, "0")}-${String(localNow.getDate()).padStart(2, "0")}`;
	if ((dateOnly && value > localToday) || (!dateOnly && parsed.getTime() > localNow.getTime()))
		return invalid("完成或调整日期不能在未来。");
	return value;
}
function bounds(source: string) {
	const lines = source.split("\n");
	const a = lines.findIndex((l) => l.trim() === BEGIN);
	const b = lines.findIndex((l) => l.trim() === END);
	if (a < 0 && b < 0) return null;
	if (
		a < 0 ||
		b <= a ||
		lines.filter((l) => l.trim() === BEGIN).length !== 1 ||
		lines.filter((l) => l.trim() === END).length !== 1
	)
		return invalid("目标与阶段记录标记损坏，未覆盖原文件。");
	return { lines, a, b };
}
export function readTracking(source: string): Tracking {
	const block = bounds(source);
	if (!block) return empty();
	const raw = block.lines
		.slice(block.a + 1, block.b)
		.join("\n")
		.trim();
	const match = /^```json\s*\n([\s\S]*)\n```$/.exec(raw);
	if (!match?.[1]) return invalid("目标与阶段记录格式损坏，未覆盖原文件。");
	let data: Tracking;
	try {
		data = JSON.parse(match[1]);
	} catch {
		return invalid("目标与阶段记录无法解析，未覆盖原文件。");
	}
	if (
		data?.schema !== 1 ||
		!Array.isArray(data.goals) ||
		!Array.isArray(data.progress) ||
		!(data.currentUpdatedAt === null || typeof data.currentUpdatedAt === "string")
	)
		return invalid("不支持的目标与阶段记录格式。");
	const ids = new Set<string>();
	for (const row of [...data.goals, ...data.progress]) {
		if (
			!row ||
			typeof row.id !== "string" ||
			typeof row.key !== "string" ||
			typeof row.title !== "string" ||
			typeof row.createdAt !== "string" ||
			typeof row.updatedAt !== "string" ||
			!(row.completedAt === null || typeof row.completedAt === "string") ||
			ids.has(row.id)
		)
			return invalid("目标或阶段记录损坏，未覆盖原文件。");
		ids.add(row.id);
	}
	for (const g of data.goals)
		if (
			!["active", "completed", "adjusted"].includes(g.status) ||
			typeof g.requiresConfirmation !== "boolean" ||
			!(g.adjustedAt === null || typeof g.adjustedAt === "string")
		)
			invalid("目标状态损坏。");
	for (const p of data.progress) if (typeof p.summary !== "string") invalid("阶段说明损坏。");
	return data;
}
export function writeTracking(source: string, data: Tracking): string {
	const body = ["```json", JSON.stringify(data, null, 2), "```"].join("\n");
	const block = bounds(source);
	if (!block) return `${source.trimEnd()}\n\n## 目标与阶段记录\n\n${BEGIN}\n${body}\n${END}\n`;
	return [...block.lines.slice(0, block.a + 1), body, ...block.lines.slice(block.b)].join("\n");
}
export function trackingSummary(source: string) {
	const t = readTracking(source);
	return {
		goals: t.goals.filter((g) => g.status === "active"),
		currentUpdatedAt: t.currentUpdatedAt,
		archiveCounts: {
			completed: t.goals.filter((g) => g.status === "completed").length,
			adjusted: t.goals.filter((g) => g.status === "adjusted").length,
			progress: t.progress.length,
		},
	};
}
const recordFields = (row: Goal | Progress | undefined): Record<string, string> =>
	row
		? Object.fromEntries(Object.entries(row).map(([key, v]) => [key, typeof v === "string" ? v : JSON.stringify(v)]))
		: {};
function addGoal(t: Tracking, input: Record<string, unknown>, now: string): Goal {
	const key = text(input.key, "key", true);
	const title = text(input.title, "目标", true);
	if (input.requiresConfirmation !== undefined && typeof input.requiresConfirmation !== "boolean")
		invalid("requiresConfirmation必须是布尔值。");
	const confirmation = input.requiresConfirmation === true;
	const same = t.goals.find((g) => g.key === key) || t.goals.find((g) => normalized(g.title) === normalized(title));
	if (same) {
		if (normalized(same.title) !== normalized(title) || same.requiresConfirmation !== confirmation)
			conflict("此目标key或名称已存在，内容不同；请先读取现有目标。");
		return same;
	}
	const goal: Goal = {
		id: `GOAL-${randomUUID()}`,
		key,
		title,
		status: "active",
		requiresConfirmation: confirmation,
		createdAt: now,
		updatedAt: now,
		completedAt: null,
		adjustedAt: null,
	};
	t.goals.push(goal);
	return goal;
}
function addProgress(t: Tracking, input: Record<string, unknown>, now: string): Progress {
	checkFields(input, ["key", "title", "summary", "completedAt", "goalId"]);
	const key = text(input.key, "key", true);
	const title = text(input.title, "成果标题", true);
	const summary = text(input.summary, "成果说明");
	const goalId = input.goalId === undefined ? undefined : text(input.goalId, "目标ID", true);
	if (goalId && !t.goals.some((g) => g.id === goalId)) invalid("关联目标不在当前项目中。");
	const same =
		t.progress.find((p) => p.key === key) ||
		t.progress.find((p) => normalized(p.title) === normalized(title) && p.goalId === goalId);
	if (same) {
		if (
			normalized(same.title) !== normalized(title) ||
			same.summary !== summary ||
			same.goalId !== goalId ||
			(input.completedAt !== undefined && same.completedAt !== occurrence(input.completedAt, now))
		)
			conflict("此成果key或名称已存在，内容不同；请先读取并使用progress_update修正。");
		return same;
	}
	const p: Progress = {
		id: `PROGRESS-${randomUUID()}`,
		key,
		title,
		summary,
		...(goalId ? { goalId } : {}),
		createdAt: now,
		updatedAt: now,
		completedAt: occurrence(input.completedAt, now),
	};
	t.progress.push(p);
	return p;
}
export function mutateTracking(
	original: Tracking,
	kind: "goals" | "progress",
	id: string | null,
	input: Record<string, unknown>,
	isAgent: boolean,
	now = new Date().toISOString(),
) {
	const data = structuredClone(original);
	let record: Goal | Progress;
	let before: Goal | Progress | undefined;
	if (kind === "goals" && !id) {
		checkFields(input, ["key", "title", "requiresConfirmation"]);
		record = addGoal(data, input, now);
		before = original.goals.find((g) => g.id === record.id);
	} else if (kind === "progress" && !id) {
		record = addProgress(data, input, now);
		before = original.progress.find((p) => p.id === record.id);
	} else if (kind === "goals") {
		checkFields(input, ["status", "confirmed", "occurredAt", "replacementTitle", "current", "progress"]);
		const g = data.goals.find((g) => g.id === id);
		if (!g) return invalid("未找到当前项目的目标。");
		before = structuredClone(g);
		record = g;
		if (input.status !== "completed" && input.status !== "adjusted") invalid("目标状态应为completed或adjusted。");
		if (input.confirmed !== undefined && typeof input.confirmed !== "boolean") invalid("confirmed必须是布尔值。");
		if (isAgent && input.status === "completed" && g.requiresConfirmation && input.confirmed !== true)
			invalid("此目标完成前需要用户在聊天中确认。确认后传confirmed=true。");
		if (g.status !== "active" && g.status !== input.status) conflict("目标已归档，请保留历史并创建新的目标。");
		if (input.replacementTitle !== undefined && input.status !== "adjusted") invalid("只有调整目标才能填写替代目标。");
		const date =
			input.occurredAt === undefined && g.status === input.status
				? g.status === "completed"
					? g.completedAt
					: g.adjustedAt
				: occurrence(input.occurredAt, now);
		if (g.status !== input.status || (input.status === "completed" ? g.completedAt : g.adjustedAt) !== date) {
			g.status = input.status as GoalStatus;
			g.updatedAt = now;
			if (g.status === "completed") g.completedAt = date;
			else g.adjustedAt = date;
		}
		if (input.replacementTitle !== undefined) {
			const next = addGoal(
				data,
				{ key: `replacement:${g.id}`, title: input.replacementTitle, requiresConfirmation: g.requiresConfirmation },
				now,
			);
			g.replacementId = next.id;
		}
		if (input.progress !== undefined) {
			if (!input.progress || typeof input.progress !== "object" || Array.isArray(input.progress))
				invalid("progress必须是成果对象。");
			if (input.status !== "completed") invalid("只有完成目标时可同时记录阶段成果。");
			addProgress(data, { ...(input.progress as Record<string, unknown>), goalId: g.id }, now);
		}
		if (input.current !== undefined) text(input.current, "当前进展");
	} else {
		checkFields(input, ["title", "summary", "completedAt"]);
		const p = data.progress.find((p) => p.id === id);
		if (!p) return invalid("未找到当前项目的阶段成果。");
		before = structuredClone(p);
		record = p;
		if (Object.keys(input).length === 0) invalid("请填写要修正的成果内容。");
		if (input.title !== undefined) p.title = text(input.title, "成果标题", true);
		if (input.summary !== undefined) p.summary = text(input.summary, "成果说明");
		if (input.completedAt !== undefined) p.completedAt = occurrence(input.completedAt, now);
		if (
			data.progress.some(
				(other) => other.id !== p.id && normalized(other.title) === normalized(p.title) && other.goalId === p.goalId,
			)
		)
			conflict("已经存在相同名称的阶段成果。");
		if (JSON.stringify(p) !== JSON.stringify(before)) p.updatedAt = now;
	}
	const changes = diffFields(recordFields(before), recordFields(record));
	if (JSON.stringify(data.progress) !== JSON.stringify(original.progress) && kind === "goals")
		changes.progress = { from: JSON.stringify(original.progress), to: JSON.stringify(data.progress) };
	if (kind === "goals" && data.goals.length !== original.goals.length && id)
		changes.replacement = { to: JSON.stringify(data.goals.at(-1)) };
	const target: HistoryTarget = { type: kind === "goals" ? "goal" : "progress", id: record.id, title: record.title };
	return { data, record, target, changes, action: before ? ("update" as const) : ("create" as const) };
}
export function trackingPage(
	source: string,
	kind: "goals" | "progress",
	params: URLSearchParams,
	version: string,
): TrackingPage<Goal | Progress> {
	const data = readTracking(source);
	const status = params.get("status") ?? "active";
	if (kind === "goals" && !["active", "completed", "adjusted", "all"].includes(status)) invalid("目标状态筛选不正确。");
	const parse = (name: string, fallback: number, max: number) => {
		const s = params.get(name);
		if (s === null) return fallback;
		if (!/^\d+$/.test(s)) return invalid(`${name}必须是非负整数。`);
		const n = Number(s);
		if (!Number.isSafeInteger(n) || n > max) return invalid(`${name}超出范围。`);
		return n;
	};
	const offset = parse("offset", 0, Number.MAX_SAFE_INTEGER);
	const limit = parse("limit", 20, 100);
	if (limit === 0) invalid("limit至少为1。");
	const rows: (Goal | Progress)[] =
		kind === "progress" ? [...data.progress] : data.goals.filter((g) => status === "all" || g.status === status);
	const when = (r: Goal | Progress) => r.completedAt || ("adjustedAt" in r ? r.adjustedAt : null) || r.createdAt;
	rows.sort(
		(a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
	);
	return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit, version };
}
