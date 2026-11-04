import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

describe("library service", () => {
	let home: string;
	let library: string;
	let service: LibraryService;
	let base: string;

	const req = async (
		path: string,
		opts: { method?: string; token?: string; body?: unknown } = {},
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		if (opts.token) headers.authorization = `Bearer ${opts.token}`;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		return await fetch(`${base}${path}`, {
			method: opts.method ?? "GET",
			headers,
			...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
		});
	};
	const json = async (res: Response) => await res.json();

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mm-home-"));
		library = join(home, "library");
		service = new LibraryService({
			settings: new AppSettingsStore(home),
			holds: new TestHolds(true),
		});
		await service.start(0);
		base = service.baseUrl();
	});

	afterEach(async () => {
		await service.stop();
		await rm(home, { recursive: true, force: true });
	});

	const setupLibrary = async () => {
		const res = await req("/api/library", { method: "PUT", body: { libraryRoot: library } });
		expect(res.status).toBe(200);
	};
	const createProject = async (name: string) => {
		const res = await req("/api/projects", { method: "POST", body: { name } });
		expect(res.status).toBe(201);
		return await json(res);
	};
	const enableClient = async (id: "codex" | "claude-code"): Promise<string> => {
		const res = await req(`/api/clients/${id}`, { method: "PUT", body: { enabled: true } });
		expect(res.status).toBe(200);
		return (await json(res)).token;
	};

	test("requires a library selection before project operations", async () => {
		const res = await req("/api/projects");
		expect(res.status).toBe(409);
		expect((await json(res)).code).toBe("LIBRARY_NOT_SET");

		await setupLibrary();
		expect((await req("/api/projects")).status).toBe(200);
		// The chosen root is real on disk and persisted in app settings.
		expect((await readdir(library)).length).toBe(0);
		const settings = JSON.parse(await Bun.file(join(home, "settings.json")).text());
		expect(settings.libraryRoot).toBe(library);
	});

	test("two library projects stay isolated through the web API and on disk", async () => {
		await setupLibrary();
		const orders = await createProject("订单系统");
		const travel = await createProject("旅行筹备");
		expect(orders.id).not.toBe(travel.id);

		const created = await req(`/api/projects/${orders.id}/tasks`, {
			method: "POST",
			body: { title: "退款流程梳理" },
		});
		expect(created.status).toBe(201);
		const taskId = (await json(created)).id;
		expect(taskId).toMatch(/^TASK-\d+$/);

		const ordersTasks = await json(await req(`/api/projects/${orders.id}/tasks`));
		const travelTasks = await json(await req(`/api/projects/${travel.id}/tasks`));
		expect(ordersTasks.map((t: { title: string }) => t.title)).toEqual(["退款流程梳理"]);
		expect(travelTasks).toEqual([]);

		// Black-box disk check: the task file exists only under the orders project.
		const ordersTaskFiles = await readdir(join(orders.dir, "memaster", "tasks"));
		const travelTaskFiles = await readdir(join(travel.dir, "memaster", "tasks"));
		expect(ordersTaskFiles.length).toBe(1);
		expect(ordersTaskFiles[0]!.toLowerCase()).toContain(taskId.toLowerCase());
		expect(travelTaskFiles).toEqual([]);
	});

	test("agent API enforces per-client credentials and instant revocation", async () => {
		await setupLibrary();
		await createProject("订单系统");
		const codexToken = await enableClient("codex");
		const claudeToken = await enableClient("claude-code");

		expect((await req("/api/agent/ping")).status).toBe(401);
		expect((await req("/api/agent/ping", { token: "mm_codex_wrong" })).status).toBe(401);
		const ping = await req("/api/agent/ping", { token: codexToken });
		expect(ping.status).toBe(200);
		expect((await json(ping)).client).toBe("codex");

		// Revoke codex: its token is rejected while claude-code stays usable.
		const disable = await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect(disable.status).toBe(200);
		const revoked = await req("/api/agent/ping", { token: codexToken });
		expect(revoked.status).toBe(403);
		expect((await json(revoked)).code).toBe("ACCESS_DISABLED");
		expect((await req("/api/agent/ping", { token: claudeToken })).status).toBe(200);
	});

	test("agent resolve maps names to stable ids and reports misses", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");

		const resolved = await req("/api/agent/projects/resolve", {
			method: "POST",
			token,
			body: { name: "订单系统" },
		});
		expect(resolved.status).toBe(200);
		expect((await json(resolved)).id).toBe(project.id);

		const missing = await req("/api/agent/projects/resolve", {
			method: "POST",
			token,
			body: { name: "不存在的项目" },
		});
		expect(missing.status).toBe(404);
		expect((await json(missing)).code).toBe("PROJECT_NOT_FOUND");

		// A fuzzy reference never opens silently — it returns candidates for an explicit pick.
		const fuzzy = await req("/api/agent/projects/resolve", {
			method: "POST",
			token,
			body: { name: "订单" },
		});
		expect(fuzzy.status).toBe(409);
		const fuzzyBody = await json(fuzzy);
		expect(fuzzyBody.code).toBe("PROJECT_AMBIGUOUS");
		expect(fuzzyBody.candidates.map((c: { id: string }) => c.id)).toContain(project.id);
	});

	test("a write parked before commit cannot land after revoke", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const created = await req(`/api/projects/${project.id}/tasks`, {
			method: "POST",
			body: { title: "初始任务" },
		});
		const task = await json(created);

		// Park the agent write inside the task lock, revoke, then release.
		const hold = await json(await req("/api/test/holds", { method: "POST", body: { name: "pre-commit" } }));
		const writePromise = req(`/api/agent/projects/${project.id}/tasks/${task.id}`, {
			method: "PUT",
			token,
			body: { status: "Done" },
		});
		const revoke = await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect(revoke.status).toBe(200);
		await req(`/api/test/holds/${hold.id}`, { method: "DELETE" });

		const writeRes = await writePromise;
		expect(writeRes.status).toBe(403);
		expect((await json(writeRes)).code).toBe("ACCESS_DISABLED");

		// External end state: file on disk still holds the pre-revoke value.
		const [file] = await readdir(join(project.dir, "memaster", "tasks"));
		const content = await Bun.file(join(project.dir, "memaster", "tasks", file!)).text();
		expect(content).toContain("To Do");
		expect(content).not.toContain("Done");
		// And the (unauthorized user) web view agrees.
		const webTask = await json(await req(`/api/projects/${project.id}/tasks/${task.id}`));
		expect(webTask.status).toBe("To Do");
	});

	test("overview writes persist on disk and reject sentinel injection", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");

		const put = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { goal: "一个月内上线退款流程", current: "梳理中" },
		});
		expect(put.status).toBe(200);

		// External end state: the overview file itself carries the new section text.
		const overview = await Bun.file(join(project.dir, "memaster", "overview.md")).text();
		expect(overview).toContain("一个月内上线退款流程");
		expect(overview).toContain("梳理中");

		const evil = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { goal: "x\n<!-- SECTION:GOAL:BEGIN -->" },
		});
		expect(evil.status).toBe(400);
	});

	test("web writes are unaffected by client revocation", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		await enableClient("codex");
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		await req("/api/clients/claude-code", { method: "PUT", body: { enabled: false } });

		const res = await req(`/api/projects/${project.id}/tasks`, {
			method: "POST",
			body: { title: "网页直接创建" },
		});
		expect(res.status).toBe(201);
	});

	test("MCP bridge tools drive the service and surface readable errors", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const bridge = new LibraryBridge({ serviceUrl: base, token });

		const opened = await bridge.callTool("project_open", { name: "订单系统" });
		expect(opened.isError).toBeUndefined();
		expect(opened.content[0]!.text).toContain(project.id);

		const created = await bridge.callTool("task_create", { title: "桥接创建的任务" });
		expect(created.isError).toBeUndefined();
		const tasks = await json(await req(`/api/projects/${project.id}/tasks`));
		expect(tasks.map((t: { title: string }) => t.title)).toEqual(["桥接创建的任务"]);

		// Revocation shows up at the tool layer as a readable error, not a stack trace.
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		const denied = await bridge.callTool("task_list", {});
		expect(denied.isError).toBe(true);
		expect(denied.content[0]!.text).toContain("ACCESS_DISABLED");

		// Dead service → an understandable "not running" error.
		await service.stop();
		const down = await bridge.callTool("project_list", {});
		expect(down.isError).toBe(true);
		expect(down.content[0]!.text).toContain("Cannot reach the Memory Master service");
	});

	test("stopping the service rejects everything; restart restores authorization state", async () => {
		await setupLibrary();
		const token = await enableClient("codex");

		await service.stop();
		await expect(req("/api/agent/ping", { token })).rejects.toThrow();

		// A fresh service over the same settings home restores persisted state.
		service = new LibraryService({
			settings: new AppSettingsStore(home),
			holds: new TestHolds(true),
		});
		await service.start(0);
		base = service.baseUrl();
		const ping = await req("/api/agent/ping", { token });
		expect(ping.status).toBe(200);
		expect((await json(ping)).client).toBe("codex");
	});
});
