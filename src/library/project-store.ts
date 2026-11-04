import { Core } from "../core/memaster.ts";
import type { FileSystem } from "../file-system/operations.ts";
import type { Task } from "../types/index.ts";
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
		const run = this.writeChain.catch(() => {}).then(fn);
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

	/** Validate a requested status against the project's configured statuses. */
	async assertValidStatus(status: string): Promise<string> {
		const config = await this.filesystem.loadConfig();
		if (!config) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND,
				`Project at ${this.project.dir} has no readable configuration.`,
				404,
			);
		}
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
}
