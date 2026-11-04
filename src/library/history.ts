import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Per-project change history （变更记录）.
 *
 * Every successful project mutation appends one JSON line to
 * `memaster/changelog.jsonl`: timestamp, who did it, which record, and the
 * before/after values of the fields that actually changed. The file is
 * append-only — the single-instance service serializes appends under the
 * project's write lock, and readers tolerate a torn trailing line (they can
 * observe an append mid-write).
 */

export const CHANGELOG_FILE_NAME = "changelog.jsonl";

/** Who performed a change: the local human ("user") or an authorized agent client. */
export type Actor = { type: "user" } | { type: "agent"; client: string };

export interface HistoryTarget {
	type: "project" | "task" | "overview";
	/** Task ID or project ID; undefined for the overview record. */
	id?: string;
	/** Display title at the time of the change, when known. */
	title?: string;
}

export interface FieldChange {
	from?: string;
	to?: string;
}

export interface HistoryEntry {
	ts: string;
	actor: Actor;
	target: HistoryTarget;
	action: "create" | "update";
	changes: Record<string, FieldChange>;
	/** Record version after the write (content hash). */
	version: string;
}

export function changelogPath(projectDir: string): string {
	return join(projectDir, "memaster", CHANGELOG_FILE_NAME);
}

/**
 * The record version: a content hash. Any byte change — including edits made
 * outside the service — produces a new version, so stale writers conflict
 * rather than silently overwrite.
 */
export function contentVersion(content: string | Buffer | Uint8Array): string {
	const bytes = typeof content === "string" ? content : new Uint8Array(content);
	const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	return `sha256:${hash.slice(0, 16)}`;
}

/** Diff two records into a `changes` map; identical values are dropped. */
export function diffFields(
	before: Record<string, string | undefined>,
	after: Record<string, string | undefined>,
): Record<string, FieldChange> {
	const changes: Record<string, FieldChange> = {};
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		const from = before[key];
		const to = after[key];
		if (from === to) continue;
		const change: FieldChange = {};
		if (from !== undefined) change.from = from;
		if (to !== undefined) change.to = to;
		changes[key] = change;
	}
	return changes;
}

export async function appendHistory(projectDir: string, entry: HistoryEntry): Promise<void> {
	const path = changelogPath(projectDir);
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read the changelog newest-last (file order). `since`/`until` are ISO
 * timestamps compared lexically — both bounds inclusive. Unparseable lines
 * (a torn tail from a concurrent append) are skipped.
 */
export async function readHistory(
	projectDir: string,
	range: { since?: string; until?: string } = {},
): Promise<HistoryEntry[]> {
	const file = Bun.file(changelogPath(projectDir));
	if (!(await file.exists())) return [];
	const entries: HistoryEntry[] = [];
	for (const line of (await file.text()).split("\n")) {
		if (!line.trim()) continue;
		let entry: HistoryEntry;
		try {
			entry = JSON.parse(line) as HistoryEntry;
		} catch {
			continue;
		}
		if (typeof entry?.ts !== "string") continue;
		if (range.since && entry.ts < range.since) continue;
		if (range.until && entry.ts > range.until) continue;
		entries.push(entry);
	}
	return entries;
}
