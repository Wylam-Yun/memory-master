import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKILL_FILES } from "../library/agent-content.ts";
import type { HistoryEntry } from "../library/history.ts";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

/**
 * V1.1 R1 acceptance: the features overview section, P0/P1 task priorities,
 * the versioned architecture record, project meta, and the web-channel
 * resource read — exercised black-box over HTTP with assertions on disk
 * contents and the changelog, never just on API return values.
 */
describe("library V1.1: content & write capabilities", () => {
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
		home = await mkdtemp(join(tmpdir(), "mm-v11-"));
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
		expect((await req(`/api/clients/${id}/write-access`, { method: "PUT", body: { allowWrite: true } })).status).toBe(
			200,
		);
		const ping = await req("/api/agent/ping", { token });
		expect(ping.status).toBe(200);
		return token;
	};
	const architecturePath = (dir: string) => join(dir, "memaster", "architecture.md");
	const historyOf = async (projectId: string): Promise<HistoryEntry[]> =>
		await json(await req(`/api/projects/${projectId}/history`));

	test("architecture record: empty read → web create → disk + history → stale agent write conflicts", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const path = architecturePath(project.dir);

		const empty = await json(await req(`/api/projects/${project.id}/architecture`));
		expect(empty.content).toBe("");
		expect(empty.version).toMatch(/^sha256:/);
		expect(await Bun.file(path).exists()).toBe(false);

		const content = "# 项目架构\n\n```mermaid\ngraph TD;\n  用户-->服务;\n```\n";
		const put = await req(`/api/projects/${project.id}/architecture`, {
			method: "PUT",
			body: { content, baseVersion: empty.version },
		});
		expect(put.status).toBe(200);
		const written = await json(put);
		expect(written.content).toBe(content);
		expect(written.version).not.toBe(empty.version);

		// External end state: the file itself carries the submitted bytes, and
		// the changelog gained an architecture create attributed to the user.
		expect(await Bun.file(path).text()).toBe(content);
		const entries = await historyOf(project.id);
		const createdEntry = entries.find((e) => e.target.type === "architecture");
		expect(createdEntry?.action).toBe("create");
		expect(createdEntry?.actor).toEqual({ type: "user" });
		expect(createdEntry?.changes.content?.to).toBe(content);

		// The agent channel reads the same record.
		const viaAgent = await json(await req(`/api/agent/projects/${project.id}/architecture`, { token }));
		expect(viaAgent.content).toBe(content);
		expect(viaAgent.version).toBe(written.version);

		// A write on the stale (pre-create) version conflicts and carries the
		// current record — the disk keeps the winner's bytes.
		const stale = await req(`/api/agent/projects/${project.id}/architecture`, {
			method: "PUT",
			token,
			body: { content: "过期覆盖", baseVersion: empty.version },
		});
		expect(stale.status).toBe(409);
		const staleBody = await json(stale);
		expect(staleBody.code).toBe("VERSION_CONFLICT");
		expect(staleBody.current.content).toBe(content);
		expect(staleBody.current.version).toBe(written.version);
		expect(await Bun.file(path).text()).toBe(content);

		// And the agent channel writes through the same unit on a fresh version.
		const agentPut = await req(`/api/agent/projects/${project.id}/architecture`, {
			method: "PUT",
			token,
			body: { content: "# Agent 整理的架构\n", baseVersion: written.version },
		});
		expect(agentPut.status).toBe(200);
		expect(await Bun.file(path).text()).toBe("# Agent 整理的架构\n");
		const after = await historyOf(project.id);
		const update = after.filter((e) => e.target.type === "architecture").at(-1);
		expect(update?.action).toBe("update");
		expect(update?.actor).toEqual({ type: "agent", client: "codex" });
	});

	test("a failure between the architecture write and its history append rolls back to the last commit", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const path = architecturePath(project.dir);
		const empty = await json(await req(`/api/projects/${project.id}/architecture`));
		const v1 = await json(
			await req(`/api/projects/${project.id}/architecture`, {
				method: "PUT",
				body: { content: "# V1\n", baseVersion: empty.version },
			}),
		);

		// Injected failure: file is written, then the history append throws —
		// the record rolls back to its last committed bytes and history keeps
		// only the create entry.
		holds.armHistoryFailure();
		const failed = await req(`/api/projects/${project.id}/architecture`, {
			method: "PUT",
			body: { content: "# V2 不应落盘\n", baseVersion: v1.version },
		});
		expect(failed.status).toBe(500);
		expect(await Bun.file(path).text()).toBe("# V1\n");
		const entries = (await historyOf(project.id)).filter((e) => e.target.type === "architecture");
		expect(entries.length).toBe(1);
		expect(entries[0]?.action).toBe("create");

		// A failed FIRST create returns to the never-created state — no file at all.
		const other = await createProject("旅行筹备");
		const otherPath = architecturePath(other.dir);
		const otherEmpty = await json(await req(`/api/projects/${other.id}/architecture`));
		holds.armHistoryFailure();
		const failedCreate = await req(`/api/projects/${other.id}/architecture`, {
			method: "PUT",
			body: { content: "# 首建即失败\n", baseVersion: otherEmpty.version },
		});
		expect(failedCreate.status).toBe(500);
		expect(await Bun.file(otherPath).exists()).toBe(false);
		expect((await historyOf(other.id)).filter((e) => e.target.type === "architecture").length).toBe(0);
	});

	test("a disabled client loses architecture access; the other client and the web channel stay open", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");
		const empty = await json(await req(`/api/projects/${project.id}/architecture`));
		const v1 = await json(
			await req(`/api/projects/${project.id}/architecture`, {
				method: "PUT",
				body: { content: "# V1\n", baseVersion: empty.version },
			}),
		);

		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect((await req(`/api/agent/projects/${project.id}/architecture`, { token: codex })).status).toBe(403);
		expect(
			(
				await req(`/api/agent/projects/${project.id}/architecture`, {
					method: "PUT",
					token: codex,
					body: { content: "x", baseVersion: v1.version },
				})
			).status,
		).toBe(403);
		// claude-code still reads and writes; the web channel is untouched.
		expect((await req(`/api/agent/projects/${project.id}/architecture`, { token: claude })).status).toBe(200);
		const webPut = await req(`/api/projects/${project.id}/architecture`, {
			method: "PUT",
			body: { content: "# 网页仍可写\n", baseVersion: v1.version },
		});
		expect(webPut.status).toBe(200);
		const v2 = await json(webPut);

		// The same for claude-code — its own revoke closes only its channel.
		await req("/api/clients/claude-code", { method: "PUT", body: { enabled: false } });
		expect((await req(`/api/agent/projects/${project.id}/architecture`, { token: claude })).status).toBe(403);
		expect(
			(
				await req(`/api/agent/projects/${project.id}/architecture`, {
					method: "PUT",
					token: claude,
					body: { content: "x", baseVersion: v2.version },
				})
			).status,
		).toBe(403);
		expect((await req(`/api/projects/${project.id}/architecture`)).status).toBe(200);
	});

	test("an architecture write parked before commit cannot land after revoke or stop", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const codex = await enableClient("codex");
		const claude = await enableClient("claude-code");
		const path = architecturePath(project.dir);
		const empty = await json(await req(`/api/projects/${project.id}/architecture`));
		const v1 = await json(
			await req(`/api/projects/${project.id}/architecture`, {
				method: "PUT",
				body: { content: "# V1\n", baseVersion: empty.version },
			}),
		);

		// Park the agent write inside the file lock, revoke, release: the in-lock
		// re-check must reject it and the record keeps the committed bytes.
		const hold = await json(await req("/api/test/holds", { method: "POST", body: { name: "arch" } }));
		const writePromise = req(`/api/agent/projects/${project.id}/architecture`, {
			method: "PUT",
			token: codex,
			body: { content: "# 撤销后的写入\n", baseVersion: v1.version },
		});
		await holds.waitForWaiter();
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		await req(`/api/test/holds/${hold.id}`, { method: "DELETE" });
		const writeRes = await writePromise;
		expect(writeRes.status).toBe(403);
		expect(await Bun.file(path).text()).toBe("# V1\n");

		// The same parked write is cancelled when the service stops.
		const hold2 = await json(await req("/api/test/holds", { method: "POST", body: { name: "arch-stop" } }));
		const stoppedWrite = req(`/api/agent/projects/${project.id}/architecture`, {
			method: "PUT",
			token: claude,
			body: { content: "# 停服时的写入\n", baseVersion: v1.version },
		})
			.then((r) => ({ status: r.status }) as { status: number | "failed" })
			.catch(() => ({ status: "failed" as const }));
		await holds.waitForWaiter();
		// stop() sets `stopping` synchronously then drains in-flight requests —
		// release the hold so the parked write resumes and hits the stopping check.
		const stopPromise = service.stop();
		holds.release(hold2.id);
		const result = await stoppedWrite;
		await stopPromise;
		// Either the handler answered 503 or the connection died mid-stop: both mean "not written".
		expect(result.status === 503 || result.status === "failed").toBe(true);
		expect(await Bun.file(path).text()).toBe("# V1\n");
	});

	test("two projects keep separate architecture records; tasks work without one", async () => {
		await setupLibrary();
		const a = await createProject("读书计划");
		const b = await createProject("周末活动");
		const empty = await json(await req(`/api/projects/${a.id}/architecture`));
		await req(`/api/projects/${a.id}/architecture`, {
			method: "PUT",
			body: { content: "# A 的架构\n", baseVersion: empty.version },
		});

		const bRead = await json(await req(`/api/projects/${b.id}/architecture`));
		expect(bRead.content).toBe("");
		expect(await Bun.file(architecturePath(b.dir)).exists()).toBe(false);
		expect(await Bun.file(architecturePath(a.dir)).text()).toBe("# A 的架构\n");

		// A project with no architecture record still manages tasks normally.
		const task = await req(`/api/projects/${b.id}/tasks`, { method: "POST", body: { title: "报名统计" } });
		expect(task.status).toBe(201);
		const bTasks = await json(await req(`/api/projects/${b.id}/tasks`));
		expect(bTasks.map((t: { title: string }) => t.title)).toEqual(["报名统计"]);
	});

	test("the features overview section round-trips through web PUT, disk, and the MCP tool", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const path = join(project.dir, "memaster", "overview.md");

		const before = await json(await req(`/api/projects/${project.id}/overview`));
		const put = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { features: "功能A：用法甲\n功能B：用法乙", baseVersion: before.version },
		});
		expect(put.status).toBe(200);
		const disk = await Bun.file(path).text();
		expect(disk).toContain("<!-- SECTION:FEATURES:BEGIN -->");
		expect(disk).toContain("功能A：用法甲");
		expect((await json(await req(`/api/projects/${project.id}/overview`))).features).toBe(
			"功能A：用法甲\n功能B：用法乙",
		);

		// The same field through the MCP tool — end to end onto the same file.
		const bridge = new LibraryBridge({ serviceUrl: base, token });
		await bridge.callTool("project_open", { name: "订单系统" });
		const read = JSON.parse(
			(await bridge.callTool("overview_read", { project_id: project.id })).content[0]?.text ?? "{}",
		);
		const wrote = await bridge.callTool("overview_write", {
			project_id: project.id,
			features: "MCP 写入的功能",
			base_version: read.version,
		});
		expect(wrote.isError).toBeUndefined();
		expect(await Bun.file(path).text()).toContain("MCP 写入的功能");
		expect((await json(await req(`/api/projects/${project.id}/overview`))).features).toBe("MCP 写入的功能");
	});

	test("a data-enveloped write lands, unknown args fail loudly, and field-less PUTs return 400", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const path = join(project.dir, "memaster", "overview.md");

		// The exact shape a real agent once produced — payload nested in `data`
		// as a JSON string. It must write, not silently no-op.
		const bridge = new LibraryBridge({ serviceUrl: base, token });
		await bridge.callTool("project_open", { name: "订单系统" });
		const read = JSON.parse(
			(await bridge.callTool("overview_read", { project_id: project.id })).content[0]?.text ?? "{}",
		);
		const wrote = await bridge.callTool("overview_write", {
			project_id: project.id,
			base_version: read.version,
			data: JSON.stringify({ current: "信封里的进展" }),
		});
		expect(wrote.isError).toBeUndefined();
		expect(await Bun.file(path).text()).toContain("信封里的进展");
		const written = JSON.parse(
			(await bridge.callTool("overview_read", { project_id: project.id })).content[0]?.text ?? "{}",
		);
		expect(written.current).toBe("信封里的进展");
		expect(written.version).not.toBe(read.version);

		// `data` as an object works too; top-level fields win over the envelope.
		const again = await bridge.callTool("overview_write", {
			project_id: project.id,
			base_version: written.version,
			current: "顶层优先",
			data: { current: "信封里" },
		});
		expect(again.isError).toBeUndefined();
		expect(await Bun.file(path).text()).toContain("顶层优先");

		// An argument the tool doesn't know must error, never drop silently.
		const bogus = await bridge.callTool("overview_write", {
			project_id: project.id,
			base_version: written.version,
			goal_new: "编造的字段",
		});
		expect(bogus.isError).toBe(true);
		expect(bogus.content[0]?.text).toContain("Unknown argument");

		// Service-level backstop: a PUT with no writable field is a 400, not a
		// fake success — on both web and agent routes.
		expect(
			(
				await req(`/api/projects/${project.id}/overview`, {
					method: "PUT",
					body: { baseVersion: written.version },
				})
			).status,
		).toBe(400);
		expect(
			(
				await req(`/api/agent/projects/${project.id}/overview`, {
					method: "PUT",
					token,
					body: { baseVersion: written.version },
				})
			).status,
		).toBe(400);
		const created = await json(
			await req(`/api/projects/${project.id}/tasks`, { method: "POST", body: { title: "t" } }),
		);
		expect(
			(
				await req(`/api/agent/projects/${project.id}/tasks/${created.id}`, {
					method: "PUT",
					token,
					body: { baseVersion: created.version },
				})
			).status,
		).toBe(400);
	});

	test("agents publish 资料 files through resource_write — disk, history, and revocation are all real", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const targetPath = join(project.dir, "资料", "meeting-notes.md");

		const bridge = new LibraryBridge({ serviceUrl: base, token });
		await bridge.callTool("project_open", { name: "订单系统" });
		const wrote = await bridge.callTool("resource_write", {
			project_id: project.id,
			name: "meeting-notes.md",
			content: "# 会议纪要\n\n第一条结论",
		});
		expect(wrote.isError).toBeUndefined();

		// External end state: the file exists in 资料/ and the web read route
		// serves it back byte-identical.
		expect(await Bun.file(targetPath).text()).toContain("会议纪要");
		const webRead = await json(await req(`/api/projects/${project.id}/resources/meeting-notes.md`));
		expect(webRead.text).toContain("第一条结论");

		// The changelog attributes the upload to the agent, not the user.
		const entries = await historyOf(project.id);
		const resourceEntry = entries.find((e) => e.target.type === "resource" && e.target.id === "meeting-notes.md");
		expect(resourceEntry?.actor).toEqual({ type: "agent", client: "codex" });

		// A revoked client loses the write path and the file stays untouched.
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		const denied = await req(`/api/agent/projects/${project.id}/resources`, {
			method: "POST",
			token,
			body: { name: "evil.md", base64: Buffer.from("x").toString("base64") },
		});
		expect(denied.status).toBe(403);
		expect(await Bun.file(join(project.dir, "资料", "evil.md")).exists()).toBe(false);
	});

	test("a pre-features overview file reads empty and stays unexpanded on unrelated updates", async () => {
		await setupLibrary();
		const project = await createProject("旧项目");
		const path = join(project.dir, "memaster", "overview.md");
		// Hand-craft a legacy three-section file — no FEATURES markers anywhere.
		const legacy = [
			"---",
			'title: "旧项目"',
			"---",
			"",
			"## 项目简介",
			"",
			"<!-- SECTION:DESCRIPTION:BEGIN -->",
			"旧的简介",
			"<!-- SECTION:DESCRIPTION:END -->",
			"",
			"## 目标",
			"",
			"<!-- SECTION:GOAL:BEGIN -->",
			"旧的目标",
			"<!-- SECTION:GOAL:END -->",
			"",
			"## 当前进展",
			"",
			"<!-- SECTION:CURRENT:BEGIN -->",
			"旧的进展",
			"<!-- SECTION:CURRENT:END -->",
			"",
		].join("\n");
		await Bun.write(path, legacy);

		const read = await json(await req(`/api/projects/${project.id}/overview`));
		expect(read.description).toBe("旧的简介");
		expect(read.goal).toBe("旧的目标");
		expect(read.current).toBe("旧的进展");
		expect(read.features).toBe("");

		// An update that never mentions features leaves the section off the disk
		// entirely — applyOverviewUpdate only materializes updated fields.
		const put = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { description: "新简介", baseVersion: read.version },
		});
		expect(put.status).toBe(200);
		const disk = await Bun.file(path).text();
		expect(disk).toContain("新简介");
		expect(disk).toContain("旧的目标");
		expect(disk).toContain("旧的进展");
		expect(disk).not.toContain("SECTION:FEATURES");
		expect((await json(await req(`/api/projects/${project.id}/overview`))).features).toBe("");
	});

	test("task priority defaults to p0, validates, updates, and is recorded in history", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");
		const tasksDir = join(project.dir, "memaster", "tasks");
		const fileFor = async (id: string) => {
			const name = (await readdir(tasksDir)).find((f) => f.startsWith(`${id.toLowerCase()} -`));
			if (!name) throw new Error(`No task file found for ${id}`);
			return name;
		};

		const created = await json(
			await req(`/api/projects/${project.id}/tasks`, { method: "POST", body: { title: "默认任务" } }),
		);
		expect(created.priority).toBe("p0");
		expect(await Bun.file(join(tasksDir, await fileFor(created.id))).text()).toContain("priority: p0");

		const p1 = await json(
			await req(`/api/projects/${project.id}/tasks`, {
				method: "POST",
				body: { title: "后排任务", priority: "P1" },
			}),
		);
		expect(p1.priority).toBe("p1");
		expect(await Bun.file(join(tasksDir, await fileFor(p1.id))).text()).toContain("priority: p1");

		expect(
			(
				await req(`/api/projects/${project.id}/tasks`, {
					method: "POST",
					body: { title: "非法优先级", priority: "urgent" },
				})
			).status,
		).toBe(400);

		// Update p0 → p1 lands on disk and records the field diff in history.
		const read = await json(await req(`/api/projects/${project.id}/tasks/${created.id}`));
		const upd = await req(`/api/projects/${project.id}/tasks/${created.id}`, {
			method: "PUT",
			body: { priority: "P1", baseVersion: read.version },
		});
		expect(upd.status).toBe(200);
		expect((await json(upd)).priority).toBe("p1");
		expect(await Bun.file(join(tasksDir, await fileFor(created.id))).text()).toContain("priority: p1");
		const entries = await historyOf(project.id);
		const updEntry = entries.find((e) => e.target.id === created.id && e.action === "update");
		expect(updEntry?.changes.priority).toEqual({ from: "p0", to: "p1" });

		// A priority write on a stale version is still a conflict, never a merge.
		const stale = await req(`/api/projects/${project.id}/tasks/${created.id}`, {
			method: "PUT",
			body: { priority: "P0", baseVersion: read.version },
		});
		expect(stale.status).toBe(409);
		expect((await json(stale)).code).toBe("VERSION_CONFLICT");

		// MCP task_create carries priority end to end.
		const bridge = new LibraryBridge({ serviceUrl: base, token });
		await bridge.callTool("project_open", { name: "订单系统" });
		const mcp = await bridge.callTool("task_create", { project_id: project.id, title: "MCP 后排任务", priority: "P1" });
		expect(mcp.isError).toBeUndefined();
		const mcpTask = JSON.parse(mcp.content[0]?.text ?? "{}");
		expect(mcpTask.priority).toBe("p1");
		expect(await Bun.file(join(tasksDir, await fileFor(mcpTask.id))).text()).toContain("priority: p1");
	});

	test("a legacy project without a priorities key is lazily migrated on first priority write", async () => {
		await setupLibrary();
		const project = await createProject("老项目");
		const configPath = join(project.dir, "memaster", "config.yml");
		const original = await Bun.file(configPath).text();
		expect(original).toContain("priorities:");
		// Strip the priorities key entirely — the pre-V1.1 shape.
		await Bun.write(
			configPath,
			original
				.split("\n")
				.filter((line) => !line.startsWith("priorities:"))
				.join("\n"),
		);
		expect(await Bun.file(configPath).text()).not.toContain("priorities:");

		const created = await req(`/api/projects/${project.id}/tasks`, {
			method: "POST",
			body: { title: "老项目新任务", priority: "P0" },
		});
		expect(created.status).toBe(201);
		expect((await json(created)).priority).toBe("p0");
		// The lazy migration wrote the vocabulary back into config.yml.
		expect(await Bun.file(configPath).text()).toContain('priorities: ["P0", "P1"]');

		const read = await json(await req(`/api/projects/${project.id}/tasks/TASK-1`));
		const upd = await req(`/api/projects/${project.id}/tasks/TASK-1`, {
			method: "PUT",
			body: { priority: "P1", baseVersion: read.version },
		});
		expect(upd.status).toBe(200);
		expect((await json(upd)).priority).toBe("p1");

		// A task file carrying a legacy priority value reads back untouched —
		// reading never rewrites the record.
		const legacyPath = join(project.dir, "memaster", "tasks", "task-9 - 旧高优任务.md");
		await Bun.write(
			legacyPath,
			[
				"---",
				"id: TASK-9",
				"title: 旧高优任务",
				"status: To Do",
				"priority: high",
				"assignee: []",
				"created_date: '2024-01-01T00:00:00Z'",
				"labels: []",
				"dependencies: []",
				"---",
				"",
			].join("\n"),
		);
		const legacyTask = await json(await req(`/api/projects/${project.id}/tasks/TASK-9`));
		expect(legacyTask.priority).toBe("high");
		expect(await Bun.file(legacyPath).text()).toContain("priority: high");
	});

	test("GET /api/projects/:id returns the project meta used by the web UI", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const meta = await json(await req(`/api/projects/${project.id}`));
		expect(meta.id).toBe(project.id);
		expect(meta.name).toBe("订单系统");
		expect(meta.statuses).toEqual(["To Do", "In Progress", "Done"]);
		expect(meta.doneStatus).toBe("Done");
		expect(meta.p0).toBe("p0");
		expect(meta.p1).toBe("p1");
	});

	test("the web channel reads a single resource under its own authorization", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const token = await enableClient("codex");

		await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "spec.md", base64: Buffer.from("# 说明\n内容与原件一致", "utf8").toString("base64") },
		});
		const binBytes = Buffer.from([0, 159, 146, 150]);
		await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "data.bin", base64: binBytes.toString("base64") },
		});

		const text = await json(await req(`/api/projects/${project.id}/resources/spec.md`));
		expect(text.name).toBe("spec.md");
		expect(text.text).toContain("内容与原件一致");
		const bin = await json(await req(`/api/projects/${project.id}/resources/data.bin`));
		expect(bin.base64).toBe(binBytes.toString("base64"));
		expect(bin.text).toBeUndefined();
		expect((await req(`/api/projects/${project.id}/resources/missing.txt`)).status).toBe(404);

		// Web routes carry no credential check — an agent token sent here is ignored.
		expect((await req(`/api/projects/${project.id}/resources/spec.md`, { token })).status).toBe(200);
		// Revoking the agent closes its route but not the web's.
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect((await req(`/api/agent/projects/${project.id}/resources/spec.md`, { token })).status).toBe(403);
		const webRead = await req(`/api/projects/${project.id}/resources/spec.md`);
		expect(webRead.status).toBe(200);
		expect((await json(webRead)).text).toContain("内容与原件一致");
	});

	test("a planted symlink inside 资料/ is never followed by the read route", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const { symlink, writeFile } = await import("node:fs/promises");
		const outside = join(home, "secret-outside.txt");
		await writeFile(outside, "库外机密");
		const resources = join(project.dir, "资料");
		await symlink(outside, join(resources, "link.md"));
		// File-level link: reads refuse it — 404, not the outside bytes.
		expect((await req(`/api/projects/${project.id}/resources/link.md`)).status).toBe(404);
		const real = join(resources, "real.md");
		await writeFile(real, "库内内容");
		const ok = await req(`/api/projects/${project.id}/resources/real.md`);
		expect(ok.status).toBe(200);
		expect((await json(ok)).text).toContain("库内内容");
	});

	test("a failed history append rolls task updates back to the committed bytes", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const created = await json(
			await req(`/api/projects/${project.id}/tasks`, { method: "POST", body: { title: "写周报" } }),
		);
		const beforeBytes = await Bun.file(created.filePath).bytes();

		holds.armHistoryFailure();
		const failed = await req(`/api/projects/${project.id}/tasks/${created.id}`, {
			method: "PUT",
			body: { status: "Done", baseVersion: created.version },
		});
		expect(failed.status).toBe(500);
		expect(await Bun.file(created.filePath).bytes()).toEqual(beforeBytes);
		// History keeps only the create entry — state and record stay in lockstep.
		const taskEntries = (await historyOf(project.id)).filter((e) => e.target.type === "task");
		expect(taskEntries.length).toBe(1);
		expect(taskEntries[0]?.action).toBe("create");
		const reread = await json(await req(`/api/projects/${project.id}/tasks/${created.id}`));
		expect(reread.status).toBe("To Do");
	});

	test("a failed history append rolls overview writes back to the committed bytes", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const overviewPath = join(project.dir, "memaster", "overview.md");
		const beforeBytes = await Bun.file(overviewPath).bytes();
		const current = await json(await req(`/api/projects/${project.id}/overview`));

		holds.armHistoryFailure();
		const failed = await req(`/api/projects/${project.id}/overview`, {
			method: "PUT",
			body: { features: "不应落盘的功能", baseVersion: current.version },
		});
		expect(failed.status).toBe(500);
		expect(await Bun.file(overviewPath).bytes()).toEqual(beforeBytes);
		expect((await historyOf(project.id)).filter((e) => e.target.type === "overview").length).toBe(0);
		const reread = await json(await req(`/api/projects/${project.id}/overview`));
		expect(reread.features).not.toContain("不应落盘");
		expect(reread.version).toBe(current.version);
	});

	test("a failed history append restores the previous bytes of a same-name upload", async () => {
		await setupLibrary();
		const project = await createProject("订单系统");
		const upload = (name: string, text: string) =>
			req(`/api/projects/${project.id}/resources`, {
				method: "POST",
				body: { name, base64: Buffer.from(text, "utf8").toString("base64") },
			});
		expect((await upload("spec.md", "第一版")).status).toBe(201);

		holds.armHistoryFailure();
		const failed = await upload("spec.md", "第二版");
		expect(failed.status).toBe(500);
		// The earlier version is restored — a replace upload is not a delete.
		expect(await Bun.file(join(project.dir, "资料", "spec.md")).text()).toBe("第一版");
		expect((await historyOf(project.id)).filter((e) => e.target.type === "resource").length).toBe(1);
	});
});

/**
 * V1.1 R3 acceptance: the installed skill bundle is a closed reference set
 * (every relative .md link resolves to a file that ships next to it) and the
 * bridge tool surface matches the five-page UI. Pure content/schema
 * assertions — no service needed.
 */
describe("library V1.1 R3: skill bundle closure & tool surface", () => {
	test("every relative .md link inside SKILL_FILES resolves to a file that ships", () => {
		const names = new Set(Object.keys(SKILL_FILES));
		expect(names.size).toBe(6);
		// Scan EVERY file, not just SKILL.md — a link added later inside a
		// referenced doc (e.g. ARCHITECTURE-SKILL → UPSTREAM.md) must not ship
		// as a dead pointer in the client skills directory.
		const links: Array<{ from: string; target: string }> = [];
		for (const [from, content] of Object.entries(SKILL_FILES)) {
			for (const match of content.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = (match[1] ?? "").split("#")[0] ?? "";
				if (!target || /^https?:\/\//.test(target) || !target.endsWith(".md")) continue;
				links.push({ from, target });
			}
		}
		// A link-free bundle would make this assertion vacuous.
		expect(links.length).toBeGreaterThan(0);
		const missing = links.filter(({ target }) => !names.has(target)).map(({ from, target }) => `${from} -> ${target}`);
		expect(missing).toEqual([]);
	});

	test("the bridge exposes architecture tools and features, and question_ask drops the web promise", () => {
		const bridge = new LibraryBridge({ serviceUrl: "http://127.0.0.1:1", token: "mm_test" });
		const byName = new Map(bridge.listTools().map((tool) => [tool.name, tool]));
		expect(byName.has("architecture_read")).toBe(true);
		expect(byName.has("architecture_write")).toBe(true);
		expect(byName.get("overview_write")?.inputSchema.properties).toHaveProperty("features");
		// The five-page UI has no questions page — the tool stays for API
		// compatibility but its description must no longer promise web
		// visibility; it should point at the current conversation instead.
		const questionAsk = byName.get("question_ask");
		expect(questionAsk?.description ?? "").toContain("current conversation");
		expect(questionAsk?.description ?? "").not.toMatch(/网页|web page|shown on the web/i);
	});
});
