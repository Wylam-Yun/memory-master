import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";

/**
 * Phase 3+4 acceptance: pending questions across web/agent channels, uploaded
 * resources with path guards, and the one-click client setup with its
 * none → configured → connected connection gate. Exercised black-box over HTTP
 * with assertions on the real client config files (in a temp client home).
 */
describe("phase 3+4: questions, resources, client setup", () => {
	let home: string;
	let clientHome: string;
	let library: string;
	let service: LibraryService;
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

	// The whole bundle the installer must land — asserted by name rather than
	// imported from SKILL_FILES so a dropped file can't pass silently.
	const EXPECTED_SKILL_FILES = [
		"SKILL.md",
		"CONTENT-STANDARD.md",
		"ARCHITECTURE-FORMAT.md",
		"ARCHITECTURE-SKILL.md",
		"UPSTREAM.md",
		"UPSTREAM-LICENSE.md",
	];

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mm-p34-"));
		library = join(home, "library");
		clientHome = join(home, "client-home");
		process.env.MEMORY_MASTER_CLIENT_HOME = clientHome;
		service = new LibraryService({ settings: new AppSettingsStore(home), holds: new TestHolds(true) });
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
	const connectClient = async (id: "codex" | "claude-code"): Promise<string> => {
		const res = await req(`/api/clients/${id}`, { method: "PUT", body: { enabled: true } });
		expect(res.status).toBe(200);
		const token = (await json(res)).token;
		expect((await req("/api/agent/ping", { token })).status).toBe(200);
		return token;
	};

	test("enabling a client installs config + instructions + skill, and ping flips it connected", async () => {
		// Pre-seed real-world leftovers the installer must preserve.
		await Bun.write(
			join(clientHome, ".claude.json"),
			JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }),
		);
		await Bun.write(join(clientHome, ".codex", "config.toml"), 'model = "gpt-5"\n');
		await Bun.write(join(clientHome, ".claude", "CLAUDE.md"), "# 我自己的规则\n别动这段。\n");

		const res = await req("/api/clients/claude-code", { method: "PUT", body: { enabled: true } });
		expect(res.status).toBe(200);
		const slot = await json(res);
		expect(slot.connection).toBe("configured");
		expect(slot.token).toMatch(/^mm_claude_/);
		// config + instructions + the six skill-bundle files.
		expect(slot.installed.length).toBe(8);

		// External end state: ~/.claude.json merged, user keys intact.
		const claudeJson = JSON.parse(await readFile(join(clientHome, ".claude.json"), "utf8"));
		expect(claudeJson.theme).toBe("dark");
		expect(claudeJson.mcpServers.other.command).toBe("x");
		expect(claudeJson.mcpServers["memory-master"].env.MEMORY_MASTER_TOKEN).toBe(slot.token);
		expect(claudeJson.mcpServers["memory-master"].env.MEMORY_MASTER_URL).toBe(base);
		expect(claudeJson.mcpServers["memory-master"].args[0]).toEndWith("cli.ts");
		// Instructions preserved outside the managed block.
		const claudeMd = await readFile(join(clientHome, ".claude", "CLAUDE.md"), "utf8");
		expect(claudeMd).toContain("# 我自己的规则");
		expect(claudeMd).toContain("<!-- memory-master:begin -->");
		// The V1.1 block: read-first writes with base_version, questions asked
		// in the conversation — question_ask is no longer promoted.
		expect(claudeMd).toContain("project_open");
		expect(claudeMd).toContain("project_search");
		expect(claudeMd).toContain("project_create");
		expect(claudeMd).toContain("读取当前进展、目标和相关任务");
		expect(claudeMd).toContain("base_version");
		expect(claudeMd).not.toContain("question_ask");
		// The whole skill bundle lands, not just SKILL.md.
		const skillDir = join(clientHome, ".claude", "skills", "memory-master");
		for (const name of EXPECTED_SKILL_FILES) {
			expect(await Bun.file(join(skillDir, name)).exists()).toBe(true);
		}
		const installedSkill = await readFile(join(skillDir, "SKILL.md"), "utf8");
		const installedStandard = await readFile(join(skillDir, "CONTENT-STANDARD.md"), "utf8");
		expect(installedSkill).toContain("history_list");
		expect(installedSkill).toContain("criticalPaths");
		expect(installedStandard).toContain("服务器名称和服务器内路径");
		expect(installedStandard).toContain("可复现的操作");

		// Configured but NOT yet connected: project routes stay closed.
		const gated = await req("/api/agent/projects", { token: slot.token });
		expect(gated.status).toBe(403);
		expect((await json(gated)).code).toBe("CONNECTION_PENDING");

		// The bridge ping (real-client proof) flips the slot and opens access.
		expect((await req("/api/agent/ping", { token: slot.token })).status).toBe(200);
		const after = await json(await req("/api/clients"));
		expect(after.find((c: { id: string }) => c.id === "claude-code").connection).toBe("connected");
		expect(after.find((c: { id: string }) => c.id === "claude-code").lastSeenAt).not.toBeNull();
		expect((await req("/api/agent/projects", { token: slot.token })).status).toBe(200);

		// The instructions endpoint serves the same bundle manifest agents
		// can reconcile against the files on disk.
		const agentContent = await json(await req("/api/agent/instructions", { token: slot.token }));
		expect(agentContent.instructions).toContain("<!-- memory-master:begin -->");
		expect(agentContent.skill).toContain("name: memory-master");
		expect(agentContent.skillFiles).toEqual(EXPECTED_SKILL_FILES);
	});

	test("codex installs a marker-guarded TOML block; re-enable never duplicates", async () => {
		await Bun.write(
			join(clientHome, ".codex", "config.toml"),
			'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n',
		);
		await Bun.write(join(clientHome, ".codex", "AGENTS.md"), "# 用户自己的 AGENTS\n");

		const token = await connectClient("codex");
		const toml = await readFile(join(clientHome, ".codex", "config.toml"), "utf8");
		expect(toml).toContain('model = "gpt-5"');
		expect(toml).toContain("[mcp_servers.other]");
		expect(toml).toContain("[mcp_servers.memory-master]");
		expect(toml).toContain(`MEMORY_MASTER_TOKEN = "${token}"`);
		expect((toml.match(/>>> memory-master >>>/g) ?? []).length).toBe(1);
		const agentsMd = await readFile(join(clientHome, ".codex", "AGENTS.md"), "utf8");
		expect(agentsMd).toContain("# 用户自己的 AGENTS");
		expect(agentsMd).toContain("<!-- memory-master:begin -->");
		// Codex discovers skills as ~/.agents/skills/<name>/SKILL.md — the flat
		// .codex/skills/x.md form is never read. The whole bundle lands there.
		for (const name of EXPECTED_SKILL_FILES) {
			expect(await Bun.file(join(clientHome, ".agents", "skills", "memory-master", name)).exists()).toBe(true);
		}
		const installedStandard = await readFile(
			join(clientHome, ".agents", "skills", "memory-master", "CONTENT-STANDARD.md"),
			"utf8",
		);
		expect(installedStandard).toContain("服务器名称和服务器内路径");
		expect(installedStandard).toContain("可复现的操作");

		// Disable → re-enable: managed blocks get replaced, never appended twice.
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		const again = await req("/api/clients/codex", { method: "PUT", body: { enabled: true } });
		expect(again.status).toBe(200);
		const toml2 = await readFile(join(clientHome, ".codex", "config.toml"), "utf8");
		expect((toml2.match(/\[mcp_servers\.memory-master\]/g) ?? []).length).toBe(1);
		expect((toml2.match(/>>> memory-master >>>/g) ?? []).length).toBe(1);
		const agentsMd2 = await readFile(join(clientHome, ".codex", "AGENTS.md"), "utf8");
		expect((agentsMd2.match(/<!-- memory-master:begin -->/g) ?? []).length).toBe(1);
	});

	test("a same-name MCP table or corrupted managed block is refused, never duplicated", async () => {
		// Pre-existing hand-written [mcp_servers.memory-master] — appending ours
		// would duplicate the table and corrupt the WHOLE Codex config.
		const tomlPath = join(clientHome, ".codex", "config.toml");
		await Bun.write(tomlPath, 'model = "gpt-5"\n\n[mcp_servers.memory-master]\ncommand = "old"\n');
		const refused = await req("/api/clients/codex", { method: "PUT", body: { enabled: true } });
		expect(refused.status).toBe(502);
		expect((await json(refused)).installError).toContain("mcp_servers.memory-master");
		// The file is untouched — still the user's original content.
		expect(await readFile(tomlPath, "utf8")).toContain('command = "old"');
		expect(await readFile(tomlPath, "utf8")).not.toContain(">>>");

		// A BEGIN marker without END is a corrupted managed block — refuse too.
		await Bun.write(
			tomlPath,
			'model = "gpt-5"\n\n# >>> memory-master >>>\n[mcp_servers.memory-master]\ncommand = "x"\n',
		);
		const corrupt = await req("/api/clients/codex", { method: "PUT", body: { enabled: true } });
		expect(corrupt.status).toBe(502);
		expect((await json(corrupt)).installError).toContain("memory-master <<<");

		// After the user cleans up, enable converges and the result parses as TOML.
		await Bun.write(tomlPath, 'model = "gpt-5"\n');
		expect((await req("/api/clients/codex", { method: "PUT", body: { enabled: true } })).status).toBe(200);
		Bun.TOML.parse(await readFile(tomlPath, "utf8"));
	});

	test("question create parked before commit cannot land after revoke", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("codex");
		const holds = service.holds;

		const hold = await json(await req("/api/test/holds", { method: "POST", body: { name: "q" } }));
		const createPromise = req(`/api/agent/projects/${project.id}/questions`, {
			method: "POST",
			token,
			body: { title: "会被撤销的提问" },
		});
		await holds.waitForWaiter();
		expect((await req("/api/clients/codex", { method: "PUT", body: { enabled: false } })).status).toBe(200);
		await req(`/api/test/holds/${hold.id}`, { method: "DELETE" });

		const res = await createPromise;
		expect(res.status).toBe(403);
		// Vetoed create leaves NOTHING on disk and nothing in history.
		const files = await readdir(join(project.dir, "memaster", "questions")).catch(() => []);
		expect(files.length).toBe(0);
		const history = await json(await req(`/api/projects/${project.id}/history`));
		expect(history.filter((e: { target: { type: string } }) => e.target.type === "question").length).toBe(0);
	});

	test("upload lands a history entry; corrupt base64 is rejected before decode", async () => {
		const project = await createProject("订单系统");
		const bad = await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "x.txt", base64: "!!!not-base64!!!" },
		});
		expect(bad.status).toBe(400);
		expect((await readdir(join(project.dir, "资料"))).length).toBe(0);

		await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "spec.md", base64: Buffer.from("hi").toString("base64") },
		});
		const history = await json(await req(`/api/projects/${project.id}/history`));
		const upload = history.find((e: { target: { type: string } }) => e.target.type === "resource");
		expect(upload).toBeTruthy();
		expect(upload.target.id).toBe("spec.md");
		expect(upload.actor).toEqual({ type: "user" });
	});

	test("a disable landing mid-install is not undone by the late completion", async () => {
		// ensureToken bumps the generation; the disable bumps it again — the
		// install's markConfigured with the stale generation must no-op.
		const settings = service.settings;
		const { token, generation } = await settings.ensureToken("codex");
		expect(token).toMatch(/^mm_codex_/);
		await settings.setClientEnabled("codex", false);
		const slot = await settings.markConfigured("codex", generation);
		expect(slot.enabled).toBe(false);
	});

	test("titles with backslashes and quotes round-trip through frontmatter", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("codex");
		const res = await req(`/api/agent/projects/${project.id}/questions`, {
			method: "POST",
			token,
			body: { title: '缓存放 C:\\cache 还是 "默认" 目录？' },
		});
		expect(res.status).toBe(201);
		const list = await json(await req(`/api/projects/${project.id}/questions`));
		expect(list.length).toBe(1);
		expect(list[0].title).toBe('缓存放 C:\\cache 还是 "默认" 目录？');
	});

	test("one client's failed setup is reported and never damages the other", async () => {
		// Make the codex config path a *file* so mkdir inside it fails.
		await Bun.write(join(clientHome, ".codex"), "not a directory");
		const bad = await req("/api/clients/codex", { method: "PUT", body: { enabled: true } });
		expect(bad.status).toBe(502);
		expect((await json(bad)).installError).toContain(".codex");

		const clients = await json(await req("/api/clients"));
		const codex = clients.find((c: { id: string }) => c.id === "codex");
		expect(codex.enabled).toBe(false);
		expect(codex.installError).toBeTruthy();
		expect(clients.find((c: { id: string }) => c.id === "claude-code").connection).toBe("none");

		// Claude unaffected — and fixing the path makes codex's retry converge.
		await connectClient("claude-code");
		await rm(join(clientHome, ".codex"));
		const retry = await req("/api/clients/codex", { method: "PUT", body: { enabled: true } });
		expect(retry.status).toBe(200);
		expect((await json(retry)).installError).toBeNull();
	});

	test("a question asked by an agent shows on the web; the web answer reaches the agent", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("codex");

		const asked = await req(`/api/agent/projects/${project.id}/questions`, {
			method: "POST",
			token,
			body: { title: "退款走原路还是余额？", detail: "建议原路，对账简单。", task: "TASK-1" },
		});
		expect(asked.status).toBe(201);
		const question = await json(asked);
		expect(question.id).toBe("QUESTION-1");
		expect(question.status).toBe("Open");
		expect(question.askedBy).toBe("codex");

		// Web sees the same pending question; the human answers it there.
		const webList = await json(await req(`/api/projects/${project.id}/questions`));
		expect(webList.map((q: { id: string }) => q.id)).toEqual(["QUESTION-1"]);
		const answered = await req(`/api/projects/${project.id}/questions/${question.id}`, {
			method: "PUT",
			body: { answer: "走原路退回" },
		});
		expect(answered.status).toBe(200);
		expect((await json(answered)).answeredBy).toBe("user");

		// A later agent session reads the answer; a second answer conflicts.
		const viaAgent = await json(await req(`/api/agent/projects/${project.id}/questions/${question.id}`, { token }));
		expect(viaAgent.status).toBe("Answered");
		expect(viaAgent.answer).toBe("走原路退回");
		const second = await req(`/api/agent/projects/${project.id}/questions/${question.id}`, {
			method: "PUT",
			token,
			body: { answer: "改余额" },
		});
		expect(second.status).toBe(409);

		// On disk: a real markdown record in memaster/questions/.
		const files = await readdir(join(project.dir, "memaster", "questions"));
		expect(files.length).toBe(1);
		expect(files[0]).toContain("question-1");
		const content = await Bun.file(join(project.dir, "memaster", "questions", files[0] ?? "")).text();
		expect(content).toContain("走原路退回");

		// History attributes both sides.
		const history = await json(await req(`/api/projects/${project.id}/history`));
		const qEntries = history.filter((e: { target: { type: string } }) => e.target.type === "question");
		expect(qEntries.map((e: { actor: { type: string } }) => e.actor.type)).toEqual(["agent", "user"]);
	});

	test("an answer given in dialog is recorded by the agent and shows answered on the web", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("claude-code");
		await req(`/api/agent/projects/${project.id}/questions`, {
			method: "POST",
			token,
			body: { title: "上线时间定哪天？" },
		});
		const put = await req(`/api/agent/projects/${project.id}/questions/QUESTION-1`, {
			method: "PUT",
			token,
			body: { answer: "下周五" },
		});
		expect(put.status).toBe(200);
		const webView = await json(await req(`/api/projects/${project.id}/questions/QUESTION-1`));
		expect(webView.status).toBe("Answered");
		expect(webView.answer).toBe("下周五");
		expect(webView.answeredBy).toBe("claude-code");
	});

	test("resources upload on the web, then list and read through the agent path", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("codex");

		const base64 = Buffer.from("# 退款政策\n三十天内可退。", "utf8").toString("base64");
		const up = await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "退款政策.md", base64 },
		});
		expect(up.status).toBe(201);

		// External end state: file exists under the project's 资料/ dir.
		const onDisk = await Bun.file(join(project.dir, "资料", "退款政策.md")).text();
		expect(onDisk).toContain("三十天内可退");

		// Agent manifest + read.
		const list = await json(await req(`/api/agent/projects/${project.id}/resources`, { token }));
		expect(list.map((r: { name: string }) => r.name)).toEqual(["退款政策.md"]);
		const read = await json(await req(`/api/agent/projects/${project.id}/resources/退款政策.md`, { token }));
		expect(read.text).toContain("三十天内可退");

		// Path traversal and hidden files are refused at the boundary.
		expect(
			(await req(`/api/agent/projects/${project.id}/resources/..%2F..%2Fmemaster%2Fconfig.yml`, { token })).status,
		).toBe(400);
		expect(
			(
				await req(`/api/projects/${project.id}/resources`, {
					method: "POST",
					body: { name: "../escape.md", base64: "eA==" },
				})
			).status,
		).toBe(400);
		expect(await Bun.file(join(library, "escape.md")).exists()).toBe(false);

		// Resources stay inside their own project.
		const other = await createProject("别的项目");
		expect((await json(await req(`/api/agent/projects/${other.id}/resources`, { token }))).length).toBe(0);
	});

	test("a disabled client loses resource access at the agent entry point", async () => {
		const project = await createProject("订单系统");
		const token = await connectClient("codex");
		await req(`/api/projects/${project.id}/resources`, {
			method: "POST",
			body: { name: "a.txt", base64: Buffer.from("secret").toString("base64") },
		});
		await req("/api/clients/codex", { method: "PUT", body: { enabled: false } });
		expect((await req(`/api/agent/projects/${project.id}/resources`, { token })).status).toBe(403);
		expect((await req(`/api/agent/projects/${project.id}/resources/a.txt`, { token })).status).toBe(403);
	});
});
