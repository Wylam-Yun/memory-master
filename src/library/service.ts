import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { TaskWriteHooks } from "../core/memaster.ts";
import libraryIndexHtml from "../library-web/index.html";
import type { Task } from "../types/index.ts";
import { getVersion } from "../utils/version.ts";
import { instructionBlock, SKILL_FILES, SKILL_MD } from "./agent-content.ts";
import { architectureFilePath } from "./architecture.ts";
import { installClient } from "./client-setup.ts";
import { type Actor, appendHistory, contentVersion, diffFields, type HistoryEntry, readHistory } from "./history.ts";
import { applyOverviewUpdate, initialOverviewContent, overviewFilePath, parseOverviewContent } from "./overview.ts";
import { ProjectStore, type TaskWriteInput } from "./project-store.ts";
import { answerQuestion, createQuestion, getQuestion, listQuestions, type ProjectQuestion } from "./questions.ts";
import { createProject, getProjectById, listProjects, resolveProject } from "./registry.ts";
import { assertSafeResourceName, listResources, readResource, resourcesDir, saveResource } from "./resources.ts";
import { AppSettingsStore } from "./settings.ts";
import { TestHolds } from "./test-holds.ts";
import { checkFields, mutateTracking, readTracking, trackingPage, trackingSummary, writeTracking } from "./tracking.ts";
import {
	isLibraryClientId,
	LIBRARY_CLIENT_IDS,
	LIBRARY_CLIENT_LABELS,
	LIBRARY_ERROR_CODES,
	type LibraryClientId,
	LibraryError,
	type LibraryProject,
	versionConflictError,
} from "./types.ts";

const SERVICE_HOST = "127.0.0.1";

/** Same sentinel guard tasks get — a marker line inside an overview value would hijack parsing. */
const SECTION_MARKER_LINE = /^<!-- SECTION:[A-Z][A-Z0-9_]*:(BEGIN|END) -->$/m;

/** The service answers loopback hosts only; anything else is treated as a rebinding attempt. */
function isLoopbackHost(req: Request): boolean {
	const raw = req.headers.get("host") ?? "";
	// Host forms: "127.0.0.1", "127.0.0.1:6420", "localhost:6420", "[::1]", "[::1]:6420".
	const host = raw.startsWith("[") ? raw.slice(0, raw.indexOf("]") + 1) : raw.split(":")[0];
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

export function defaultLibraryRoot(): string {
	return join(homedir(), "Documents", "MemoryMaster");
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function errorResponse(error: unknown): Response {
	if (error instanceof LibraryError) {
		return json({ error: error.message, code: error.code, ...(error.details ?? {}) }, error.status);
	}
	const message = error instanceof Error ? error.message : String(error);
	// Lock contention (ELOCKED / lock acquisition failures) is a conflict, not a crash.
	if (/lock/i.test(message)) {
		return json({ error: message, code: "CONFLICT" }, 409);
	}
	return json({ error: message }, 500);
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
	// Cross-site "simple" requests (form posts) cannot set this content type, so
	// requiring it closes the CSRF surface on top of the loopback Host allowlist.
	const contentType = req.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Requests must use content-type application/json.", 415);
	}
	try {
		const body = await req.json();
		return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
	} catch {
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Request body must be valid JSON.", 400);
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The Memory Master local service.
 *
 * One process = the application's lifetime: the web UI is only a view onto it,
 * so closing the page changes nothing; stopping the process ends every client
 * access. Serves three route families:
 *   - the library web UI (SPA bundle)
 *   - /api/* for the web UI itself — loopback-only, no credential.
 *     It is never written to disk or served over HTTP, so an agent on the same
 *     machine has no way to obtain it through the service itself — revoking a
 *     client therefore closes every Memory Master interface to it, not only
 *     the MCP routes. (An agent that can read the user's own terminal/browser
 *     could still steal it, but at that point reading the project files
 *     directly is strictly easier — same-UID processes are out of scope.)
 *   - /api/agent/* for MCP bridges (Bearer credential + per-request auth check)
 */
export class LibraryService {
	readonly settings: AppSettingsStore;
	readonly holds: TestHolds;

	private server: Server<unknown> | null = null;
	private readonly stores = new Map<string, ProjectStore>();
	private stopping = false;
	private releaseInstanceLock: (() => Promise<void>) | null = null;

	constructor(options: { settings?: AppSettingsStore; holds?: TestHolds } = {}) {
		this.settings = options.settings ?? new AppSettingsStore();
		this.holds = options.holds ?? new TestHolds();
	}

	getPort(): number | null {
		return this.server?.port ?? null;
	}

	baseUrl(): string {
		const port = this.getPort();
		if (port === null) throw new Error("Service is not running.");
		return `http://${SERVICE_HOST}:${port}`;
	}

	/** The configured library root, or a 409-style error when the user has not chosen one yet. */
	private async requireLibraryRoot(): Promise<string> {
		const root = await this.settings.getLibraryRoot();
		if (!root) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.LIBRARY_NOT_SET,
				"No memory library selected yet. Choose one in the Memory Master settings page.",
				409,
			);
		}
		return root;
	}

	private async projectFor(id: string): Promise<LibraryProject> {
		return await getProjectById(await this.requireLibraryRoot(), id);
	}

	private storeFor(project: LibraryProject): ProjectStore {
		let store = this.stores.get(project.dir);
		if (!store) {
			store = new ProjectStore(project);
			this.stores.set(project.dir, store);
		}
		return store;
	}

	// --- Authorization --------------------------------------------------------

	/** Bearer credential → client slot; throws 401 unknown / 403 disabled. */
	private async requireClient(req: Request): Promise<LibraryClientId> {
		const header = req.headers.get("authorization") ?? "";
		const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
		return await this.settings.assertAuthorized(token || null);
	}

	// --- Write paths ------------------------------------------------------------
	// Every mutation funnels through one atomic unit per project:
	//   project write lock → (entry client check at route) → Core write with a
	//   preWrite re-check inside the entity lock → history append → rollback on
	//   failure. A revoke that has already returned always beats a write still
	//   parked before commit, and a record update never lands without its
	//   history entry — the pair commits or neither does.

	/** Who is writing: an authorized agent identity, or null for the web user. */
	private actorOf(identity: { id: LibraryClientId } | null): Actor {
		return identity ? { type: "agent", client: identity.id } : { type: "user" };
	}

	private writeHooks(clientToken: string | null, versionCheck?: () => Promise<void>): TaskWriteHooks {
		return {
			preWrite: async () => {
				await this.holds.waitIfAny();
				if (this.stopping) {
					throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "The Memory Master service is stopping.", 503);
				}
				if (clientToken !== null) await this.settings.assertAuthorized(clientToken);
				if (versionCheck) await versionCheck();
			},
		};
	}

	/** Stop signal shared by every write path, checked inside entity locks. */
	private assertRunning(): void {
		if (this.stopping) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "The Memory Master service is stopping.", 503);
		}
	}

	private async taskWithVersion(store: ProjectStore, task: Task): Promise<Task & { version?: string }> {
		return { ...task, version: await store.taskVersion(task) };
	}

	private async overviewWithVersion(projectDir: string): Promise<unknown> {
		const file = Bun.file(overviewFilePath(projectDir));
		// One read feeds both the returned content and its version — two reads
		// could race a writer and hand back a mismatched pair.
		const bytes = (await file.exists()) ? await file.bytes() : new Uint8Array();
		const source = new TextDecoder().decode(bytes);
		return { ...parseOverviewContent(source), ...trackingSummary(source), version: contentVersion(bytes) };
	}

	private async writeTask(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		taskId: string | null,
		input: TaskWriteInput,
		baseVersion: string | undefined,
	): Promise<Task & { version?: string }> {
		const store = this.storeFor(await this.projectFor(projectId));
		// Validate up front for a 400 (Core would otherwise throw a plain 500 error).
		const status = input.status !== undefined ? await store.assertValidStatus(input.status) : undefined;
		const priority = input.priority !== undefined ? await store.assertValidPriority(input.priority) : undefined;
		if (status?.toLowerCase() === "draft") {
			// Demotion bypasses updateTaskFromInput's hook seam; library projects have no
			// draft concept in phase 1, so refuse it outright at the boundary.
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, 'Status "Draft" is not supported here.', 400);
		}
		if (taskId && baseVersion === undefined) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"baseVersion is required for updates — read the record first and send back its version.",
				400,
			);
		}
		const actor = this.actorOf(identity);
		const token = identity?.token ?? null;

		return await store.withWriteLock(async () => {
			if (!taskId) {
				if (!input.title?.trim()) {
					throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Task title is required.", 400);
				}
				const hooks = this.writeHooks(token);
				// Creates normalize priority inside createTaskFromInput — BEFORE
				// preWrite runs — so the P0/P1 config vocabulary has to exist by
				// call time. The migration still waits for the same gates the
				// write itself waits for: a parked-then-revoked write leaves
				// config.yml untouched too.
				await this.holds.waitIfAny();
				this.assertRunning();
				if (token !== null) await this.settings.assertAuthorized(token);
				await store.ensureTaskPriorities();
				const { task, filePath } = await store.core.createTaskFromInput(
					{
						title: input.title,
						...(status !== undefined ? { status } : {}),
						...(input.description !== undefined ? { description: input.description } : {}),
						priority: priority ?? "p0",
					},
					false,
					hooks,
				);
				const version = (await store.taskVersion({ filePath })) ?? "";
				const entry: HistoryEntry = {
					ts: new Date().toISOString(),
					actor,
					target: { type: "task", id: task.id, title: task.title },
					action: "create",
					changes: diffFields(
						{},
						{
							title: task.title,
							...(task.status !== undefined ? { status: task.status } : {}),
							...(task.description !== undefined ? { description: task.description } : {}),
							...(task.priority !== undefined ? { priority: task.priority } : {}),
						},
					),
					version,
				};
				try {
					this.holds.throwIfHistoryFailpoint();
					await appendHistory(store.project.dir, entry);
				} catch (error) {
					if (filePath) {
						const { unlink } = await import("node:fs/promises");
						await unlink(filePath).catch(() => {});
					}
					throw error;
				}
				return { ...task, version };
			}

			const before = await store.getTask(taskId);
			if (!before) {
				throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Task "${taskId}" not found.`, 404);
			}
			const beforeVersion = await store.taskVersion(before);
			if (beforeVersion !== baseVersion) {
				throw versionConflictError({ ...before, version: beforeVersion }, beforeVersion ?? "");
			}
			// Snapshot the record BEFORE Core touches it — rollback needs the
			// pre-write bytes, not whatever is on disk after a partial failure.
			const beforeBytes = before.filePath ? await Bun.file(before.filePath).bytes() : null;
			const recheckVersion = async () => {
				const current = await store.getTask(taskId);
				const currentVersion = current ? await store.taskVersion(current) : undefined;
				if (currentVersion !== baseVersion) {
					throw versionConflictError(current ? { ...current, version: currentVersion } : null, currentVersion ?? "");
				}
			};
			// A priority write needs the P0/P1 vocabulary in config before Core
			// normalizes it — migrated inside preWrite, after the authorization
			// re-check, so a revoked client cannot even mutate config.yml.
			const hooks = this.writeHooks(token, async () => {
				await recheckVersion();
				if (priority !== undefined) await store.ensureTaskPriorities();
			});

			let result: Task;
			try {
				result = await store.core.updateTaskFromInput(
					taskId,
					{
						...(input.title !== undefined ? { title: input.title } : {}),
						...(status !== undefined ? { status } : {}),
						...(input.description !== undefined ? { description: input.description } : {}),
						...(priority !== undefined ? { priority } : {}),
					},
					false,
					{ includeCrossBranch: false },
					hooks,
				);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Task not found")) {
					throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Task "${taskId}" not found.`, 404);
				}
				throw error;
			}

			// A no-op update leaves the file untouched — and, per the spec, records nothing.
			const afterVersion = await store.taskVersion(result);
			if (afterVersion === beforeVersion) {
				return { ...result, version: afterVersion };
			}

			const changes = diffFields(
				{
					title: before.title,
					status: before.status,
					description: before.description,
					priority: before.priority,
				},
				{
					title: result.title,
					status: result.status,
					description: result.description,
					priority: result.priority,
				},
			);
			try {
				this.holds.throwIfHistoryFailpoint();
				await appendHistory(store.project.dir, {
					ts: new Date().toISOString(),
					actor,
					target: { type: "task", id: result.id, title: result.title },
					action: "update",
					changes,
					version: afterVersion ?? "",
				});
			} catch (error) {
				// Roll the record back so state and history stay in lockstep.
				if (before.filePath && beforeBytes) {
					await store.filesystem
						.withTaskLock({ id: before.id, filePath: before.filePath }, () =>
							Bun.write(before.filePath as string, beforeBytes),
						)
						.catch(() => {});
				}
				if (result.filePath && result.filePath !== before.filePath) {
					const { unlink } = await import("node:fs/promises");
					await unlink(result.filePath).catch(() => {});
				}
				throw error;
			}
			return { ...result, version: afterVersion };
		});
	}

	private async mutateOverview(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		baseVersion: string | undefined,
		change: (source: string) => {
			source: string;
			result?: object;
			target: HistoryEntry["target"];
			changes: HistoryEntry["changes"];
			action: "create" | "update";
		},
	): Promise<unknown> {
		if (!baseVersion)
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"baseVersion is required — read overview or the list first.",
				400,
			);
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		const path = overviewFilePath(project.dir);
		const gate = async () => {
			await this.holds.waitIfAny();
			this.assertRunning();
			if (identity) await this.settings.assertAuthorized(identity.token);
		};
		return store.withWriteLock(async () => {
			const existed = await Bun.file(path).exists();
			if (!existed) {
				if (baseVersion !== contentVersion(""))
					throw versionConflictError(
						{ ...parseOverviewContent(""), ...trackingSummary(""), version: contentVersion("") },
						contentVersion(""),
					);
				await gate();
				await Bun.write(path, "");
			}
			try {
				return await store.filesystem.withTaskLock({ id: "overview", filePath: path }, async () => {
					const beforeBytes = await Bun.file(path).bytes();
					const source = new TextDecoder().decode(beforeBytes);
					const version = contentVersion(beforeBytes);
					if (version !== baseVersion)
						throw versionConflictError(
							{ ...parseOverviewContent(source), ...trackingSummary(source), version },
							version,
						);
					await gate();
					const next = change(existed ? source : initialOverviewContent(project.name));
					const afterVersion = contentVersion(next.source);
					if (afterVersion !== version) {
						try {
							await Bun.write(path, next.source);
							this.holds.throwIfHistoryFailpoint();
							await appendHistory(project.dir, {
								ts: new Date().toISOString(),
								actor: this.actorOf(identity),
								target: next.target,
								action: next.action,
								changes: next.changes,
								version: afterVersion,
							});
						} catch (error) {
							await Bun.write(path, beforeBytes);
							throw error;
						}
					}
					return {
						...(next.result ?? { ...parseOverviewContent(next.source), ...trackingSummary(next.source) }),
						version: afterVersion,
					};
				});
			} catch (error) {
				if (!existed && (await Bun.file(path).exists()) && (await Bun.file(path).size) === 0) await unlink(path);
				throw error;
			}
		});
	}

	private async writeOverview(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		update: { description?: string; goal?: string; current?: string; features?: string },
		baseVersion: string | undefined,
	): Promise<unknown> {
		for (const [key, value] of Object.entries(update))
			if (typeof value === "string" && SECTION_MARKER_LINE.test(value))
				throw new LibraryError(
					LIBRARY_ERROR_CODES.VALIDATION,
					`Overview field "${key}" contains a reserved section marker line.`,
					400,
				);
		return this.mutateOverview(identity, projectId, baseVersion, (source) => {
			const before = parseOverviewContent(source);
			const data = readTracking(source);
			if (data.goals.length && update.goal !== undefined && update.goal !== before.goal)
				throw new LibraryError(
					LIBRARY_ERROR_CODES.VALIDATION,
					"目标已独立管理，请使用goal_create或goal_update；旧目标原文将保留。",
					400,
				);
			let next = applyOverviewUpdate(source, update);
			const after = parseOverviewContent(next);
			if (after.current !== before.current) {
				data.currentUpdatedAt = new Date().toISOString();
				next = writeTracking(next, data);
			}
			return {
				source: next,
				target: { type: "overview" },
				changes: diffFields({ ...before }, { ...after }),
				action: "update",
			};
		});
	}

	private async handleTrackingRead(req: Request, projectId: string, kind: "goals" | "progress"): Promise<Response> {
		const project = await this.projectFor(projectId);
		const file = Bun.file(overviewFilePath(project.dir));
		const bytes = (await file.exists()) ? await file.bytes() : new Uint8Array();
		return json(
			trackingPage(new TextDecoder().decode(bytes), kind, new URL(req.url).searchParams, contentVersion(bytes)),
		);
	}

	private async handleTrackingRecord(projectId: string, kind: "goals" | "progress", id: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		const file = Bun.file(overviewFilePath(project.dir));
		const bytes = (await file.exists()) ? await file.bytes() : new Uint8Array();
		const data = readTracking(new TextDecoder().decode(bytes));
		const record = data[kind].find((item) => item.id === id);
		if (!record) throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, "当前项目中没有这条记录。", 404);
		return json({ ...record, version: contentVersion(bytes) });
	}

	private async handleTrackingWrite(
		req: Request,
		projectId: string,
		kind: "goals" | "progress",
		id: string | null,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		const { baseVersion, ...input } = body;
		return json(
			await this.mutateOverview(
				identity,
				projectId,
				typeof baseVersion === "string" ? baseVersion : undefined,
				(source) => {
					const next = mutateTracking(readTracking(source), kind, id, input, identity !== null);
					let updated = source;
					if (input.current !== undefined) {
						const before = parseOverviewContent(source).current;
						updated = applyOverviewUpdate(source, { current: input.current as string });
						if (parseOverviewContent(updated).current !== before) {
							next.data.currentUpdatedAt = new Date().toISOString();
							next.changes.current = { from: before, to: parseOverviewContent(updated).current };
						}
					}
					return { ...next, source: writeTracking(updated, next.data), result: next.record };
				},
			),
		);
	}

	/**
	 * The architecture record — one whole Markdown document per project sharing
	 * the overview write unit: project write lock → entity lock → in-lock
	 * version re-check → holds/stop/auth gates → write → history → rollback.
	 * Unlike the overview the file may legitimately not exist, so creation is a
	 * first-class path: a conflicting create never touches the disk, and a
	 * failed first write rolls back to "never created".
	 */
	private async writeArchitecture(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		content: string | undefined,
		baseVersion: string | undefined,
	): Promise<{ content: string; version: string }> {
		if (baseVersion === undefined) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"baseVersion is required for updates — read the record first and send back its version.",
				400,
			);
		}
		if (typeof content !== "string") {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "content is required and must be a string.", 400);
		}
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		const actor = this.actorOf(identity);
		const token = identity?.token ?? null;
		const path = architectureFilePath(project.dir);

		return await store.withWriteLock(async () => {
			const existed = await Bun.file(path).exists();
			const emptyVersion = contentVersion("");
			if (!existed && baseVersion !== emptyVersion) {
				// A create on a stale or foreign base is refused before the
				// placeholder exists — no disk side effects at all.
				throw versionConflictError({ content: "", version: emptyVersion }, emptyVersion);
			}
			if (!existed && content === "") {
				// Writing the empty record back onto nothing changes nothing —
				// keep the never-created state, placeholder file included.
				return { content: "", version: emptyVersion };
			}
			if (!existed) {
				// The lock mechanism stats the target file, so a first write needs
				// a placeholder to realpath — same trick as the overview.
				await Bun.write(path, "");
			}
			return await store.filesystem.withTaskLock({ id: "architecture", filePath: path }, async () => {
				const lockBytes = await Bun.file(path).bytes();
				const lockVersion = contentVersion(lockBytes);
				if (lockVersion !== baseVersion) {
					// Someone else wrote between the exists() check and the lock. When
					// the file is still our own empty placeholder nothing was lost —
					// remove it; otherwise keep their content and report it as current.
					if (!existed && lockBytes.length === 0) await unlink(path).catch(() => {});
					throw versionConflictError(
						{ content: new TextDecoder().decode(lockBytes), version: lockVersion },
						lockVersion,
					);
				}
				await this.holds.waitIfAny();
				this.assertRunning();
				if (token !== null) await this.settings.assertAuthorized(token);
				await Bun.write(path, content);
				const afterBytes = await Bun.file(path).bytes();
				const afterVersion = contentVersion(afterBytes);
				// A no-op write leaves the record untouched — and records nothing.
				if (afterVersion === lockVersion) {
					return { content, version: afterVersion };
				}
				try {
					this.holds.throwIfHistoryFailpoint();
					await appendHistory(project.dir, {
						ts: new Date().toISOString(),
						actor,
						target: { type: "architecture" },
						action: existed ? "update" : "create",
						changes: diffFields({ content: new TextDecoder().decode(lockBytes) }, { content }),
						version: afterVersion,
					});
				} catch (error) {
					// State and history stay in lockstep: an existing file rolls back
					// to its pre-write bytes; a first create to never-created.
					if (existed) await Bun.write(path, lockBytes);
					else await unlink(path).catch(() => {});
					throw error;
				}
				return { content, version: afterVersion };
			});
		});
	}

	// --- Route handlers ---------------------------------------------------------

	private async handleServiceInfo(): Promise<Response> {
		const root = await this.settings.getLibraryRoot();
		return json({
			version: await getVersion(),
			libraryRoot: root,
			libraryRootSet: root !== null,
			defaultLibraryRoot: defaultLibraryRoot(),
			port: this.getPort(),
			url: this.getPort() !== null ? this.baseUrl() : null,
		});
	}

	private async handleGetLibrary(): Promise<Response> {
		const root = await this.settings.getLibraryRoot();
		return json({
			libraryRoot: root,
			defaultLibraryRoot: defaultLibraryRoot(),
			projects: root ? await listProjects(root) : [],
		});
	}

	private async handlePutLibrary(req: Request): Promise<Response> {
		const body = await parseBody(req);
		const root = optionalString(body.libraryRoot);
		if (!root) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "libraryRoot is required.", 400);
		}
		const { mkdir } = await import("node:fs/promises");
		const { parse, resolve } = await import("node:path");
		const absolute = resolve(root);
		if (absolute === parse(absolute).root) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"The filesystem root cannot be used as a memory library.",
				400,
			);
		}
		await mkdir(absolute, { recursive: true });
		await this.settings.setLibraryRoot(absolute);
		this.stores.clear(); // project stores are keyed by directory — never let them outlive a root change
		return json({ libraryRoot: absolute, projects: await listProjects(absolute) });
	}

	private async handleListProjects(): Promise<Response> {
		return json(await listProjects(await this.requireLibraryRoot()));
	}

	private async handleCreateProject(req: Request): Promise<Response> {
		const body = await parseBody(req);
		const name = optionalString(body.name);
		if (!name) throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Project name is required.", 400);
		const project = await createProject(await this.requireLibraryRoot(), {
			name,
			workingDir: optionalString(body.workingDir),
		});
		// First changelog line: the project's own creation, attributed to the user
		// (project creation is only exposed on the web channel).
		await appendHistory(project.dir, {
			ts: new Date().toISOString(),
			actor: { type: "user" },
			target: { type: "project", id: project.id, title: project.name },
			action: "create",
			changes: { name: { to: project.name } },
			version: "",
		});
		return json(project, 201);
	}

	private async handleGetProject(projectId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		return json({ ...project, ...(await this.storeFor(project).projectMeta()) });
	}

	private async handleGetOverview(projectId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		return json(await this.overviewWithVersion(project.dir));
	}

	private async handleGetArchitecture(projectId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		const file = Bun.file(architectureFilePath(project.dir));
		// One read feeds both content and the version checked on write — a
		// missing file reads as the empty record versioned by its empty bytes.
		const bytes = (await file.exists()) ? await file.bytes() : new Uint8Array();
		return json({ content: new TextDecoder().decode(bytes), version: contentVersion(bytes) });
	}

	private async handlePutArchitecture(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		return json(
			await this.writeArchitecture(
				identity,
				projectId,
				typeof body.content === "string" ? body.content : undefined,
				typeof body.baseVersion === "string" ? body.baseVersion : undefined,
			),
		);
	}

	private async handlePutOverview(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		checkFields(body, ["baseVersion", "description", "goal", "current", "features"]);
		const update = {
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(typeof body.goal === "string" ? { goal: body.goal } : {}),
			...(typeof body.current === "string" ? { current: body.current } : {}),
			...(typeof body.features === "string" ? { features: body.features } : {}),
		};
		if (Object.keys(update).length === 0) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"Nothing to update — send at least one of: description, goal, current, features.",
				400,
			);
		}
		const baseVersion = typeof body.baseVersion === "string" ? body.baseVersion : undefined;
		return json(await this.writeOverview(identity, projectId, update, baseVersion));
	}

	private async handleListTasks(projectId: string, req: Request): Promise<Response> {
		const store = this.storeFor(await this.projectFor(projectId));
		const status = new URL(req.url).searchParams.get("status") ?? undefined;
		const tasks = await store.listTasks(status);
		return json(await Promise.all(tasks.map((task) => this.taskWithVersion(store, task))));
	}

	private async handleGetTask(projectId: string, taskId: string): Promise<Response> {
		const store = this.storeFor(await this.projectFor(projectId));
		const task = await store.getTask(taskId);
		if (!task) throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Task "${taskId}" not found.`, 404);
		return json(await this.taskWithVersion(store, task));
	}

	private async handleListHistory(projectId: string, req: Request): Promise<Response> {
		const project = await this.projectFor(projectId);
		const params = new URL(req.url).searchParams;
		const since = params.get("since") ?? undefined;
		const until = params.get("until") ?? undefined;
		return json(await readHistory(project.dir, { since, until }));
	}

	private taskInputFrom(body: Record<string, unknown>): TaskWriteInput {
		return {
			...(typeof body.title === "string" ? { title: body.title } : {}),
			...(typeof body.status === "string" ? { status: body.status } : {}),
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(typeof body.priority === "string" ? { priority: body.priority } : {}),
		};
	}

	private async handleCreateTask(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		return json(
			await this.writeTask(identity, projectId, null, this.taskInputFrom(await parseBody(req)), undefined),
			201,
		);
	}

	private async handleUpdateTask(
		req: Request,
		projectId: string,
		taskId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		const input = this.taskInputFrom(body);
		if (Object.keys(input).length === 0) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"Nothing to update — send at least one of: title, status, description, priority.",
				400,
			);
		}
		const baseVersion = typeof body.baseVersion === "string" ? body.baseVersion : undefined;
		return json(await this.writeTask(identity, projectId, taskId, input, baseVersion));
	}

	private async handleListClients(): Promise<Response> {
		const settings = await this.settings.getSettings();
		return json(
			LIBRARY_CLIENT_IDS.map((id) => {
				const slot = settings.clients[id];
				return {
					id,
					label: LIBRARY_CLIENT_LABELS[id],
					enabled: slot.enabled,
					token: slot.token,
					connection: slot.connection,
					installError: slot.installError,
					lastSeenAt: slot.lastSeenAt,
				};
			}),
		);
	}

	/**
	 * The one-click setup flow (Phase 4). Enabling a client does more than flip
	 * the switch: a credential is minted, then MCP config + instruction block +
	 * skill are installed into the client's real config files. Success marks the
	 * slot `configured` — it becomes `connected` only when the client's bridge
	 * actually pings the service. Failure is recorded for the retry affordance.
	 */
	private async handlePutClient(req: Request, id: string): Promise<Response> {
		if (!isLibraryClientId(id)) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, `Unknown client "${id}".`, 404);
		}
		const body = await parseBody(req);
		if (typeof body.enabled !== "boolean") {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "enabled must be a boolean.", 400);
		}
		if (!body.enabled) {
			const slot = await this.settings.setClientEnabled(id, false);
			return json({
				id,
				label: LIBRARY_CLIENT_LABELS[id],
				enabled: slot.enabled,
				token: slot.token,
				connection: slot.connection,
				installError: slot.installError,
				lastSeenAt: slot.lastSeenAt,
			});
		}
		const { token, generation } = await this.settings.ensureToken(id);
		const install = await installClient(id, { serviceUrl: this.baseUrl(), token });
		if (!install.ok) {
			const slot = await this.settings.markInstallFailed(id, install.error ?? "Unknown setup failure.", generation);
			return json(
				{
					id,
					label: LIBRARY_CLIENT_LABELS[id],
					enabled: slot.enabled,
					token: slot.token,
					connection: slot.connection,
					installError: slot.installError,
					lastSeenAt: slot.lastSeenAt,
					installed: install.installed,
					error: slot.installError,
					code: "SETUP_FAILED",
				},
				502,
			);
		}
		const slot = await this.settings.markConfigured(id, generation);
		return json({
			id,
			label: LIBRARY_CLIENT_LABELS[id],
			enabled: slot.enabled,
			token: slot.token,
			connection: slot.connection,
			installError: slot.installError,
			lastSeenAt: slot.lastSeenAt,
			installed: install.installed,
		});
	}

	// --- Question (待决定事项) write unit --------------------------------------
	// Same discipline as tasks/overview: project write lock → re-auth inside the
	// lock → record write → history append → rollback on history failure. An
	// answer is a write-once transition — the conflict check is the record's
	// own status, which is why it needs no caller-supplied baseVersion.

	private async questionWithVersion(q: ProjectQuestion): Promise<ProjectQuestion & { version?: string }> {
		const bytes = q.filePath ? await Bun.file(q.filePath).bytes() : new Uint8Array();
		return { ...q, version: contentVersion(bytes) };
	}

	private async writeQuestion(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		input: { title?: string; task?: string; detail?: string },
	): Promise<ProjectQuestion & { version?: string }> {
		if (!input.title?.trim()) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Question title is required.", 400);
		}
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		const actor = this.actorOf(identity);
		const token = identity?.token ?? null;
		const askedBy = actor.type === "user" ? "user" : actor.client;

		return await store.withWriteLock(async () => {
			// Authorization/stop re-checks fire BEFORE the record lands — a vetoed
			// create must leave nothing on disk (same contract as tasks/preWrite).
			await this.holds.waitIfAny();
			this.assertRunning();
			if (token !== null) await this.settings.assertAuthorized(token);
			const question = await createQuestion(
				project.dir,
				input as { title: string; task?: string; detail?: string },
				askedBy,
			);
			const version = contentVersion(await Bun.file(question.filePath as string).bytes());
			try {
				this.holds.throwIfHistoryFailpoint();
				await appendHistory(project.dir, {
					ts: new Date().toISOString(),
					actor,
					target: { type: "question", id: question.id, title: question.title },
					action: "create",
					changes: diffFields(
						{},
						{ title: question.title, status: question.status, ...(question.task ? { task: question.task } : {}) },
					),
					version,
				});
			} catch (error) {
				if (question.filePath) {
					const { unlink } = await import("node:fs/promises");
					await unlink(question.filePath).catch(() => {});
				}
				throw error;
			}
			return { ...question, version };
		});
	}

	private async writeQuestionAnswer(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		questionId: string,
		answer: string | undefined,
	): Promise<ProjectQuestion & { version?: string }> {
		if (!answer?.trim()) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "answer is required.", 400);
		}
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		const actor = this.actorOf(identity);
		const token = identity?.token ?? null;

		return await store.withWriteLock(async () => {
			const before = await getQuestion(project.dir, questionId);
			if (!before) {
				throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Question "${questionId}" not found.`, 404);
			}
			const beforeBytes = before.filePath ? await Bun.file(before.filePath).bytes() : null;
			// Answered is a write-once state — a second answer conflicts rather than overwriting.
			if (before.status !== "Open") {
				const currentVersion = contentVersion(beforeBytes ?? new Uint8Array());
				throw versionConflictError({ ...before, version: currentVersion }, currentVersion);
			}
			await this.holds.waitIfAny();
			this.assertRunning();
			if (token !== null) await this.settings.assertAuthorized(token);
			const after = await answerQuestion(before, answer.trim(), actor);
			const version = contentVersion(await Bun.file(after.filePath as string).bytes());
			try {
				this.holds.throwIfHistoryFailpoint();
				await appendHistory(project.dir, {
					ts: new Date().toISOString(),
					actor,
					target: { type: "question", id: after.id, title: after.title },
					action: "update",
					changes: diffFields(
						{ status: before.status },
						{ status: after.status, answer: after.answer ?? "", answered_by: after.answeredBy ?? "" },
					),
					version,
				});
			} catch (error) {
				if (before.filePath && beforeBytes) {
					await Bun.write(before.filePath, beforeBytes).catch(() => {});
				}
				throw error;
			}
			return { ...after, version };
		});
	}

	private async handleListQuestions(projectId: string, req: Request): Promise<Response> {
		const project = await this.projectFor(projectId);
		const raw = new URL(req.url).searchParams.get("status");
		const status = raw?.toLowerCase() === "open" ? "Open" : raw?.toLowerCase() === "answered" ? "Answered" : undefined;
		const questions = await listQuestions(project.dir, status);
		return json(await Promise.all(questions.map((q) => this.questionWithVersion(q))));
	}

	private async handleGetQuestion(projectId: string, questionId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		const question = await getQuestion(project.dir, questionId);
		if (!question) {
			throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Question "${questionId}" not found.`, 404);
		}
		return json(await this.questionWithVersion(question));
	}

	private async handleCreateQuestion(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		return json(
			await this.writeQuestion(identity, projectId, {
				...(typeof body.title === "string" ? { title: body.title } : {}),
				...(typeof body.task === "string" ? { task: body.task } : {}),
				...(typeof body.detail === "string" ? { detail: body.detail } : {}),
			}),
			201,
		);
	}

	private async handleAnswerQuestion(
		req: Request,
		projectId: string,
		questionId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		return json(
			await this.writeQuestionAnswer(
				identity,
				projectId,
				questionId,
				typeof body.answer === "string" ? body.answer : undefined,
			),
		);
	}

	// --- Resource (项目资料) handlers ------------------------------------------

	private async handleListResources(projectId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		return json(await listResources(project.dir));
	}

	/**
	 * Web upload: JSON {name, base64} — keeps the JSON-only body gate uniform.
	 * Same write unit as every mutation: project write lock → stop check →
	 * record write → history append → rollback on history failure.
	 */
	private async handleUploadResource(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		const body = await parseBody(req);
		const name = typeof body.name === "string" ? body.name : "";
		if (typeof body.base64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"base64 file content is required and must be valid base64.",
				400,
			);
		}
		const bytes = new Uint8Array(Buffer.from(body.base64, "base64"));

		const safe = assertSafeResourceName(name);
		return await store.withWriteLock(async () => {
			await this.holds.waitIfAny();
			this.assertRunning();
			if (identity !== null) await this.settings.assertAuthorized(identity.token);
			// A same-name upload still has prior state to roll back to — snapshot
			// the existing bytes before saveResource overwrites them.
			const targetPath = join(resourcesDir(project.dir), safe);
			const existed = await Bun.file(targetPath).exists();
			const beforeBytes = existed ? await Bun.file(targetPath).bytes() : null;
			const info = await saveResource(project.dir, safe, bytes);
			try {
				this.holds.throwIfHistoryFailpoint();
				await appendHistory(project.dir, {
					ts: new Date().toISOString(),
					actor: this.actorOf(identity),
					target: { type: "resource", id: info.name, title: info.name },
					action: "create",
					changes: diffFields({}, { name: info.name, size: String(info.size) }),
					version: "",
				});
			} catch (error) {
				const { unlink } = await import("node:fs/promises");
				if (beforeBytes) await Bun.write(targetPath, beforeBytes).catch(() => {});
				else await unlink(targetPath).catch(() => {});
				throw error;
			}
			return json(info, 201);
		});
	}

	private async handleGetResource(projectId: string, name: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		// Bun decodes :param segments already — decoding again would corrupt
		// names that legitimately contain '%' (e.g. "50%.md").
		return json(await readResource(project.dir, name));
	}

	/** The short instructions + skill agents should operate under — one source. */
	private async handleAgentInstructions(): Promise<Response> {
		return json({
			instructions: instructionBlock(this.baseUrl()),
			skill: SKILL_MD,
			skillFiles: Object.keys(SKILL_FILES),
		});
	}

	// --- Agent API handlers -----------------------------------------------------

	private bearerToken(req: Request): string {
		const header = req.headers.get("authorization") ?? "";
		return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	}

	/**
	 * Probe route — the only endpoint open to a `configured` client. A real
	 * ping (which the bridge fires on startup) proves the client's MCP config
	 * reaches this service, so it is what flips `configured` → `connected`.
	 */
	private async handleAgentPing(req: Request): Promise<Response> {
		const client = await this.settings.assertProbeAuthorized(this.bearerToken(req) || null);
		await this.settings.markConnected(client);
		return json({ ok: true, client, libraryRootSet: (await this.settings.getLibraryRoot()) !== null });
	}

	private async handleAgentListProjects(req: Request): Promise<Response> {
		await this.requireClient(req);
		return json(await listProjects(await this.requireLibraryRoot()));
	}

	private async handleAgentResolveProject(req: Request): Promise<Response> {
		await this.requireClient(req);
		const body = await parseBody(req);
		const name = optionalString(body.name);
		if (!name) throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Project name is required.", 400);
		return json(await resolveProject(await this.requireLibraryRoot(), name));
	}

	/** Probe wrapper: host check only — the handler itself applies the probe gate. */
	private async withProbeRoute(req: Request, handler: () => Promise<Response>): Promise<Response> {
		try {
			if (!isLoopbackHost(req)) {
				throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Forbidden host.", 403);
			}
			return await handler();
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async withAgentRoute(
		req: Request,
		handler: (identity: { token: string; id: LibraryClientId }) => Promise<Response>,
	): Promise<Response> {
		try {
			if (!isLoopbackHost(req)) {
				throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Forbidden host.", 403);
			}
			const clientId = await this.requireClient(req);
			return await handler({ token: this.bearerToken(req), id: clientId });
		} catch (error) {
			return errorResponse(error);
		}
	}

	private async withRoute(req: Request, handler: () => Promise<Response>): Promise<Response> {
		try {
			if (!isLoopbackHost(req)) {
				throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Forbidden host.", 403);
			}
			return await handler();
		} catch (error) {
			return errorResponse(error);
		}
	}

	// --- Lifecycle ----------------------------------------------------------------

	async start(port?: number): Promise<void> {
		if (this.server) return;
		this.stopping = false;

		// One service per settings home. The lock auto-breaks when the holder
		// dies (stale after 4s of missed updates), and refuses while one lives.
		const { mkdir } = await import("node:fs/promises");
		const lockfile = await import("proper-lockfile");
		await mkdir(this.settings.homeDir, { recursive: true });
		const lockPath = join(this.settings.homeDir, "service.lock");
		await Bun.write(lockPath, `${process.pid}\n`);
		try {
			this.releaseInstanceLock = await lockfile.lock(lockPath, {
				stale: 4000,
				update: 1000,
				retries: 0,
				realpath: false,
			});
		} catch {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"Another Memory Master service is already running. Stop it first.",
				409,
			);
		}

		const finalPort = port ?? (await this.settings.getPort());
		const requireTestMode = () => {
			if (!this.holds.enabled) {
				throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Test hooks are not enabled.", 404);
			}
		};

		this.server = Bun.serve({
			port: finalPort,
			hostname: SERVICE_HOST,
			development: process.env.NODE_ENV === "development",
			routes: {
				"/": libraryIndexHtml,
				"/projects": libraryIndexHtml,
				"/projects/*": libraryIndexHtml,
				"/settings": libraryIndexHtml,

				"/api/service": { GET: async (req: Request) => this.withRoute(req, () => this.handleServiceInfo()) },
				"/api/library": {
					GET: async (req: Request) => this.withRoute(req, () => this.handleGetLibrary()),
					PUT: async (req: Request) => this.withRoute(req, () => this.handlePutLibrary(req)),
				},
				"/api/projects": {
					GET: async (req: Request) => this.withRoute(req, () => this.handleListProjects()),
					POST: async (req: Request) => this.withRoute(req, () => this.handleCreateProject(req)),
				},
				"/api/projects/:id": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleGetProject(req.params.id)),
				},
				"/api/projects/:id/overview": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleGetOverview(req.params.id)),
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handlePutOverview(req, req.params.id, null)),
				},
				"/api/projects/:id/architecture": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleGetArchitecture(req.params.id)),
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handlePutArchitecture(req, req.params.id, null)),
				},
				"/api/projects/:id/goals": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleTrackingRead(req, req.params.id, "goals")),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleTrackingWrite(req, req.params.id, "goals", null, null)),
				},
				"/api/projects/:id/goals/:goalId": {
					GET: async (req: Request & { params: { id: string; goalId: string } }) =>
						this.withRoute(req, () => this.handleTrackingRecord(req.params.id, "goals", req.params.goalId)),
					PUT: async (req: Request & { params: { id: string; goalId: string } }) =>
						this.withRoute(req, () => this.handleTrackingWrite(req, req.params.id, "goals", req.params.goalId, null)),
				},
				"/api/agent/projects/:id/goals": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleTrackingRead(req, req.params.id, "goals")),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleTrackingWrite(req, req.params.id, "goals", null, identity),
						),
				},
				"/api/agent/projects/:id/goals/:goalId": {
					GET: async (req: Request & { params: { id: string; goalId: string } }) =>
						this.withAgentRoute(req, () => this.handleTrackingRecord(req.params.id, "goals", req.params.goalId)),
					PUT: async (req: Request & { params: { id: string; goalId: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleTrackingWrite(req, req.params.id, "goals", req.params.goalId, identity),
						),
				},

				"/api/projects/:id/progress": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleTrackingRead(req, req.params.id, "progress")),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleTrackingWrite(req, req.params.id, "progress", null, null)),
				},
				"/api/projects/:id/progress/:progressId": {
					GET: async (req: Request & { params: { id: string; progressId: string } }) =>
						this.withRoute(req, () => this.handleTrackingRecord(req.params.id, "progress", req.params.progressId)),
					PUT: async (req: Request & { params: { id: string; progressId: string } }) =>
						this.withRoute(req, () =>
							this.handleTrackingWrite(req, req.params.id, "progress", req.params.progressId, null),
						),
				},
				"/api/agent/projects/:id/progress": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleTrackingRead(req, req.params.id, "progress")),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleTrackingWrite(req, req.params.id, "progress", null, identity),
						),
				},
				"/api/agent/projects/:id/progress/:progressId": {
					GET: async (req: Request & { params: { id: string; progressId: string } }) =>
						this.withAgentRoute(req, () => this.handleTrackingRecord(req.params.id, "progress", req.params.progressId)),
					PUT: async (req: Request & { params: { id: string; progressId: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleTrackingWrite(req, req.params.id, "progress", req.params.progressId, identity),
						),
				},

				"/api/projects/:id/tasks": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleListTasks(req.params.id, req)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleCreateTask(req, req.params.id, null)),
				},
				"/api/projects/:id/tasks/:taskId": {
					GET: async (req: Request & { params: { id: string; taskId: string } }) =>
						this.withRoute(req, () => this.handleGetTask(req.params.id, req.params.taskId)),
					PUT: async (req: Request & { params: { id: string; taskId: string } }) =>
						this.withRoute(req, () => this.handleUpdateTask(req, req.params.id, req.params.taskId, null)),
				},
				"/api/projects/:id/history": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleListHistory(req.params.id, req)),
				},
				"/api/projects/:id/questions": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleListQuestions(req.params.id, req)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleCreateQuestion(req, req.params.id, null)),
				},
				"/api/projects/:id/questions/:questionId": {
					GET: async (req: Request & { params: { id: string; questionId: string } }) =>
						this.withRoute(req, () => this.handleGetQuestion(req.params.id, req.params.questionId)),
					PUT: async (req: Request & { params: { id: string; questionId: string } }) =>
						this.withRoute(req, () => this.handleAnswerQuestion(req, req.params.id, req.params.questionId, null)),
				},
				"/api/projects/:id/resources": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleListResources(req.params.id)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleUploadResource(req, req.params.id, null)),
				},
				"/api/projects/:id/resources/:name": {
					GET: async (req: Request & { params: { id: string; name: string } }) =>
						this.withRoute(req, () => this.handleGetResource(req.params.id, req.params.name)),
				},
				"/api/clients": { GET: async (req: Request) => this.withRoute(req, () => this.handleListClients()) },
				"/api/clients/:id": {
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handlePutClient(req, req.params.id)),
				},

				"/api/agent/ping": {
					GET: async (req: Request) => this.withProbeRoute(req, () => this.handleAgentPing(req)),
				},
				"/api/agent/projects": {
					GET: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentListProjects(req)),
				},
				"/api/agent/projects/resolve": {
					POST: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentResolveProject(req)),
				},
				"/api/agent/projects/:id": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleGetProject(req.params.id)),
				},
				"/api/agent/projects/:id/architecture": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleGetArchitecture(req.params.id)),
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) => this.handlePutArchitecture(req, req.params.id, identity)),
				},
				"/api/agent/projects/:id/overview": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleGetOverview(req.params.id)),
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) => this.handlePutOverview(req, req.params.id, identity)),
				},
				"/api/agent/projects/:id/tasks": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleListTasks(req.params.id, req)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) => this.handleCreateTask(req, req.params.id, identity)),
				},
				"/api/agent/projects/:id/tasks/:taskId": {
					GET: async (req: Request & { params: { id: string; taskId: string } }) =>
						this.withAgentRoute(req, () => this.handleGetTask(req.params.id, req.params.taskId)),
					PUT: async (req: Request & { params: { id: string; taskId: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleUpdateTask(req, req.params.id, req.params.taskId, identity),
						),
				},
				"/api/agent/projects/:id/history": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleListHistory(req.params.id, req)),
				},
				"/api/agent/instructions": {
					GET: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentInstructions()),
				},
				"/api/agent/projects/:id/questions": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleListQuestions(req.params.id, req)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) => this.handleCreateQuestion(req, req.params.id, identity)),
				},
				"/api/agent/projects/:id/questions/:questionId": {
					GET: async (req: Request & { params: { id: string; questionId: string } }) =>
						this.withAgentRoute(req, () => this.handleGetQuestion(req.params.id, req.params.questionId)),
					PUT: async (req: Request & { params: { id: string; questionId: string } }) =>
						this.withAgentRoute(req, (identity) =>
							this.handleAnswerQuestion(req, req.params.id, req.params.questionId, identity),
						),
				},
				"/api/agent/projects/:id/resources": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, () => this.handleListResources(req.params.id)),
					POST: async (req: Request & { params: { id: string } }) =>
						this.withAgentRoute(req, (identity) => this.handleUploadResource(req, req.params.id, identity)),
				},
				"/api/agent/projects/:id/resources/:name": {
					GET: async (req: Request & { params: { id: string; name: string } }) =>
						this.withAgentRoute(req, () => this.handleGetResource(req.params.id, req.params.name)),
				},

				"/api/test/holds": {
					POST: async (req: Request) =>
						this.withRoute(req, async () => {
							requireTestMode();
							const body = await parseBody(req);
							return json(this.holds.create(optionalString(body.name) ?? "write"), 201);
						}),
				},
				"/api/test/holds/:id": {
					DELETE: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, async () => {
							requireTestMode();
							if (!this.holds.release(req.params.id)) {
								throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Unknown hold.", 404);
							}
							return json({ released: true });
						}),
				},
			},
			fetch: () => new Response("Not Found", { status: 404 }),
			error: (error) => errorResponse(error),
		}) as Server<unknown>;
	}

	async stop(): Promise<void> {
		// Stopping semantics: new requests are refused by the socket closing, and
		// any write still parked before commit is cancelled (its preWrite re-check
		// sees `stopping` and throws) — uncommitted work never lands after stop.
		this.stopping = true;
		const server = this.server;
		this.server = null;
		if (server) {
			try {
				await server.stop();
			} catch {}
		}
		this.stores.clear();
		if (this.releaseInstanceLock) {
			try {
				await this.releaseInstanceLock();
			} catch {}
			this.releaseInstanceLock = null;
		}
	}
}
