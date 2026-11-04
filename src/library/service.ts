import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import type { TaskWriteHooks } from "../core/memaster.ts";
import libraryIndexHtml from "../library-web/index.html";
import type { Task } from "../types/index.ts";
import { getVersion } from "../utils/version.ts";
import { type Actor, appendHistory, contentVersion, diffFields, type HistoryEntry, readHistory } from "./history.ts";
import { initialOverviewContent, overviewFilePath, readOverview, writeOverview } from "./overview.ts";
import { ProjectStore, type TaskWriteInput } from "./project-store.ts";
import { createProject, getProjectById, listProjects, resolveProject } from "./registry.ts";
import { AppSettingsStore } from "./settings.ts";
import { TestHolds } from "./test-holds.ts";
import {
	isLibraryClientId,
	LIBRARY_CLIENT_IDS,
	LIBRARY_CLIENT_LABELS,
	LIBRARY_ERROR_CODES,
	type LibraryClientId,
	LibraryError,
	type LibraryProject,
	unauthorizedError,
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
 *   - /api/* for the web UI itself — gated by `webKey`, a per-process session
 *     credential delivered out-of-band (the `?k=` URL `memaster serve` prints).
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
	/** Per-process web session key; regenerated every service start, never persisted. */
	readonly webKey = `mm_web_${randomBytes(16).toString("hex")}`;
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
		const path = overviewFilePath(projectDir);
		const file = Bun.file(path);
		const version = contentVersion((await file.exists()) ? await file.bytes() : "");
		return { ...(await readOverview(projectDir)), version };
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
				const { task, filePath } = await store.core.createTaskFromInput(
					{
						title: input.title,
						...(status !== undefined ? { status } : {}),
						...(input.description !== undefined ? { description: input.description } : {}),
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
			const hooks = this.writeHooks(token, recheckVersion);

			let result: Task;
			try {
				result = await store.core.updateTaskFromInput(
					taskId,
					{
						...(input.title !== undefined ? { title: input.title } : {}),
						...(status !== undefined ? { status } : {}),
						...(input.description !== undefined ? { description: input.description } : {}),
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
				{ title: before.title, status: before.status, description: before.description },
				{ title: result.title, status: result.status, description: result.description },
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

	private async writeOverview(
		identity: { token: string; id: LibraryClientId } | null,
		projectId: string,
		update: { description?: string; goal?: string; current?: string },
		baseVersion: string | undefined,
	): Promise<unknown> {
		if (baseVersion === undefined) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.VALIDATION,
				"baseVersion is required for updates — read the record first and send back its version.",
				400,
			);
		}
		const project = await this.projectFor(projectId);
		const store = this.storeFor(project);
		for (const [key, value] of Object.entries(update)) {
			if (typeof value === "string" && SECTION_MARKER_LINE.test(value)) {
				throw new LibraryError(
					LIBRARY_ERROR_CODES.VALIDATION,
					`Overview field "${key}" contains a reserved section marker line.`,
					400,
				);
			}
		}
		const actor = this.actorOf(identity);
		const token = identity?.token ?? null;
		const path = overviewFilePath(project.dir);

		return await store.withWriteLock(async () => {
			// The lock mechanism stats the target file — recreate a missing overview
			// first (hand-made project dirs may not have one yet).
			if (!(await Bun.file(path).exists())) {
				await Bun.write(path, initialOverviewContent(project.name));
			}
			const beforeBytes = await Bun.file(path).bytes();
			const before = await readOverview(project.dir);
			return await store.filesystem.withTaskLock({ id: "overview", filePath: path }, async () => {
				const lockBytes = await Bun.file(path).bytes();
				if (contentVersion(lockBytes) !== baseVersion) {
					throw versionConflictError(
						{ ...(await readOverview(project.dir)), version: contentVersion(lockBytes) },
						contentVersion(lockBytes),
					);
				}
				await this.holds.waitIfAny();
				this.assertRunning();
				if (token !== null) await this.settings.assertAuthorized(token);
				const after = await writeOverview(project.dir, update);
				const afterBytes = await Bun.file(path).bytes();
				const afterVersion = contentVersion(afterBytes);
				if (afterVersion === contentVersion(beforeBytes)) {
					return { ...after, version: afterVersion };
				}
				const changes = diffFields(
					{ description: before.description, goal: before.goal, current: before.current },
					{ description: after.description, goal: after.goal, current: after.current },
				);
				try {
					this.holds.throwIfHistoryFailpoint();
					await appendHistory(project.dir, {
						ts: new Date().toISOString(),
						actor,
						target: { type: "overview" },
						action: "update",
						changes,
						version: afterVersion,
					});
				} catch (error) {
					await Bun.write(path, beforeBytes);
					throw error;
				}
				return { ...after, version: afterVersion };
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

	private async handleGetOverview(projectId: string): Promise<Response> {
		const project = await this.projectFor(projectId);
		return json(await this.overviewWithVersion(project.dir));
	}

	private async handlePutOverview(
		req: Request,
		projectId: string,
		identity: { token: string; id: LibraryClientId } | null,
	): Promise<Response> {
		const body = await parseBody(req);
		const update = {
			...(typeof body.description === "string" ? { description: body.description } : {}),
			...(typeof body.goal === "string" ? { goal: body.goal } : {}),
			...(typeof body.current === "string" ? { current: body.current } : {}),
		};
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
		const baseVersion = typeof body.baseVersion === "string" ? body.baseVersion : undefined;
		return json(await this.writeTask(identity, projectId, taskId, this.taskInputFrom(body), baseVersion));
	}

	private async handleListClients(): Promise<Response> {
		const settings = await this.settings.getSettings();
		return json(
			LIBRARY_CLIENT_IDS.map((id) => ({
				id,
				label: LIBRARY_CLIENT_LABELS[id],
				enabled: settings.clients[id].enabled,
				token: settings.clients[id].token,
			})),
		);
	}

	private async handlePutClient(req: Request, id: string): Promise<Response> {
		if (!isLibraryClientId(id)) {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, `Unknown client "${id}".`, 404);
		}
		const body = await parseBody(req);
		if (typeof body.enabled !== "boolean") {
			throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "enabled must be a boolean.", 400);
		}
		const slot = await this.settings.setClientEnabled(id, body.enabled);
		return json({ id, label: LIBRARY_CLIENT_LABELS[id], enabled: slot.enabled, token: slot.token });
	}

	// --- Agent API handlers -----------------------------------------------------

	private bearerToken(req: Request): string {
		const header = req.headers.get("authorization") ?? "";
		return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
	}

	private async handleAgentPing(req: Request): Promise<Response> {
		const client = await this.requireClient(req);
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

	/**
	 * Web-route gate: the session key must arrive as `Authorization: Bearer`.
	 * The key only ever travels user→browser (printed URL or pasted), so nothing
	 * reachable purely over HTTP can mint itself a usable credential.
	 */
	private requireWebKey(req: Request): void {
		const header = req.headers.get("authorization") ?? "";
		const key = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
		if (key !== this.webKey) {
			throw unauthorizedError(
				"Missing or invalid web access key. Open the keyed URL printed by `memaster serve` (…/?k=…), or paste the key on the entry screen.",
			);
		}
	}

	private async withRoute(req: Request, handler: () => Promise<Response>): Promise<Response> {
		try {
			if (!isLoopbackHost(req)) {
				throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Forbidden host.", 403);
			}
			this.requireWebKey(req);
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
				"/api/projects/:id/overview": {
					GET: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handleGetOverview(req.params.id)),
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handlePutOverview(req, req.params.id, null)),
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
				"/api/clients": { GET: async (req: Request) => this.withRoute(req, () => this.handleListClients()) },
				"/api/clients/:id": {
					PUT: async (req: Request & { params: { id: string } }) =>
						this.withRoute(req, () => this.handlePutClient(req, req.params.id)),
				},

				"/api/agent/ping": {
					GET: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentPing(req)),
				},
				"/api/agent/projects": {
					GET: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentListProjects(req)),
				},
				"/api/agent/projects/resolve": {
					POST: async (req: Request) => this.withAgentRoute(req, () => this.handleAgentResolveProject(req)),
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
