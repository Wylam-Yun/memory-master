import { basename } from "node:path";
import { Core } from "../core/memaster.ts";
import type { FileSystem } from "../file-system/operations.ts";
import type { MemasterConfig, Task } from "../types/index.ts";
import { getPriorityValues, resolvePriorityValue } from "../utils/priority-config.ts";
import { getTerminalStatus } from "../utils/terminal-status.ts";
import { contentVersion } from "./history.ts";
import { LIBRARY_ERROR_CODES, LibraryError, type LibraryProject } from "./types.ts";

/**
 * Per-project read/write helper bound to one library project.
 *
 * Reads go straight to the filesystem (never the ContentStore, which would go
 * stale since this Core runs without watchers); writes go through Core's
 * create/update paths so every existing invariant — status normalization,
 * section-sentinel validation, ID allocation, updatedDate — applies unchanged.
 */

export type TaskWriteInput = {
	title?: string;
	status?: string;
	description?: string;
	priority?: string;
};

export class ProjectStore {
	readonly project: LibraryProject;
	readonly core: Core;
	private writeChain: Promise<unknown> = Promise.resolve();

	constructor(project: LibraryProject) {
		this.project = project;
		this.core = new Core(project.dir, { enableWatchers: false });
	}

	get filesystem(): FileSystem {
		return this.core.filesystem;
	}

	/**
	 * Serializes every write that touches this project (tasks + overview share
	 * one changelog, so they share one queue). Inside the lock, "record write →
	 * history append → rollback-on-failure" is one indivisible unit: no other
	 * service writer can interleave between the state change and its record.
	 */
	async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.writeChain
			.catch(() => {})
			.then(async () => {
				const file = Bun.file(this.filesystem.configFilePath);
				if (!(await file.exists())) {
					throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, "Project has been deleted.", 404);
				}
				const config = this.filesystem.parseConfig(await file.text());
				if ((config.projectId ?? `dir-${basename(this.project.dir)}`) !== this.project.id) {
					throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, "Project has been replaced.", 404);
				}
				return fn();
			});
		this.writeChain = run.catch(() => {});
		return run;
	}

	/** Content-hash version of a task's file on disk; undefined when unreadable. */
	async taskVersion(task: Pick<Task, "filePath">): Promise<string | undefined> {
		const filePath = task.filePath?.trim();
		if (!filePath) return undefined;
		try {
			return contentVersion(await Bun.file(filePath).bytes());
		} catch {
			return undefined;
		}
	}

	async listTasks(status?: string): Promise<Task[]> {
		return await this.filesystem.listTasks(status ? { status } : undefined);
	}

	async getTask(taskId: string): Promise<Task | null> {
		return await this.filesystem.loadTask(taskId);
	}

	/** A project directory without a readable config answers as not found. */
	private async requireConfig(): Promise<MemasterConfig> {
		const config = await this.filesystem.loadConfig();
		if (!config) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND,
				`Project at ${this.project.dir} has no readable configuration.`,
				404,
			);
		}
		return config;
	}

	/** Validate a requested status against the project's configured statuses. */
	async assertValidStatus(status: string): Promise<string> {
		const config = await this.requireConfig();
		const found = config.statuses.find((s) => s.toLowerCase() === status.toLowerCase());
		if (!found) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				`Invalid status "${status}". Valid statuses: ${config.statuses.join(", ")}.`,
				400,
			);
		}
		return found;
	}

	/**
	 * The labels this project accepts as task priorities: the configured list,
	 * or P0/P1 when unset — always containing both P0 and P1 so the library UI
	 * can rely on that vocabulary even over older hand-made configs.
	 */
	private effectivePriorityLabels(config: MemasterConfig): string[] {
		const effective = config.priorities?.length ? [...config.priorities] : ["P0", "P1"];
		// Membership is decided on normalized values (P0 → "p0"), so a configured
		// "p0" already counts and the literal label is never duplicated.
		const values = new Set(getPriorityValues(effective));
		for (const required of ["P0", "P1"] as const) {
			const normalized = required.toLowerCase();
			if (!values.has(normalized)) {
				values.add(normalized);
				effective.push(required);
			}
		}
		return effective;
	}

	/** Validate a requested priority against the effective list; returns its normalized value. */
	async assertValidPriority(priority: string): Promise<string> {
		const effective = this.effectivePriorityLabels(await this.requireConfig());
		const resolved = resolvePriorityValue(priority, effective);
		if (!resolved) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				`Invalid priority "${priority}". Valid priorities: ${effective.join(", ")}.`,
				400,
			);
		}
		return resolved;
	}

	/**
	 * Lazy migration, called only inside the project write lock: persist the
	 * effective labels when the config doesn't already carry them, so Core's
	 * own priority normalization sees the P0/P1 vocabulary. saveConfig rewrites
	 * the whole file from known keys — idempotent and lossless for configs this
	 * service produced, but hand-added comments/unknown keys on older projects
	 * are dropped (accepted: the file carries no history entry for this).
	 */
	async ensureTaskPriorities(): Promise<void> {
		const config = await this.requireConfig();
		const effective = this.effectivePriorityLabels(config);
		const current = config.priorities ?? [];
		if (current.length === effective.length && current.every((label, index) => label === effective[index])) return;
		config.priorities = effective;
		await this.filesystem.saveConfig(config);
	}

	/** Task metadata the web UI needs: status vocabulary and the P0/P1 values. */
	async projectMeta(): Promise<{ statuses: string[]; doneStatus: string | null; p0: string; p1: string }> {
		const config = await this.requireConfig();
		const effective = this.effectivePriorityLabels(config);
		return {
			statuses: config.statuses,
			doneStatus: getTerminalStatus(config.statuses),
			// effective contains P0/P1 by construction — the fallbacks only narrow the type.
			p0: resolvePriorityValue("P0", effective) ?? "p0",
			p1: resolvePriorityValue("P1", effective) ?? "p1",
		};
	}
}
