import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchProjects } from "../library/registry.ts";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { TestHolds } from "../library/test-holds.ts";

let home: string;
let library: string;
let service: LibraryService;
let project: { id: string; dir: string };
const req = (path: string, method = "GET", body?: unknown) =>
	fetch(`${service.baseUrl()}/api/${path}`, {
		method,
		headers: body === undefined ? {} : { "content-type": "application/json" },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
const deletion = async () => (await req(`projects/${project.id}/deletion`)).json();
const remove = (baseVersion: string) => req(`projects/${project.id}`, "DELETE", { baseVersion });
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-project-delete-"));
	library = join(home, "library");
	await mkdir(join(home, "code"));
	await Bun.write(join(home, "code", "keep.txt"), "local source");
	const settings = new AppSettingsStore(home);
	await settings.setLibraryRoot(library);
	service = new LibraryService({ settings, holds: new TestHolds(true) });
	await service.start(0);
	project = await (await req("projects", "POST", { name: "项目删除测试", workingDir: join(home, "code") })).json();
});
afterEach(async () => {
	await service.stop();
	await rm(home, { recursive: true, force: true });
});

test("删除移入回收目录，列表和搜索移除且保留本地源码与记忆历史", async () => {
	await req(`projects/${project.id}/resources`, "POST", {
		name: "资料.md",
		base64: Buffer.from("记忆原件").toString("base64"),
	});
	const { version } = await deletion();
	const response = await remove(version);
	expect(response.status).toBe(200);
	const result = await response.json();
	expect(result.deleted).toBe(project.id);
	expect(await Bun.file(join(result.recoveryPath, "资料", "资料.md")).text()).toBe("记忆原件");
	expect(await Bun.file(join(result.recoveryPath, "memaster", "changelog.jsonl")).text()).toContain(
		'"action":"delete"',
	);
	expect(await Bun.file(join(home, "code", "keep.txt")).text()).toBe("local source");
	expect(await (await req("projects")).json()).toEqual([]);
	expect((await searchProjects(library, "项目删除测试")).total).toBe(0);
	expect((await req(`projects/${project.id}`)).status).toBe(404);
	expect((await remove(version)).status).toBe(404);
	await rename(result.recoveryPath, project.dir);
	expect((await req(`projects/${project.id}`)).status).toBe(200);
	expect((await req(`projects/${project.id}/tasks`, "POST", { title: "恢复后的任务" })).status).toBe(201);
});

test("任何项目内容变化后过期确认均被拒绝", async () => {
	const { version } = await deletion();
	await req(`projects/${project.id}/tasks`, "POST", { title: "刚新增的任务" });
	expect((await remove(version)).status).toBe(409);
	expect((await req(`projects/${project.id}`)).status).toBe(200);
	expect((await req(`projects/${project.id}`, "DELETE", {})).status).toBe(400);
});

test("记录历史失败时项目完整回滚", async () => {
	const { version } = await deletion();
	const history = await Bun.file(join(project.dir, "memaster", "changelog.jsonl")).text();
	service.holds.armHistoryFailure();
	expect((await remove(version)).status).toBe(500);
	expect((await req(`projects/${project.id}`)).status).toBe(200);
	expect(await Bun.file(join(project.dir, "memaster", "changelog.jsonl")).text()).toBe(history);
	expect(await readdir(join(library, ".trash"))).toEqual([]);
});

test("删除期间排队的写入不能重建已删除项目，同名新项目可正常写入", async () => {
	const { version } = await deletion();
	const hold = service.holds.create("delete");
	const deleting = remove(version);
	await service.holds.waitForWaiter();
	const writing = req(`projects/${project.id}/tasks`, "POST", { title: "过期写入" });
	// Give the incoming request time to join the project write queue.
	await new Promise((resolve) => setTimeout(resolve, 30));
	service.holds.release(hold.id);
	expect((await deleting).status).toBe(200);
	expect((await writing).status).toBe(404);
	expect(await Bun.file(join(project.dir, "memaster", "config.yml")).exists()).toBe(false);
	const replacement = await (await req("projects", "POST", { name: "项目删除测试" })).json();
	expect(replacement.id).not.toBe(project.id);
	expect((await req(`projects/${replacement.id}/tasks`, "POST", { title: "新任务" })).status).toBe(201);
});

test("删除前解析但删除后才取得写锁的旧请求被拒绝", async () => {
	const { version } = await deletion();
	const internals = service as unknown as {
		projectFor: (id: string) => Promise<{ id: string; dir: string }>;
	};
	const original = internals.projectFor.bind(service);
	let resume!: () => void;
	let resolved!: () => void;
	const paused = new Promise<void>((resolve) => {
		resolved = resolve;
	});
	const continuation = new Promise<void>((resolve) => {
		resume = resolve;
	});
	internals.projectFor = async (id) => {
		const result = await original(id);
		resolved();
		await continuation;
		return result;
	};
	const stale = req(`projects/${project.id}/resources`, "POST", { name: "late.txt", base64: "bGF0ZQ==" });
	await paused;
	expect((await remove(version)).status).toBe(200);
	const replacement = await (await req("projects", "POST", { name: "项目删除测试" })).json();
	resume();
	expect((await stale).status).toBe(404);
	expect(await Bun.file(join(replacement.dir, "资料", "late.txt")).exists()).toBe(false);
	internals.projectFor = original;
	expect((await req(`projects/${replacement.id}/tasks`, "POST", { title: "新项目可写" })).status).toBe(201);
});
