import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry } from "../library/history.ts";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

/**
 * Phase-2 acceptance: optimistic version checks, per-project change history,
 * and the atomic "state + record" write unit — exercised black-box over HTTP
 * with the real service, the real MCP bridge, and on-disk assertions.
 */
describe("library history & versioning", () => {
	let home: string;
	let library: string;
	let service: LibraryService;
	let holds: TestHolds;
	let base: string;

	const req = async (
		path: string,
		opts: { method?: string; token?: string | null; body?: unknown } = {},
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		const token = opts.token ?? null;
		if (token) headers.authorization = `Bearer ${token}`;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		return await fetch(`${base}${path}`, {
			method: opts.method ?? "GET",
			headers,
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
		});
	};
	const json = async (res: Response) => await res.json();

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mm-hist-"));
		library = join(home, "library");
		process.env.MEMORY_MASTER_CLIENT_HOME = join(home, "client-home");
		holds = new TestHolds(true);
		service = new LibraryService({ settings: new AppSettingsStore(home), holds });
		await service.start(0);
		base = service.baseUrl();
		await req("/api/library", { method: "PUT", body: { libraryRoot: library } });
	});
	afterEach(async () => {
		await service.stop();
		delete process.env.MEMORY_MASTER_CLIENT_HOME;
		await rm(home, { recursive: true, force: true });
	});

	const createProject = async (name: string) => {
		const res = await req("/api/projects", { method: "POST", body: { name } });
		expect(res.status).toBe(201);
		return await json(res);
	};
	const enableClient = async (id: "codex" | "claude-code"): Promise<string> => {
		const res = await req(`/api/clients/${id}`, { method: "PUT", body: { enabled: true } });
		const token = (await json(res)).token;
		const ping = await req("/api/agent/ping", { token });
		expect(ping.status).toBe(200);
		return token;
	};
	const historyOf = async (projectId: string) => await json(await req(`/api/projects/${projectId}/history`));

	test("concurrent writes on different records land; the timeline attributes each actor", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");

		// Two agent sessions writing different tasks in parallel.
		const [a, b] = await Promise.all([
			req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: codex,
				body: { title: "退款流程梳理" },
			}),
			req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: claude,
				body: { title: "订单导出接口" },
			}),
		]);
		expect(a.status).toBe(201);
		expect(b.status).toBe(201);

		// And a user edit of the overview through the web channel.
		const ov = await json(await req(`/api/projects/${project.id}/overview`));
		const put = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { goal: "上线退款链路", baseVersion: ov.version },
		});
		expect(put.status).toBe(200);

		// Reads agree with disk.
		const tasks = await json(await req(`/api/agent/projects/${project.id}/tasks`, { token: codex }));
		expect(tasks.map((t: { title: string }) => t.title).sort()).toEqual(["订单导出接口", "退款流程梳理"]);
		expect((await readdir(join(project.dir, "memaster", "tasks"))).length).toBe(2);

		// The timeline shows the project creation + two agent creates + one user update.
		const entries: HistoryEntry[] = await historyOf(project.id);
		expect(entries.length).toBe(4);
		const actors = entries.map((e) => (e.actor.type === "user" ? "user" : e.actor.client));
		expect(actors[0]).toBe("user"); // project creation
		// The two parallel task creates serialize through the project lock in either order.
		expect([actors[1], actors[2]].sort()).toEqual(["claude-code", "codex"]);
		expect(actors[3]).toBe("user"); // overview update via the web channel
		expect(entries[1]!.target.id).toMatch(/^TASK-/);
		expect(entries[3]!.target.type).toBe("overview");
		expect(entries[3]!.changes.goal).toMatchObject({ to: "上线退款链路" });
	});

	test("stale writers conflict with the latest value; the timeline keeps only the winner", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");
		const created = await json(
			await req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: codex,
				body: { title: "对账任务" },
			}),
		);
		const taskId = created.id;

		// Both sessions read the same version.
		const read = async (token: string) =>
			await json(await req(`/api/agent/projects/${project.id}/tasks/${taskId}`, { token }));
		const v1 = (await read(codex)).version;
		expect((await read(claude)).version).toBe(v1);

		// Codex commits first.
		const win = await req(`/api/agent/projects/${project.id}/tasks/${taskId}`, {
			method: "PUT",
			token: codex,
			body: { status: "In Progress", baseVersion: v1 },
		});
		expect(win.status).toBe(200);

		// Claude's write on the stale version is a clear conflict carrying the latest value.
		const lose = await req(`/api/agent/projects/${project.id}/tasks/${taskId}`, {
			method: "PUT",
			token: claude,
			body: { status: "Done", baseVersion: v1 },
		});
		expect(lose.status).toBe(409);
		const loseBody = await json(lose);
		expect(loseBody.code).toBe("VERSION_CONFLICT");
		expect(loseBody.current.status).toBe("In Progress");
		expect(loseBody.current.version).not.toBe(v1);

		// Final state is the winner's; history recorded exactly the create + one update.
		const file = (await readdir(join(project.dir, "memaster", "tasks")))[0]!;
		const content = await Bun.file(join(project.dir, "memaster", "tasks", file)).text();
		expect(content).toContain("In Progress");
		expect(content).not.toContain("Done");
		const entries: HistoryEntry[] = await historyOf(project.id);
		const updates = entries.filter((e) => e.action === "update");
		expect(updates.length).toBe(1);
		expect(updates[0]!.changes.status).toEqual({ from: "To Do", to: "In Progress" });
	});

	test("overview updates conflict on stale versions too", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");
		const read = async (token: string) =>
			await json(await req(`/api/agent/projects/${project.id}/overview`, { token }));
		const v1 = (await read(codex)).version;

		const win = await req(`/api/agent/projects/${project.id}/overview`, {
			method: "PUT",
			token: codex,
			body: { current: "Codex 写入的进展", baseVersion: v1 },
		});
		expect(win.status).toBe(200);
		const lose = await req(`/api/agent/projects/${project.id}/overview`, {
			method: "PUT",
			token: claude,
			body: { current: "Claude 的过期覆盖", baseVersion: v1 },
		});
		expect(lose.status).toBe(409);
		expect((await json(lose)).current.current).toBe("Codex 写入的进展");
		expect((await json(await req(`/api/projects/${project.id}/overview`))).current).toBe("Codex 写入的进展");
	});

	test("a failure between the state write and history append rolls the record back", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const created = await json(
			await req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: codex,
				body: { title: "会被回滚的任务" },
			}),
		);

		// Injected failure: task file is written, then history append throws.
		holds.armHistoryFailure();
		const res = await req(`/api/agent/projects/${project.id}/tasks/${created.id}`, {
			method: "PUT",
			token: codex,
			body: { status: "Done", baseVersion: created.version },
		});
		expect(res.status).toBe(500);

		// Both sides of the unit stay at the last committed state.
		const file = (await readdir(join(project.dir, "memaster", "tasks")))[0]!;
		const content = await Bun.file(join(project.dir, "memaster", "tasks", file)).text();
		expect(content).toContain("To Do");
		expect(content).not.toContain("status: Done");
		const entries: HistoryEntry[] = await historyOf(project.id);
		expect(entries.filter((e) => e.action === "update").length).toBe(0);
	});

	test("history survives a service restart with full detail", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const created = await json(
			await req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: codex,
				body: { title: "重启前的任务" },
			}),
		);
		const before: HistoryEntry[] = await historyOf(project.id);
		const marker = before[before.length - 1]!.ts;

		await service.stop();
		service = new LibraryService({ settings: new AppSettingsStore(home), holds: new TestHolds(true) });
		await service.start(0);
		base = service.baseUrl();

		const since = await json(await req(`/api/projects/${project.id}/history?since=${encodeURIComponent(marker)}`));
		expect(since.length).toBe(1);
		expect(since[0].actor).toEqual({ type: "agent", client: "codex" });
		expect(since[0].target).toMatchObject({ type: "task", id: created.id, title: "重启前的任务" });
		expect(since[0].changes.title).toEqual({ to: "重启前的任务" });
		expect(since[0].version).toMatch(/^sha256:/);
	});

	test("no-op updates and version-less writes leave no trace", async () => {
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const created = await json(
			await req(`/api/agent/projects/${project.id}/tasks`, {
				method: "POST",
				token: codex,
				body: { title: "不变的任务" },
			}),
		);

		// Missing baseVersion is a validation error, not a silent last-write-wins.
		expect(
			(
				await req(`/api/agent/projects/${project.id}/tasks/${created.id}`, {
					method: "PUT",
					token: codex,
					body: { status: "Done" },
				})
			).status,
		).toBe(400);

		// A write that changes nothing records nothing.
		const noop = await req(`/api/agent/projects/${project.id}/tasks/${created.id}`, {
			method: "PUT",
			token: codex,
			body: { status: created.status, baseVersion: created.version },
		});
		expect(noop.status).toBe(200);
		const entries: HistoryEntry[] = await historyOf(project.id);
		expect(entries.filter((e) => e.action === "update").length).toBe(0);
	});

	test("bridge enforces base_version and surfaces conflicts with the latest value", async () => {
		await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");
		const a = new LibraryBridge({ serviceUrl: base, token: codex });
		const b = new LibraryBridge({ serviceUrl: base, token: claude });
		await a.callTool("project_open", { name: "订单系统" });
		await b.callTool("project_open", { name: "订单系统" });

		// Missing base_version → a readable instruction, not an HTTP 400.
		const missing = await a.callTool("task_update", { task_id: "TASK-1", status: "Done" });
		expect(missing.isError).toBe(true);
		expect(missing.content[0]!.text).toContain("base_version is required");

		await a.callTool("task_create", { title: "桥接冲突任务" });
		const list = (await b.callTool("task_list", {})).content[0]!.text;
		const task = JSON.parse(list)[0];
		expect(task.version).toMatch(/^sha256:/);

		await a.callTool("task_update", { task_id: task.id, base_version: task.version, status: "In Progress" });
		const conflict = await b.callTool("task_update", {
			task_id: task.id,
			base_version: task.version,
			status: "Done",
		});
		expect(conflict.isError).toBe(true);
		expect(conflict.content[0]!.text).toContain("VERSION_CONFLICT");
		expect(conflict.content[0]!.text).toContain("In Progress");

		const history = await b.callTool("history_list", {});
		expect(history.isError).toBeUndefined();
		expect(history.content[0]!.text).toContain("桥接冲突任务");
	});
});
