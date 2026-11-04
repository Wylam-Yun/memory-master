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
		} catch {
			throw new Error(`Cannot reach the Memory Master service at ${this.options.serviceUrl}. Is it running?`);
		}
		const data = (await response.json().catch(() => ({}))) as {
			error?: string;
			code?: string;
			candidates?: unknown;
		};
		if (!response.ok) {
			const suffix = data.code ? ` [${data.code}]` : "";
			const hint =
				data.code === "PROJECT_AMBIGUOUS" && Array.isArray(data.candidates)
					? ` Candidates: ${JSON.stringify(data.candidates)}`
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
					const body: Record<string, unknown> = {};
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
					const body: Record<string, unknown> = {};
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
				description: "Update the selected project's overview sections.",
				inputSchema: {
					type: "object" as const,
					properties: {
						description: str("What the project is"),
						goal: str("Project goal"),
						current: str("Current progress"),
					},
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
				description: "Update a task's title, status, or description.",
				inputSchema: {
					type: "object" as const,
					properties: {
						task_id: str("Task ID, e.g. TASK-1"),
						title: str("New title"),
						status: str("New status"),
						description: str("New description"),
					},
					required: ["task_id"],
				},
			},
		];
	}
}

export async function startLibraryBridge(options: BridgeOptions): Promise<void> {
	const bridge = new LibraryBridge(options);
	const server = new Server({ name: "memory-master", version: await getVersion() }, { capabilities: { tools: {} } });
	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: bridge.listTools() }));
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		return await bridge.callTool(request.params.name, request.params.arguments ?? {});
	});
	await server.connect(new StdioServerTransport());
}
