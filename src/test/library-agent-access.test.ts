import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

describe("Agent project access", () => {
	let home: string;
	let settings: AppSettingsStore;
	let service: LibraryService;
	let holds: TestHolds;

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mm-agent-access-"));
		settings = new AppSettingsStore(home);
		holds = new TestHolds(true);
		service = new LibraryService({ settings, holds });
		await service.start(0);
		expect((await req("/api/library", { libraryRoot: join(home, "library") }, undefined, "PUT")).status).toBe(200);
	});

	afterEach(async () => {
		await service.stop();
		await rm(home, { recursive: true, force: true });
	});

	function req(path: string, body?: object, token?: string, method = body === undefined ? "GET" : "POST") {
		return fetch(service.baseUrl() + path, {
			method,
			headers: {
				...(token && { authorization: `Bearer ${token}` }),
				...(body && { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	async function project(name: string): Promise<{ id: string; dir: string }> {
		const res = await req("/api/projects", { name });
		expect(res.status).toBe(201);
		return res.json();
	}

	async function client(id: "codex" | "claude-code") {
		const slot = await settings.setClientEnabled(id, true);
		const { token } = slot;
		if (!token) throw new Error("Expected a fixture credential");
		expect((await req("/api/agent/ping", undefined, token)).status).toBe(200);
		return token;
	}

	async function policy(id: string, patch: object) {
		const res = await req(`/api/projects/${id}/agent-access/codex`, patch, undefined, "PUT");
		expect(res.status).toBe(200);
		return res.json();
	}

	async function defaultWrite(allowWrite: boolean) {
		const res = await req("/api/clients/codex/write-access", { allowWrite }, undefined, "PUT");
		expect(res.status).toBe(200);
	}

	test("a new connection is read-only, and only the selected project and client inherit an explicit write grant", async () => {
		const a = await project("Project A");
		const b = await project("Project B");
		const codex = await client("codex");
		const claude = await client("claude-code");
		const create = (id: string, token: string, title: string) =>
			req(`/api/agent/projects/${id}/tasks`, { title }, token);

		expect((await req(`/api/agent/projects/${a.id}/overview`, undefined, codex)).status).toBe(200);
		const readOnly = await create(a.id, codex, "Denied before grant");
		expect(readOnly.status).toBe(403);
		expect((await readOnly.json()).code).toBe("WRITE_DISABLED");

		expect((await policy(a.id, { allowWrite: true })).canWrite).toBe(true);
		expect((await create(a.id, codex, "Allowed in A")).status).toBe(201);
		expect((await create(b.id, codex, "Denied in B")).status).toBe(403);
		expect((await create(a.id, claude, "Denied for Claude")).status).toBe(403);

		await defaultWrite(true);
		await policy(a.id, { allowWrite: false });
		expect((await create(a.id, codex, "Denied by override")).status).toBe(403);
		expect((await create(b.id, codex, "Allowed by default")).status).toBe(201);
		await policy(a.id, { allowWrite: null });
		expect((await create(a.id, codex, "Allowed after reset")).status).toBe(201);
		expect((await create(a.id, claude, "Human can still edit")).status).toBe(403);
		expect((await req(`/api/projects/${a.id}/tasks`, { title: "Human can still edit" })).status).toBe(201);
		for (const [id, titles] of [
			[a.id, ["Allowed in A", "Allowed after reset", "Human can still edit"]],
			[b.id, ["Allowed by default"]],
		] as const) {
			const res = await req(`/api/projects/${id}/tasks`);
			expect(res.status).toBe(200);
			expect((await res.json()).map((t: { title: string }) => t.title).sort()).toEqual([...titles].sort());
		}
	});

	async function restart() {
		await service.stop();
		settings = new AppSettingsStore(home);
		service = new LibraryService({ settings, holds });
		await service.start(0);
	}

	async function snapshot(dir: string): Promise<unknown> {
		const entries = await readdir(dir, { withFileTypes: true });
		return Promise.all(
			entries
				.sort((a, b) => a.name.localeCompare(b.name))
				.map(async (entry) => {
					const path = join(dir, entry.name);
					return [entry.name, entry.isDirectory() ? await snapshot(path) : await Bun.file(path).text()];
				}),
		);
	}

	test("hidden projects cannot be discovered or reused from a selected MCP session", async () => {
		const a = await project("Project A public");
		const b = await project("Project B private");
		const codex = await client("codex");
		const claude = await client("claude-code");
		const bridge = new LibraryBridge({ serviceUrl: service.baseUrl(), token: codex });
		const tool = (name: string, args: Record<string, unknown> = {}) => bridge.callTool(name, args);

		expect((await tool("project_open", { name: b.id })).isError).toBeUndefined();
		expect((await tool("project_current")).isError).toBeUndefined();
		await policy(b.id, { allowConnection: false, allowWrite: true });
		const list = await req("/api/agent/projects", undefined, codex);
		expect(list.status).toBe(200);
		expect((await list.json()).map((p: { id: string }) => p.id)).toEqual([a.id]);
		const fuzzy = await req("/api/agent/projects/resolve", { name: "Project" }, codex);
		expect(fuzzy.status).toBe(409);
		expect((await fuzzy.json()).candidates.map((p: { id: string }) => p.id)).toEqual([a.id]);

		for (const name of [b.id, "Project B private", "private"]) {
			const denied = await tool("project_open", { name });
			expect(denied.isError).toBe(true);
			expect(denied.content[0]?.text).toContain("[PROJECT_NOT_FOUND]");
		}
		for (const name of ["project_current", "overview_read", "history_list", "resource_list"]) {
			const denied = await tool(name);
			expect(denied.isError).toBe(true);
			expect(denied.content[0]?.text).toContain("[PROJECT_NOT_FOUND]");
		}
		expect((await req(`/api/agent/projects/${b.id}/overview`, undefined, claude)).status).toBe(200);
		expect((await req(`/api/projects/${b.id}/overview`)).status).toBe(200);
		await policy(b.id, { allowConnection: true });
		expect((await tool("overview_read")).isError).toBeUndefined();
		expect((await req("/api/clients/codex", { enabled: false }, undefined, "PUT")).status).toBe(200);
		const blocked = await tool("overview_read");
		expect(blocked.isError).toBe(true);
		expect(blocked.content[0]?.text).toContain("[ACCESS_DISABLED]");
	});

	test("each project mutation is denied on entry and again when permission is revoked while parked", async () => {
		const a = await project("Concurrent project");
		const codex = await client("codex");
		const web = `/api/projects/${a.id}`;
		const agent = `/api/agent/projects/${a.id}`;
		const createTask = await req(`${web}/tasks`, { title: "Existing task" });
		expect(createTask.status).toBe(201);
		const task = await createTask.json();
		const question = await req(`${web}/questions`, { title: "Existing question" });
		expect(question.status).toBe(201);
		const q = await question.json();
		const overview = await (await req(`${web}/overview`)).json();
		const architecture = await (await req(`${web}/architecture`)).json();
		const goal = await req(`${web}/goals`, {
			key: "existing-goal",
			title: "Existing goal",
			baseVersion: overview.version,
		});
		expect(goal.status).toBe(200);
		const g = await goal.json();
		const goalVersion = (await (await req(`${web}/overview`)).json()).version;
		const progress = await req(`${web}/progress`, {
			key: "existing-progress",
			title: "Existing progress",
			summary: "Description",
			baseVersion: goalVersion,
		});
		expect(progress.status).toBe(200);
		const p = await progress.json();
		const version = (await (await req(`${web}/overview`)).json()).version;

		const before = await snapshot(a.dir);
		const cases = [
			["/overview", { current: "Denied update", baseVersion: version }, "PUT"],
			["/architecture", { content: "# Denied update", baseVersion: architecture.version }, "PUT"],
			["/tasks", { title: "Denied creation" }, "POST"],
			[`/tasks/${task.id}`, { title: "Denied update", baseVersion: task.version }, "PUT"],
			["/goals", { key: "denied-goal", title: "Denied goal", baseVersion: version }, "POST"],
			[`/goals/${g.id}`, { status: "completed", baseVersion: version }, "PUT"],
			[
				"/progress",
				{ key: "denied-progress", title: "Denied progress", summary: "Description", baseVersion: version },
				"POST",
			],
			[`/progress/${p.id}`, { summary: "Denied update", baseVersion: version }, "PUT"],
			["/questions", { title: "Denied question" }, "POST"],
			[`/questions/${q.id}`, { answer: "Denied answer" }, "PUT"],
			["/resources", { name: "denied.md", base64: "ZGVuaWVk" }, "POST"],
		] as const;
		for (const [path, body, method] of cases) {
			const denied = await req(agent + path, body, codex, method);
			expect(denied.status, path).toBe(403);
			expect((await denied.json()).code, path).toBe("WRITE_DISABLED");

			await policy(a.id, { allowWrite: true });
			const hold = holds.create(path);
			const pending = req(agent + path, body, codex, method);
			try {
				await holds.waitForWaiter(1000);
				await policy(a.id, { allowWrite: false });
			} finally {
				holds.release(hold.id);
			}
			const revoked = await pending;
			expect(revoked.status, path).toBe(403);
			expect((await revoked.json()).code, path).toBe("WRITE_DISABLED");
			expect(await snapshot(a.dir), path).toEqual(before);
		}

		for (const path of [
			"/overview",
			"/architecture",
			"/tasks",
			"/goals",
			"/progress",
			"/questions",
			"/resources",
			"/history",
		]) {
			expect((await req(agent + path, undefined, codex)).status, path).toBe(200);
		}
	});

	test("global defaults, project revocation, and concurrent field updates retain their own scope", async () => {
		const a = await project("Default permissions");
		const codex = await client("codex");
		const agent = `/api/agent/projects/${a.id}`;
		const before = await snapshot(a.dir);
		for (const revoke of ["global-write", "project-connection"] as const) {
			await policy(a.id, { allowWrite: null, allowConnection: null });
			await defaultWrite(true);
			const hold = holds.create(revoke);
			const pending = req(`${agent}/tasks`, { title: "Revoked during write" }, codex);
			try {
				await holds.waitForWaiter(1000);
				if (revoke === "global-write") await defaultWrite(false);
				else await policy(a.id, { allowConnection: false });
			} finally {
				holds.release(hold.id);
			}
			const response = await pending;
			expect(response.status).toBe(revoke === "global-write" ? 403 : 404);
			expect((await response.json()).code).toBe(revoke === "global-write" ? "WRITE_DISABLED" : "PROJECT_NOT_FOUND");
			expect(await snapshot(a.dir)).toEqual(before);
		}

		await Promise.all([policy(a.id, { allowConnection: true }), policy(a.id, { allowWrite: true })]);
		const accessPath = `/api/projects/${a.id}/agent-access`;
		const access = await req(accessPath);
		expect(access.status).toBe(200);
		const saved = (await access.json()).find((row: { id: string }) => row.id === "codex");
		expect(saved.override).toEqual({ allowConnection: true, allowWrite: true });
		for (const invalid of [{ allowWrite: "yes" }, { allowRead: false }, {}]) {
			const denied = await req(`${accessPath}/codex`, invalid, undefined, "PUT");
			expect(denied.status).toBe(400);
		}
		const afterInvalid = await req(accessPath);
		expect(afterInvalid.status).toBe(200);
		expect((await afterInvalid.json()).find((row: { id: string }) => row.id === "codex").override).toEqual(
			saved.override,
		);
	});

	test("persisted permissions survive restart and are scoped to the selected library", async () => {
		const a = await project("Project A");
		const codex = await client("codex");
		const settingsPath = settings.filePath;
		const legacy = await Bun.file(settingsPath).json();
		delete legacy.clients.codex.allowWrite;
		await Bun.write(settingsPath, JSON.stringify(legacy));
		await restart();

		const clients = await req("/api/clients");
		expect(clients.status).toBe(200);
		expect((await clients.json()).find((c: { id: string }) => c.id === "codex").allowWrite).toBe(true);
		const path = `/api/agent/projects/${a.id}/tasks`;
		expect((await req(path, { title: "Legacy writer kept" }, codex)).status).toBe(201);
		await policy(a.id, { allowWrite: false });
		await restart();
		expect((await req(path, { title: "Persisted read-only override" }, codex)).status).toBe(403);

		const otherLibrary = join(home, "other-library");
		await cp(join(home, "library"), otherLibrary, { recursive: true });
		expect((await req("/api/library", { libraryRoot: otherLibrary }, undefined, "PUT")).status).toBe(200);
		expect((await req(path, { title: "Independent project copy" }, codex)).status).toBe(201);
		expect((await req("/api/library", { libraryRoot: join(home, "library") }, undefined, "PUT")).status).toBe(200);
		expect((await req(path, { title: "Original still read-only" }, codex)).status).toBe(403);
		const original = await req(path, undefined, codex);
		expect(original.status).toBe(200);
		expect((await original.json()).map((t: { title: string }) => t.title)).toEqual(["Legacy writer kept"]);
	});
});
