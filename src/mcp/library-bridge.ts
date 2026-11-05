import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getVersion } from "../utils/version.ts";

/**
 * MCP bridge for agent clients (Codex / Claude Code).
 *
 * A thin stdio server that proxies tool calls to the local Memory Master
 * service over HTTP using the client's bearer credential. All authorization
 * decisions happen service-side on every request — the bridge holds no
 * authority of its own, so revocation and service shutdown take effect here
 * immediately. The selected project is session state held by this process.
 */

export interface BridgeOptions {
	serviceUrl: string;
	token: string;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
	content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
	content: [{ type: "text", text: message }],
	isError: true,
});

export class LibraryBridge {
	private readonly options: BridgeOptions;
	private selectedProject: { id: string; name: string; dir: string } | null = null;

	constructor(options: BridgeOptions) {
		this.options = options;
	}

	private async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
		let response: Response;
		try {
			response = await fetch(`${this.options.serviceUrl}${path}`, {
				signal: AbortSignal.timeout(10_000),
				method: init.method ?? "GET",
				headers: {
					authorization: `Bearer ${this.options.token}`,
					...(init.body !== undefined ? { "content-type": "application/json" } : {}),
				},
				...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
			});
		} catch (error) {
			if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
				throw new Error(
					"Memory Master service request timed out — the write may still have landed. Check before retrying.",
				);
			}
			throw new Error(`Cannot reach the Memory Master service at ${this.options.serviceUrl}. Is it running?`);
		}
		const data = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			candidates?: unknown;
			current?: unknown;
			version?: unknown;
		};
		if (!response.ok) {
			const suffix = data.code ? ` [${data.code}]` : "";
			const hint =
				data.code === "PROJECT_AMBIGUOUS" && Array.isArray(data.candidates)
					? ` Candidates: ${JSON.stringify(data.candidates)}`
					: data.code === "VERSION_CONFLICT"
						? ` Latest value: ${JSON.stringify(data.current)}`
						: "";
			throw new Error(`${data.error ?? `Request failed with status ${response.status}`}${suffix}${hint}`);
		}
		return data;
	}

	private requireProject(): { id: string; name: string } {
		if (!this.selectedProject) {
			throw new Error("No project selected. Call project_open (or project_list to see candidates) first.");
		}
		return this.selectedProject;
	}

	/**
	 * Agents sometimes wrap the payload in a `data` field (object or JSON string).
	 * Unwrap it — then refuse anything unrecognized. Silently dropping unknown
	 * arguments once produced "successful" writes that changed nothing.
	 */
	private writeArgs(args: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
		let data: unknown = args.data;
		if (typeof data === "string") {
			try {
				data = JSON.parse(data);
			} catch {
				data = undefined;
			}
		}
		if (args.data !== undefined && (data === null || typeof data !== "object" || Array.isArray(data))) {
			throw new Error("`data` must be an object or a JSON object string.");
		}
		const merged: Record<string, unknown> =
			data !== undefined ? { ...(data as Record<string, unknown>), ...args } : { ...args };
		delete merged.data;
		for (const key of Object.keys(merged)) {
			if (!allowed.includes(key)) {
				throw new Error(`Unknown argument "${key}" — pass write fields at the top level, not inside a wrapper.`);
			}
		}
		return merged;
	}

	/** Updates are optimistic-concurrency writes: the caller must prove which version it saw. */
	private requireBaseVersion(args: Record<string, unknown>): string {
		const version = typeof args.base_version === "string" ? args.base_version.trim() : "";
		if (!version) {
			throw new Error(
				"base_version is required. Read the record first (task_get / overview_read / task_list) and pass back its `version` field — the write conflicts if the record changed since.",
			);
		}
		return version;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		try {
			switch (name) {
				case "project_list":
					return ok(await this.api("/api/agent/projects"));
				case "project_open": {
					const project = (await this.api("/api/agent/projects/resolve", {
						method: "POST",
						body: { name: String(args.name ?? "") },
					})) as { id: string; name: string; dir: string };
					this.selectedProject = project;
					return ok({ opened: project });
				}
				case "project_current":
					return ok(this.selectedProject ? { project: this.selectedProject } : { project: null });
				case "overview_read":
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/overview`));
				case "overview_write": {
					const fields = this.writeArgs(args, ["base_version", "description", "goal", "current", "features"]);
					const baseVersion = this.requireBaseVersion(fields);
					const body: Record<string, unknown> = { baseVersion };
					for (const key of ["description", "goal", "current", "features"] as const) {
						if (fields[key] !== undefined) body[key] = fields[key];
					}
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/overview`, {
							method: "PUT",
							body,
						}),
					);
				}
				case "architecture_read":
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/architecture`));
				case "architecture_write": {
					const fields = this.writeArgs(args, ["base_version", "content"]);
					const baseVersion = this.requireBaseVersion(fields);
					// content is required — a missing value must fail loudly rather
					// than silently clear the record.
					if (typeof fields.content !== "string") {
						throw new Error("content is required — pass the full architecture Markdown document.");
					}
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/architecture`, {
							method: "PUT",
							body: { content: fields.content, baseVersion },
						}),
					);
				}
				case "task_list": {
					const query = args.status ? `?status=${encodeURIComponent(String(args.status))}` : "";
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/tasks${query}`));
				}
				case "task_get":
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/tasks/${encodeURIComponent(String(args.task_id ?? ""))}`,
						),
					);
				case "task_create": {
					const fields = this.writeArgs(args, ["title", "status", "description", "priority"]);
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/tasks`, {
							method: "POST",
							body: {
								title: fields.title,
								status: fields.status,
								description: fields.description,
								priority: fields.priority,
							},
						}),
					);
				}
				case "task_update": {
					const fields = this.writeArgs(args, [
						"task_id",
						"base_version",
						"title",
						"status",
						"description",
						"priority",
					]);
					const body: Record<string, unknown> = { baseVersion: this.requireBaseVersion(fields) };
					for (const key of ["title", "status", "description", "priority"] as const) {
						if (fields[key] !== undefined) body[key] = fields[key];
					}
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/tasks/${encodeURIComponent(String(fields.task_id ?? ""))}`,
							{ method: "PUT", body },
						),
					);
				}
				case "history_list": {
					const params = new URLSearchParams();
					if (args.since !== undefined) params.set("since", String(args.since));
					if (args.until !== undefined) params.set("until", String(args.until));
					const query = params.size ? `?${params}` : "";
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/history${query}`));
				}
				case "question_ask":
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/questions`, {
							method: "POST",
							body: {
								title: args.title,
								...(args.task_id !== undefined ? { task: args.task_id } : {}),
								...(args.detail !== undefined ? { detail: args.detail } : {}),
							},
						}),
					);
				case "question_list": {
					const query = args.status ? `?status=${encodeURIComponent(String(args.status))}` : "";
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/questions${query}`));
				}
				case "question_get":
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/questions/${encodeURIComponent(String(args.question_id ?? ""))}`,
						),
					);
				case "question_answer":
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/questions/${encodeURIComponent(String(args.question_id ?? ""))}`,
							{ method: "PUT", body: { answer: args.answer } },
						),
					);
				case "resource_list":
					return ok(await this.api(`/api/agent/projects/${this.requireProject().id}/resources`));
				case "resource_read":
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/resources/${encodeURIComponent(String(args.name ?? ""))}`,
						),
					);
				case "resource_write": {
					const fields = this.writeArgs(args, ["name", "content", "encoding"]);
					if (typeof fields.content !== "string") {
						throw new Error("content is required — pass the file content as text (default) or base64.");
					}
					const base64 =
						fields.encoding === "base64" ? fields.content : Buffer.from(fields.content, "utf8").toString("base64");
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/resources`, {
							method: "POST",
							body: { name: fields.name, base64 },
						}),
					);
				}
				default:
					return fail(`Unknown tool: ${name}`);
			}
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}
	}

	listTools() {
		const str = (description: string) => ({ type: "string" as const, description });
		return [
			{
				name: "project_list",
				description: "List all projects in the Memory Master library.",
				inputSchema: { type: "object" as const, properties: {} },
			},
			{
				name: "project_open",
				description:
					"Open a project by name (exact, display, or directory name). Ambiguous names return candidates — reopen with the project ID. The selection persists for this session.",
				inputSchema: {
					type: "object" as const,
					properties: { name: str("Project name or ID") },
					required: ["name"],
				},
			},
			{
				name: "project_current",
				description: "Show which project this session has open.",
				inputSchema: { type: "object" as const, properties: {} },
			},
			{
				name: "overview_read",
				description: "Read the selected project's overview (what it is, goal, current progress).",
				inputSchema: { type: "object" as const, properties: {} },
			},
			{
				name: "overview_write",
				description:
					"Update the selected project's overview sections. Requires base_version from a preceding overview_read — the write conflicts if the record changed since that read.",
				inputSchema: {
					type: "object" as const,
					properties: {
						base_version: str("The `version` value returned by your last overview_read (required)"),
						description: str("What the project is"),
						goal: str("Project goal"),
						current: str("Current progress"),
						features: str("可用能力或交付内容及其使用方法"),
					},
					required: ["base_version"],
				},
			},
			{
				name: "architecture_read",
				description:
					"Read the selected project's architecture record (项目架构) — the full Markdown document and its version.",
				inputSchema: { type: "object" as const, properties: {} },
			},
			{
				name: "architecture_write",
				description:
					"Replace the selected project's architecture record with the given Markdown content. Requires base_version from a preceding architecture_read — the write conflicts if the record changed since that read.",
				inputSchema: {
					type: "object" as const,
					properties: {
						content: str("The full architecture Markdown document"),
						base_version: str("The `version` value returned by your last architecture_read (required)"),
					},
					required: ["content", "base_version"],
				},
			},
			{
				name: "task_list",
				description: "List tasks in the selected project, optionally filtered by status.",
				inputSchema: {
					type: "object" as const,
					properties: { status: str('Status filter, e.g. "In Progress"') },
				},
			},
			{
				name: "task_get",
				description: "Read one task by ID.",
				inputSchema: {
					type: "object" as const,
					properties: { task_id: str("Task ID, e.g. TASK-1") },
					required: ["task_id"],
				},
			},
			{
				name: "task_create",
				description:
					"Create a task in the selected project. Priority is P0 (current focus, the default) or P1 (later).",
				inputSchema: {
					type: "object" as const,
					properties: {
						title: str("Task title"),
						status: str("Initial status"),
						description: str("Details"),
						priority: str("Priority: P0 (current focus, default) or P1 (later)"),
					},
					required: ["title"],
				},
			},
			{
				name: "task_update",
				description:
					"Update a task's title, status, description, or priority (P0 = current focus, P1 = later). Requires base_version from a preceding task_get/task_list — the write conflicts if the record changed since that read.",
				inputSchema: {
					type: "object" as const,
					properties: {
						task_id: str("Task ID, e.g. TASK-1"),
						base_version: str("The `version` value returned by your last read of this task (required)"),
						title: str("New title"),
						status: str("New status"),
						description: str("New description"),
						priority: str("New priority: P0 or P1"),
					},
					required: ["task_id", "base_version"],
				},
			},
			{
				name: "history_list",
				description:
					"List the selected project's change history (who changed what, before → after values). Optionally filter by ISO timestamps.",
				inputSchema: {
					type: "object" as const,
					properties: {
						since: str("ISO timestamp lower bound (inclusive)"),
						until: str("ISO timestamp upper bound (inclusive)"),
					},
				},
			},
			{
				name: "question_ask",
				description:
					"Record a decision the user must make (a question that would change the expected outcome). Ask the user directly in the current conversation — this persists the question on the project record. Link a task with task_id when relevant.",
				inputSchema: {
					type: "object" as const,
					properties: {
						title: str("The concrete question, one line"),
						task_id: str("Related task ID (optional)"),
						detail: str("Context, options, and your recommendation"),
					},
					required: ["title"],
				},
			},
			{
				name: "question_list",
				description: "List the selected project's pending questions (待决定事项). Filter by status: Open or Answered.",
				inputSchema: {
					type: "object" as const,
					properties: { status: str('"Open" or "Answered"') },
				},
			},
			{
				name: "question_get",
				description: "Read one question by ID (QUESTION-N).",
				inputSchema: {
					type: "object" as const,
					properties: { question_id: str("Question ID, e.g. QUESTION-1") },
					required: ["question_id"],
				},
			},
			{
				name: "question_answer",
				description:
					"Write the answer the user gave you in the current conversation back into the question. Once answered it is final — a second answer conflicts.",
				inputSchema: {
					type: "object" as const,
					properties: {
						question_id: str("Question ID, e.g. QUESTION-1"),
						answer: str("The user's answer"),
					},
					required: ["question_id", "answer"],
				},
			},
			{
				name: "resource_list",
				description: "List the selected project's uploaded resources (项目资料) — names and sizes.",
				inputSchema: { type: "object" as const, properties: {} },
			},
			{
				name: "resource_write",
				description:
					'Add or replace a file in the selected project\'s 资料 (resources) by name — agents can publish documents the user then opens in the web UI. Text is written as UTF-8; pass encoding "base64" for binary. A same-name file is overwritten.',
				inputSchema: {
					type: "object" as const,
					properties: {
						name: str("File name, e.g. architecture-overview.md"),
						content: str('File content — UTF-8 text by default, or base64 when encoding is "base64"'),
						encoding: str('"text" (default) or "base64"'),
					},
					required: ["name", "content"],
				},
			},
			{
				name: "resource_read",
				description: "Read one uploaded resource by name. Text files return inline text; binary files return base64.",
				inputSchema: {
					type: "object" as const,
					properties: { name: str("Exact file name from resource_list") },
					required: ["name"],
				},
			},
		];
	}
}

export async function startLibraryBridge(options: BridgeOptions): Promise<void> {
	const bridge = new LibraryBridge(options);
	// The startup ping is what proves this client's setup reached the service —
	// it flips the slot configured → connected. Warn (never block) on failure.
	try {
		const res = await fetch(`${options.serviceUrl}/api/agent/ping`, {
			headers: { authorization: `Bearer ${options.token}` },
			signal: AbortSignal.timeout(5_000),
		});
		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			console.error(
				`[memory-master] ping failed (${res.status}): ${body.error ?? "see the Memory Master settings page"}`,
			);
		}
	} catch {
		console.error(`[memory-master] cannot reach the service at ${options.serviceUrl} — is it running?`);
	}
	const server = new Server({ name: "memory-master", version: await getVersion() }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.listTools() }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		return await bridge.callTool(request.params.name, request.params.arguments ?? {});
	});
	await server.connect(new StdioServerTransport());
}
