import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";
import { occurrence } from "../library/tracking.ts";
import { LibraryBridge } from "../mcp/library-bridge.ts";

let home: string;
let service: LibraryService;
let settings: AppSettingsStore;
let holds: TestHolds;
let project: { id: string; dir: string };
let base: string;
const req = (path: string, body?: unknown, method = body ? "POST" : "GET", token?: string) =>
	fetch(`${base}/api/${path}`, {
		method,
		headers: {
			...(body ? { "content-type": "application/json" } : {}),
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
const overview = async () => (await req(`projects/${project.id}/overview`)).json();
const mutate = async (resource: string, body: Record<string, unknown>, method = "POST") =>
	req(`projects/${project.id}/${resource}`, { baseVersion: (await overview()).version, ...body }, method);
const disk = () => readFile(join(project.dir, "memaster/overview.md"), "utf8");
const history = async () =>
	(await readFile(join(project.dir, "memaster/changelog.jsonl"), "utf8"))
		.trim()
		.split("\n")
		.map((x) => JSON.parse(x));
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-dynamic-"));
	settings = new AppSettingsStore(home);
	holds = new TestHolds(true);
	service = new LibraryService({ settings, holds });
	await settings.setLibraryRoot(join(home, "library"));
	await service.start(0);
	base = service.baseUrl();
	const r = await req("projects", { name: "读书会" });
	expect(r.status).toBe(201);
	project = await r.json();
});
afterEach(async () => {
	await service.stop();
	await rm(home, { recursive: true, force: true });
});

test("目标独立创建与归档，保留旧文，成果和新简报原子保存到磁盘", async () => {
	const legacy = await disk();
	const old = (await overview()).goal;
	const create = await mutate("goals", { key: "read-event", title: "让大家能够参与读书交流" });
	expect(create.status).toBe(200);
	const goal = await create.json();
	expect((await overview()).goals[0].id).toBe(goal.id);
	expect(await disk()).toContain(old);
	expect((await overview()).archiveCounts.progress).toBe(0);
	const completed = await mutate(
		`goals/${goal.id}`,
		{
			status: "completed",
			current: "交流已完成，材料已经发给参与者。下一步整理活动反馈。",
			progress: {
				key: "event-held",
				title: "完成首次交流",
				summary: "参与者完成主题讨论，并收到了整理好的阅读材料。",
				completedAt: "2026-01-01",
			},
		},
		"PUT",
	);
	expect(completed.status).toBe(200);
	const o = await overview();
	expect(o.goals).toHaveLength(0);
	expect(o.archiveCounts).toEqual({ completed: 1, adjusted: 0, progress: 1 });
	const archive = await (await req(`projects/${project.id}/goals?status=completed`)).json();
	expect(archive.items[0].title).toBe(goal.title);
	expect(archive.items[0].completedAt).toBeTruthy();
	const stages = await (await req(`projects/${project.id}/progress`)).json();
	expect(stages.items[0].completedAt).toBe("2026-01-01");
	expect(stages.items[0].goalId).toBe(goal.id);
	const raw = await disk();
	expect(raw).toContain(goal.id);
	expect(raw).toContain(stages.items[0].summary);
	expect(raw).toContain(o.current);
	expect(raw).toContain(old);
	expect(raw).not.toBe(legacy);
	expect((await history()).at(-1).target.type).toBe("goal");
});

test("仅更新最新简报不生成阶段记录，读取不迁移，保存不重复追加正文", async () => {
	const before = await disk();
	await overview();
	expect(await disk()).toBe(before);
	const a = await mutate("overview", { current: "已确认活动主题，正在准备材料。" }, "PUT");
	expect(a.status).toBe(200);
	const b = await mutate("overview", { current: "材料已准备好，正在确认参与人数，场地尚未最终确定。" }, "PUT");
	expect(b.status).toBe(200);
	const o = await overview();
	expect(o.current).not.toContain("已确认活动主题");
	expect(o.archiveCounts.progress).toBe(0);
	expect(o.currentUpdatedAt).toBeTruthy();
});

test("重复提交与另一客户端重复创建不产生重复成果或历史", async () => {
	const body = { key: "result-1", title: "材料准备完成", summary: "阅读章节与讨论问题已整理完毕。", completedAt: null };
	const first = await mutate("progress", body);
	expect(first.status).toBe(200);
	const p = await first.json();
	const h = (await history()).length;
	const retry = await mutate("progress", body);
	expect(retry.status).toBe(200);
	expect((await retry.json()).id).toBe(p.id);
	expect((await history()).length).toBe(h);
	const other = await mutate("progress", { ...body, key: "other-agent" });
	expect(other.status).toBe(200);
	expect((await other.json()).id).toBe(p.id);
	const conflict = await mutate("progress", { ...body, summary: "不相同的结果" });
	expect(conflict.status).toBe(409);
	expect((await (await req(`projects/${project.id}/progress`)).json()).total).toBe(1);
	const edited = await mutate(
		`progress/${p.id}`,
		{ summary: "章节和讨论问题已发给全部参与者。", completedAt: null },
		"PUT",
	);
	expect(edited.status).toBe(200);
	expect((await edited.json()).completedAt).toBeNull();
	expect(await disk()).toContain("章节和讨论问题已发给全部参与者。");
});

test("目标调整保留原文和日期，同时建立替代目标", async () => {
	const g = await (await mutate("goals", { key: "g1", title: "举办线下交流" })).json();
	const r = await mutate(`goals/${g.id}`, { status: "adjusted", replacementTitle: "举办线上交流" }, "PUT");
	expect(r.status).toBe(200);
	const o = await overview();
	expect(o.goals[0].title).toBe("举办线上交流");
	expect(o.archiveCounts.adjusted).toBe(1);
	const list = await (await req(`projects/${project.id}/goals?status=adjusted`)).json();
	expect(list.items[0].title).toBe("举办线下交流");
	expect(list.items[0].adjustedAt).toBeTruthy();
});

test("版本冲突、无效日期和历史写入失败均不改变外部终态", async () => {
	const initial = await overview();
	const g = await (await mutate("goals", { key: "goal", title: "完成交流" })).json();
	const bytes = await disk();
	const count = (await history()).length;
	expect(
		(await req(`projects/${project.id}/goals/${g.id}`, { baseVersion: initial.version, status: "completed" }, "PUT"))
			.status,
	).toBe(409);
	expect((await mutate(`goals/${g.id}`, { status: "completed", occurredAt: "2026-02-30" }, "PUT")).status).toBe(400);
	expect((await mutate(`goals/${g.id}`, { status: "completed", occurredAt: "2999-01-01" }, "PUT")).status).toBe(400);
	holds.armHistoryFailure();
	expect(
		(
			await mutate(
				`goals/${g.id}`,
				{ status: "completed", progress: { key: "done", title: "交流完成", summary: "已按计划完成主题交流。" } },
				"PUT",
			)
		).status,
	).toBe(500);
	expect(await disk()).toBe(bytes);
	expect((await history()).length).toBe(count);
	expect((await overview()).archiveCounts.progress).toBe(0);
});

test("两种Agent共享目标，主观确认、未知字段和撤权逐项生效", async () => {
	const tokens: Record<string, string> = {};
	for (const id of ["codex", "claude-code"] as const) {
		await settings.setClientEnabled(id, true);
		const slot = await settings.ensureToken(id);
		await settings.markConnected(id);
		tokens[id] = slot.token;
	}
	const a = new LibraryBridge({ serviceUrl: base, token: tokens.codex ?? "" });
	const b = new LibraryBridge({ serviceUrl: base, token: tokens["claude-code"] ?? "" });
	await a.callTool("project_open", { name: project.id });
	await b.callTool("project_open", { name: project.id });
	const parse = (r: Awaited<ReturnType<LibraryBridge["callTool"]>>) => JSON.parse(r.content[0]?.text ?? "null");
	const r = await a.callTool("goal_create", {
		base_version: (await overview()).version,
		key: "subjective",
		title: "让参与者满意",
		requires_confirmation: true,
	});
	expect(r.isError).not.toBe(true);
	const g = parse(r);
	const seen = parse(await b.callTool("goal_list", {}));
	expect(seen.items[0].id).toBe(g.id);
	const denied = await b.callTool("goal_update", { base_version: seen.version, goal_id: g.id, status: "completed" });
	expect(denied.isError).toBe(true);
	expect((await overview()).goals[0].status).toBe("active");
	const good = await b.callTool("goal_update", {
		base_version: seen.version,
		goal_id: g.id,
		status: "completed",
		confirmed: true,
		progress: { key: "satisfied", title: "参与者认可活动效果", summary: "用户确认参与者的反馈符合预期。" },
	});
	expect(good.isError).not.toBe(true);
	expect((await history()).at(-1).actor).toEqual({ type: "agent", client: "claude-code" });
	const bad = await a.callTool("progress_record", {
		base_version: (await overview()).version,
		key: "bad",
		title: "成果",
		summary: "说明",
		mystery: 1,
	});
	expect(bad.isError).toBe(true);
	const bytes = await disk();
	const hold = holds.create("revoke");
	const pending = a.callTool("progress_record", {
		base_version: (await overview()).version,
		key: "revoked",
		title: "不应保存",
		summary: "撤权后不能写入。",
	});
	await holds.waitForWaiter();
	await settings.setClientEnabled("codex", false);
	holds.release(hold.id);
	expect((await pending).isError).toBe(true);
	expect(await disk()).toBe(bytes);
	expect((await a.callTool("goal_list", {})).isError).toBe(true);
	expect((await b.callTool("goal_list", {})).isError).not.toBe(true);
	for (const name of [
		"goal_list",
		"goal_create",
		"goal_update",
		"progress_list",
		"progress_record",
		"progress_update",
	]) {
		expect(a.listTools().some((t) => t.name === name)).toBe(true);
		const noSelection = new LibraryBridge({ serviceUrl: base, token: tokens.codex ?? "" });
		const called = await noSelection.callTool(name, {
			base_version: "v",
			key: "k",
			title: "t",
			summary: "s",
			goal_id: "g",
			progress_id: "p",
		});
		expect(called.content[0]?.text).not.toContain("Unknown tool");
	}
});

test("分页、项目隔离、并发覆盖拒绝以及重启后数据保留", async () => {
	for (let i = 0; i < 23; i++)
		expect(
			(
				await mutate("progress", {
					key: `r-${i}`,
					title: `成果${i}`,
					summary: `第${i}项已完成的成果。`,
					completedAt: null,
				})
			).status,
		).toBe(200);
	const first = await (await req(`projects/${project.id}/progress?limit=20`)).json();
	const second = await (await req(`projects/${project.id}/progress?offset=20&limit=20`)).json();
	expect(first.items).toHaveLength(20);
	expect(second.items).toHaveLength(3);
	expect(new Set([...first.items, ...second.items].map((x) => x.id)).size).toBe(23);
	const other = await (await req("projects", { name: "另一个项目" })).json();
	expect((await (await req(`projects/${other.id}/progress`)).json()).items).toHaveLength(0);
	const v = (await overview()).version;
	const results = await Promise.all([
		req(`projects/${project.id}/goals`, { baseVersion: v, key: "a", title: "结果甲" }),
		req(`projects/${project.id}/goals`, { baseVersion: v, key: "b", title: "结果乙" }),
	]);
	expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
	expect((await overview()).goals).toHaveLength(1);
	const raw = await disk();
	await service.stop();
	service = new LibraryService({ settings: new AppSettingsStore(home), holds });
	await service.start(0);
	base = service.baseUrl();
	expect((await overview()).archiveCounts.progress).toBe(23);
	expect(await disk()).toBe(raw);
});

test("归档日期可以修正为未知，原有目标不会被旧接口覆盖，损坏记录不能静默重置", async () => {
	const g = await (await mutate("goals", { key: "archive", title: "活动材料可供阅读" })).json();
	expect((await mutate(`goals/${g.id}`, { status: "completed" }, "PUT")).status).toBe(200);
	const raw = await disk();
	expect((await mutate("overview", { goal: "覆盖所有结构化目标" }, "PUT")).status).toBe(400);
	expect(await disk()).toBe(raw);
	expect((await mutate(`goals/${g.id}`, { status: "completed", occurredAt: null }, "PUT")).status).toBe(200);
	const corrected = await (await req(`projects/${project.id}/goals/${g.id}`)).json();
	expect(corrected.completedAt).toBeNull();
	expect(corrected.title).toBe(g.title);
	for (const query of ["limit=0", "limit=101", "offset=-1", "status=made-up"]) {
		expect((await req(`projects/${project.id}/goals?${query}`)).status).toBe(400);
	}
	const beforeBad = await disk();
	await Bun.write(join(project.dir, "memaster/overview.md"), beforeBad.replace('"schema": 1', '"schema": 999'));
	const bad = await req(`projects/${project.id}/overview`);
	expect(bad.status).toBe(400);
	expect(await disk()).toContain('"schema": 999');
});

test("本地已过午夜时，今天的完成日期不能按UTC误判为未来", () => {
	const old = process.env.TZ;
	try {
		process.env.TZ = "Asia/Shanghai";
		expect(occurrence("2026-11-06", "2026-11-05T17:00:00.000Z")).toBe("2026-11-06");
		expect(() => occurrence("2026-11-07", "2026-11-05T17:00:00.000Z")).toThrow("未来");
	} finally {
		if (old === undefined) delete process.env.TZ;
		else process.env.TZ = old;
	}
});
