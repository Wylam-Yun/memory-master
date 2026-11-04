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
					const baseVersion = this.requireBaseVersion(args);
					const body: Record<string, unknown> = { baseVersion };
					for (const key of ["description", "goal", "current"] as const) {
						if (args[key] !== undefined) body[key] = args[key];
					}
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/overview`, {
							method: "PUT",
							body,
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
				case "task_create":
					return ok(
						await this.api(`/api/agent/projects/${this.requireProject().id}/tasks`, {
							method: "POST",
							body: { title: args.title, status: args.status, description: args.description },
						}),
					);
				case "task_update": {
					const body: Record<string, unknown> = { baseVersion: this.requireBaseVersion(args) };
					for (const key of ["title", "status", "description"] as const) {
						if (args[key] !== undefined) body[key] = args[key];
					}
					return ok(
						await this.api(
							`/api/agent/projects/${this.requireProject().id}/tasks/${encodeURIComponent(String(args.task_id ?? ""))}`,
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
					},
					required: ["base_version"],
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
				description: "Create a task in the selected project.",
				inputSchema: {
					type: "object" as const,
					properties: {
						title: str("Task title"),
						status: str("Initial status"),
						description: str("Details"),
					},
					required: ["title"],
				},
			},
			{
				name: "task_update",
				description:
					"Update a task's title, status, or description. Requires base_version from a preceding task_get/task_list — the write conflicts if the record changed since that read.",
				inputSchema: {
					type: "object" as const,
					properties: {
						task_id: str("Task ID, e.g. TASK-1"),
						base_version: str("The `version` value returned by your last read of this task (required)"),
						title: str("New title"),
						status: str("New status"),
						description: str("New description"),
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
					"Record a decision the user must make (a question that would change the expected outcome). Also ask the user directly in the conversation — this persists it on the project so the web page shows it too. Link a task with task_id when relevant.",
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
					"Write the answer the user gave you in conversation back into the question. Once answered it is final — a second answer conflicts.",
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
