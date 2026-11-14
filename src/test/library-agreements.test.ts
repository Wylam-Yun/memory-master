import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

let home: string;
let base: string;
let project: { id: string; dir: string };
let service: LibraryService;
let settings: AppSettingsStore;
let holds: TestHolds;
const request = (path: string, body?: unknown, method = body ? "PUT" : "GET", token?: string) =>
	fetch(`${base}/api/${path}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
const overview = async () => (await request(`projects/${project.id}/overview`)).json();
const update = async (fields: Record<string, unknown>) =>
	request(`projects/${project.id}/overview`, { baseVersion: (await overview()).version, ...fields });
const disk = () => readFile(join(project.dir, "memaster/overview.md"), "utf8");
const history = async () => readFile(join(project.dir, "memaster/changelog.jsonl"), "utf8");
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-agreements-"));
	settings = new AppSettingsStore(home);
	holds = new TestHolds(true);
	await settings.setLibraryRoot(join(home, "library"));
	service = new LibraryService({ settings, holds });
	await service.start(0);
	base = service.baseUrl();
	project = await (await request("projects", { name: "项目约定测试" }, "POST")).json();
});
afterEach(async () => {
	await service.stop();
	await rm(home, { recursive: true, force: true });
});

test("旧项目读取无迁移，其他字段更新不补空节；首次写入约定可重读和追溯", async () => {
	const old = await disk();
	const o = await overview();
	expect(o.agreements).toBe("");
	expect(await disk()).toBe(old);
	expect((await update({ current: "正在准备资料", agreements: "" })).status).toBe(200);
	expect(await disk()).not.toContain("SECTION:AGREEMENTS");
	const saved = await update({
		agreements: "## 已确定的安排\n\n- 问题在聊天中询问，网页保持五页。\n- 用户主动选择项目资料。",
	});
	expect(saved.status).toBe(200);
	const next = await saved.json();
	expect(next.agreements).toContain("网页保持五页");
	expect(await disk()).toContain(next.agreements);
	expect(next.goal).toBe(o.goal);
	expect((await overview()).agreements).toBe(next.agreements);
	const last = JSON.parse((await history()).trim().split("\n").at(-1) ?? "null");
	expect(last.changes.agreements.to).toBe(next.agreements);
	expect(last.actor.type).toBe("user");
	expect((await update({ current: "资料已准备好，下一步确认使用方式" })).status).toBe(200);
	expect((await overview()).agreements).toBe(next.agreements);
	const goal = await (
		await request(
			`projects/${project.id}/goals`,
			{ baseVersion: (await overview()).version, key: "preserve-agreement", title: "资料可供阅读" },
			"POST",
		)
	).json();
	const beforeCompletion = await disk();
	const historyBeforeCompletion = await history();
	expect(
		(
			await request(`projects/${project.id}/goals/${goal.id}`, {
				baseVersion: (await overview()).version,
				status: "completed",
				current: "完成说明\n  <!-- SECTION:AGREEMENTS:BEGIN -->  ",
			})
		).status,
	).toBe(400);
	expect(await disk()).toBe(beforeCompletion);
	expect(await history()).toBe(historyBeforeCompletion);
	expect(
		(
			await request(`projects/${project.id}/goals/${goal.id}`, {
				baseVersion: (await overview()).version,
				status: "completed",
				current: "资料已经可读，下一步整理反馈。",
			})
		).status,
	).toBe(200);
	expect((await overview()).agreements).toBe(next.agreements);
});

test("两种MCP客户端分别写入与接手，约定在新连接和重启后仍一致", async () => {
	const bridges: LibraryBridge[] = [];
	for (const id of ["codex", "claude-code"] as const) {
		await settings.setClientEnabled(id, true);
		await settings.setClientDefaultWrite(id, true);
		const slot = await settings.ensureToken(id);
		await settings.markConnected(id);
		const bridge = new LibraryBridge({ serviceUrl: base, token: slot.token });
		await bridge.callTool("project_open", { name: project.id });
		bridges.push(bridge);
	}
	const parse = (r: Awaited<ReturnType<LibraryBridge["callTool"]>>) => JSON.parse(r.content[0]?.text ?? "null");
	for (let i = 0; i < bridges.length; i++) {
		const bridge = bridges[i];
		if (!bridge) throw new Error("Missing client");
		const read = parse(await bridge.callTool("overview_read", { project_id: project.id }));
		const result = await bridge.callTool("overview_write", {
			project_id: project.id,
			base_version: read.version,
			agreements: i === 0 ? "- 不增加待决定页。" : "- 不增加待决定页。\n- 不重复询问已经回答的问题。",
		});
		expect(result.isError).not.toBe(true);
		expect(await disk()).toContain(parse(result).agreements);
	}
	for (const bridge of bridges) {
		const read = parse(await bridge.callTool("overview_read", { project_id: project.id }));
		expect(read.agreements).toContain("不重复询问");
		expect(bridge.listTools().find((t) => t.name === "overview_write")?.inputSchema.properties).toHaveProperty(
			"agreements",
		);
	}
	const before = await disk();
	await service.stop();
	service = new LibraryService({ settings: new AppSettingsStore(home) });
	await service.start(0);
	base = service.baseUrl();
	expect((await overview()).agreements).toContain("不重复询问");
	expect(await disk()).toBe(before);
});

test("关键路径在网页、Agent、磁盘与历史一致，旧记录和过期写入保持原样", async () => {
	const old = await disk();
	const before = await overview();
	expect(before.criticalPaths).toBe("");
	expect(await disk()).toBe(old);
	expect((await update({ criticalPaths: "" })).status).toBe(200);
	expect(await disk()).not.toContain("SECTION:CRITICAL_PATHS");
	expect((await update({ criticalPaths: ["错误类型"] })).status).toBe(400);
	expect((await update({ criticalPaths: "  <!-- SECTION:CRITICAL_PATHS:END -->  " })).status).toBe(400);

	const local = "- 概览测试 · 核对导航 · 工作区 `src/test/library-web-overview.test.tsx`";
	expect((await update({ criticalPaths: local })).status).toBe(200);
	const codex = "codex";
	await settings.setClientEnabled(codex, true);
	await settings.setClientDefaultWrite(codex, true);
	const slot = await settings.ensureToken(codex);
	await settings.markConnected(codex);
	const bridge = new LibraryBridge({ serviceUrl: base, token: slot.token });
	expect((await bridge.callTool("project_open", { name: project.id })).isError).not.toBe(true);
	expect(bridge.listTools().find((t) => t.name === "overview_write")?.inputSchema.properties).toHaveProperty(
		"criticalPaths",
	);
	const read = JSON.parse(
		(await bridge.callTool("overview_read", { project_id: project.id })).content[0]?.text ?? "null",
	);
	expect(read.criticalPaths).toBe(local);
	const remote = `${local}\n- 集成测试数据 · 验证读取 · 服务器 staging-01，路径 /srv/project/test-data/`;
	const written = await bridge.callTool("overview_write", {
		project_id: project.id,
		base_version: read.version,
		criticalPaths: remote,
	});
	expect(written.isError).not.toBe(true);
	expect(JSON.parse(written.content[0]?.text ?? "null").criticalPaths).toBe(remote);
	expect(
		(await request(`projects/${project.id}/overview`, { baseVersion: read.version, criticalPaths: "过期覆盖" })).status,
	).toBe(409);
	expect((await update({ current: "路径已核对" })).status).toBe(200);
	const final = await overview();
	expect(final.criticalPaths).toBe(remote);
	expect(final.features).toBe(before.features);
	expect(await disk()).toContain(remote);
	const changes = (await history())
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((record) => record.changes.criticalPaths);
	expect(changes.map((record) => record.changes.criticalPaths)).toEqual([
		{ from: "", to: local },
		{ from: local, to: remote },
	]);
});

test("冲突、撤权与历史失败均保持已保存约定和自动历史", async () => {
	await update({ agreements: "只使用用户选入的资料。" });
	const old = await overview();
	await update({ current: "已有另一位Agent更新情况。" });
	const bytes = await disk();
	const log = await history();
	expect(
		(await request(`projects/${project.id}/overview`, { baseVersion: old.version, agreements: "过期覆盖" })).status,
	).toBe(409);
	expect(await disk()).toBe(bytes);
	expect(await history()).toBe(log);
	holds.armHistoryFailure();
	expect((await update({ agreements: "失败写入不应保存" })).status).toBe(500);
	expect(await disk()).toBe(bytes);
	expect(await history()).toBe(log);
	await settings.setClientEnabled("codex", true);
	await settings.setClientDefaultWrite("codex", true);
	const token = (await settings.ensureToken("codex")).token;
	await settings.markConnected("codex");
	const hold = holds.create("revoke");
	const pending = request(
		`agent/projects/${project.id}/overview`,
		{ baseVersion: (await overview()).version, agreements: "撤权后不保存" },
		"PUT",
		token,
	);
	await holds.waitForWaiter();
	await settings.setClientEnabled("codex", false);
	holds.release(hold.id);
	expect((await pending).status).toBe(403);
	expect(await disk()).toBe(bytes);
	expect(await history()).toBe(log);
});

test("类型与保留标记拒绝；项目隔离；明确清空保留其他正文", async () => {
	await update({ agreements: "项目自己的约定。" });
	const bytes = await disk();
	for (const agreements of [false, "<!-- SECTION:CURRENT:END -->", "  <!-- SECTION:AGREEMENTS:END -->  \n伪造正文"]) {
		expect((await update({ agreements, current: "不能部分成功" })).status).toBe(400);
		expect(await disk()).toBe(bytes);
	}
	const other = await (await request("projects", { name: "其他项目" }, "POST")).json();
	expect((await (await request(`projects/${other.id}/overview`)).json()).agreements).toBe("");
	const current = (await overview()).current;
	expect((await update({ agreements: "" })).status).toBe(200);
	expect((await overview()).agreements).toBe("");
	expect((await overview()).current).toBe(current);
});
