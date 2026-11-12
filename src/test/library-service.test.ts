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
	let holds: TestHolds;
	let base: string;

	const req = async (
		path: string,
		opts: { method?: string; token?: string | null; body?: unknown } = {},
	): Promise<Response> => {
		const headers: Record<string, string> = {};
		// Web routes need no credential; agent routes get an explicit client token.
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
		home = await mkdtemp(join(tmpdir(), "mm-home-"));
		library = join(home, "library");
		// Client installs must never touch the developer's real ~/.claude* or
		// ~/.codex* — point the installer family at a temp home.
		process.env.MEMORY_MASTER_CLIENT_HOME = join(home, "client-home");
		holds = new TestHolds(true);
		service = new LibraryService({
			settings: new AppSettingsStore(home),
			holds,
		});
		await service.start(0);
		base = service.baseUrl();
	});

	afterEach(async () => {
		await service.stop();
		delete process.env.MEMORY_MASTER_CLIENT_HOME;
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
	// Enable runs the real installer (against the temp client home), then the
	// bridge ping flips configured → connected — mirroring production.
	const enableClient = async (id: "codex" | "claude-code"): Promise<string> => {
		const res = await req(`/api/clients/${id}`, { method: "PUT", body: { enabled: true } });
		expect(res.status).toBe(200);
		const token = (await json(res)).token;
		const ping = await req("/api/agent/ping", { token });
		expect(ping.status).toBe(200);
		return token;
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

	test("chat project creation, candidate discovery and directory updates share the web records", async () => {
		await setupLibrary();
		const token = await enableClient("codex");
		const bridge = new LibraryBridge({ serviceUrl: base, token });
		const value = (result: Awaited<ReturnType<LibraryBridge["callTool"]>>) => {
			expect(result.isError).not.toBe(true);
			return JSON.parse(result.content[0]?.text ?? "{}");
		};
		const project = value(await bridge.callTool("project_create", { name: "读书会", working_dir: home })).opened;
		expect(project.version).toStartWith("sha256:");
		expect((await json(await req("/api/projects")))[0].id).toBe(project.id);
		const overview = value(await bridge.callTool("overview_read", {}));
		value(
			await bridge.callTool("overview_write", {
				base_version: overview.version,
				description: "组织每月科幻阅读和线下交流",
			}),
		);
		value(await bridge.callTool("project_create", { name: "周末活动" }));
		const selected = value(await bridge.callTool("project_current", {})).project;
		const candidates = value(await bridge.callTool("project_search", { query: "科幻阅读" }));
		expect(candidates.projects.map((p: { id: string }) => p.id)).toContain(project.id);
		expect(candidates.projects[0].description).toContain("科幻");
		expect(value(await bridge.callTool("project_search", { working_dir: home })).projects[0].id).toBe(project.id);
		expect(value(await bridge.callTool("project_current", {})).project.id).toBe(selected.id);
		expect((await bridge.callTool("project_create", { name: "读书会" })).isError).toBe(true);
		expect(value(await bridge.callTool("project_current", {})).project.id).toBe(selected.id);
		value(await bridge.callTool("project_open", { name: project.id }));
		const configPath = join(project.dir, "memaster", "config.yml");
		await Bun.write(configPath, `${await Bun.file(configPath).text()}\n# 用户自定义配置\ncustom_key: keep-me\n`);
		const before = value(await bridge.callTool("project_current", {})).project;
		const work = join(home, 'O\'Brien-"资料"');
		await import("node:fs/promises").then(({ mkdir }) => mkdir(work));
		const changed = value(
			await bridge.callTool("project_update", { working_dir: work, base_version: before.version }),
		).project;
		expect(changed.workingDir).toBe(work);
		expect((await json(await req(`/api/projects/${project.id}`))).workingDir).toBe(work);
		expect(await Bun.file(configPath).text()).toContain("# 用户自定义配置\ncustom_key: keep-me");
		const conflict = await req(`/api/projects/${project.id}`, {
			method: "PUT",
			body: { workingDir: null, baseVersion: before.version },
		});
		expect(conflict.status).toBe(409);
		expect((await json(conflict)).current.workingDir).toBe(work);
		const historyBefore = await json(await req(`/api/projects/${project.id}/history`));
		value(await bridge.callTool("project_update", { working_dir: work, base_version: changed.version }));
		expect((await json(await req(`/api/projects/${project.id}/history`))).length).toBe(historyBefore.length);
		holds.armHistoryFailure();
		expect(
			(await bridge.callTool("project_update", { working_dir: null, base_version: changed.version })).isError,
		).toBe(true);
		expect(value(await bridge.callTool("project_current", {})).project.workingDir).toBe(work);
		const unlinked = await req(`/api/projects/${project.id}`, {
			method: "PUT",
			body: { workingDir: null, baseVersion: changed.version },
		});
		expect(unlinked.status).toBe(200);
		expect((await json(unlinked)).workingDir).toBeUndefined();
		expect(value(await bridge.callTool("project_current", {})).project.workingDir).toBeUndefined();
		const history = await json(await req(`/api/projects/${project.id}/history`));
		expect(history[0].actor).toEqual({ type: "agent", client: "codex" });
		expect(history[0].changes.workingDir.to).toBe(home);
	});

	test("project creation is serialized and failures or revocation leave no partial project", async () => {
		await setupLibrary();
		const token = await enableClient("codex");
		const create = (name: string) => req("/api/agent/projects", { method: "POST", token, body: { name } });
		const responses = await Promise.all([create("同一项目"), create("同一项目")]);
		expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
		holds.armHistoryFailure();
		expect((await create("写入失败")).status).toBe(500);
		expect((await json(await req("/api/projects"))).map((p: { name: string }) => p.name)).toEqual(["同一项目"]);
		const hold = holds.create("create-before-publish");
		const pending = create("撤销期间创建");
		await holds.waitForWaiter();
		expect((await json(await req("/api/projects"))).length).toBe(1);
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		holds.release(hold.id);
		expect((await pending).status).toBe(403);
		expect((await json(await req("/api/projects"))).length).toBe(1);
		expect((await readdir(library)).some((name) => name.startsWith(".project-"))).toBe(false);
		expect((await create("无授权")).status).toBe(403);
		expect((await req("/api/agent/projects/search", { method: "POST", token, body: { query: "项目" } })).status).toBe(
			403,
		);
	});

	test("directory updates validate inputs and recheck authorization before committing", async () => {
		await setupLibrary();
		const project = await createProject("目录关联");
		const token = await enableClient("codex");
		const update = (workingDir: unknown, baseVersion = project.version) =>
			req(`/api/agent/projects/${project.id}`, {
				method: "PUT",
				token,
				body: { workingDir, baseVersion },
			});
		for (const invalid of ["relative/path", "/no/such/directory", 42]) expect((await update(invalid)).status).toBe(400);
		expect((await update(home, "")).status).toBe(400);
		const hold = holds.create("directory-before-write");
		const pending = update(home);
		await holds.waitForWaiter();
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		holds.release(hold.id);
		expect((await pending).status).toBe(403);
		expect((await json(await req(`/api/projects/${project.id}`))).workingDir).toBeUndefined();
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

		// Park the agent write inside the task lock — proven parked via waitForWaiter —
		// revoke, then release. The in-lock re-check must reject it.
		const hold = await json(await req("/api/test/holds", { method: "POST", body: { name: "pre-commit" } }));
		const writePromise = req(`/api/agent/projects/${project.id}/tasks/${task.id}`, {
			method: "PUT",
			token,
			body: { status: "Done", baseVersion: task.version },
		});
		await holds.waitForWaiter();
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
		const { version } = await json(await req(`/api/projects/${project.id}/overview`));

		const put = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { goal: "一个月内上线退款流程", current: "梳理中", baseVersion: version },
		});
		expect(put.status).toBe(200);

		// External end state: the overview file itself carries the new section text.
		const overview = await Bun.file(join(project.dir, "memaster", "overview.md")).text();
		expect(overview).toContain("一个月内上线退款流程");
		expect(overview).toContain("梳理中");

		const fresh = await json(await req(`/api/projects/${project.id}/overview`));
		const evil = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { goal: "x\n<!-- SECTION:GOAL:BEGIN -->", baseVersion: fresh.version },
		});
		expect(evil.status).toBe(400);
	});

	test("web API serves loopback without any credential and rejects foreign Hosts", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const agentToken = await enableClient("codex");

		// No credential at all → 200 on every web route family.
		expect((await req("/api/projects", { token: null })).status).toBe(200);
		expect((await req("/api/library", { token: null })).status).toBe(200);
		expect((await req(`/api/projects/${project.id}/tasks`, { token: null })).status).toBe(200);

		// A non-loopback Host header is refused outright.
		const foreign = await fetch(`${base}/api/projects`, {
			headers: { host: "evil.example" },
		});
		expect(foreign.status).toBe(403);

		// An agent token on a web route is simply ignored — nothing to check.
		expect((await req("/api/projects", { token: agentToken })).status).toBe(200);

		// Revoking the client changes nothing for the human's web session.
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect((await req("/api/agent/ping", { token: agentToken })).status).toBe(403);
		const webWrite = await req(`/api/projects/${project.id}/tasks`, {
			method: "POST",
			body: { title: "网页直接创建" },
		});
		expect(webWrite.status).toBe(201);
		expect((await readdir(join(project.dir, "memaster", "tasks"))).length).toBe(1);
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

	test("a second service instance on the same settings home is refused", async () => {
		const second = new LibraryService({
			settings: new AppSettingsStore(home),
			holds: new TestHolds(true),
		});
		await expect(second.start(0)).rejects.toThrow(/already running/);
	});

	test("authorization reflects settings changed by another process", async () => {
		await setupLibrary();
		const token = await enableClient("codex");
		expect((await req("/api/agent/ping", { token })).status).toBe(200);

		// Another process (or hand edit) disables the client directly in the file.
		const path = join(home, "settings.json");
		const current = JSON.parse(await Bun.file(path).text());
		current.clients.codex.enabled = false;
		await Bun.write(path, JSON.stringify(current));
		// mtime granularity can equal the previous write; nudge it forward.
		const { utimes } = await import("node:fs/promises");
		const future = new Date(Date.now() + 2000);
		await utimes(path, future, future);

		const denied = await req("/api/agent/ping", { token });
		expect(denied.status).toBe(403);
		expect((await json(denied)).code).toBe("ACCESS_DISABLED");
	});

	test("a write parked before commit is cancelled when the service stops", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const created = await req(`/api/projects/${project.id}/tasks`, {
			method: "POST",
			body: { title: "初始任务" },
		});
		const task = await json(created);

		const hold = await json(await req("/api/test/holds", { method: "POST", body: { name: "pre-commit" } }));
		const writePromise = req(`/api/agent/projects/${project.id}/tasks/${task.id}`, {
			method: "PUT",
			token,
			body: { status: "Done", baseVersion: task.version },
		})
			.then((r) => ({ status: r.status }) as { status: number | "failed" })
			.catch(() => ({ status: "failed" as const }));

		await holds.waitForWaiter();
		// stop() sets `stopping` synchronously then drains in-flight requests —
		// release the hold so the parked write resumes and hits the stopping check.
		const stopPromise = service.stop();
		holds.release(hold.id);

		const result = await writePromise;
		await stopPromise;
		// Either the handler answered 503 or the connection died mid-stop: both mean "not written".
		expect(result.status === 503 || result.status === "failed").toBe(true);

		const [file] = await readdir(join(project.dir, "memaster", "tasks"));
		const content = await Bun.file(join(project.dir, "memaster", "tasks", file!)).text();
		expect(content).toContain("To Do");
		expect(content).not.toContain("status: Done");
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
