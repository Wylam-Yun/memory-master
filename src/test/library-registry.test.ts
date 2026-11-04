import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Core } from "../core/memaster.ts";
import { readOverview, writeOverview } from "../library/overview.ts";
import {
	createProject,
	getProjectById,
	listProjects,
	RESOURCES_DIR_NAME,
	resolveProject,
	sanitizeProjectDirName,
} from "../library/registry.ts";
import { LIBRARY_ERROR_CODES } from "../library/types.ts";

let library: string;

beforeEach(async () => {
	library = await mkdtemp(join(tmpdir(), "mm-library-"));
});

afterEach(async () => {
	await rm(library, { recursive: true, force: true });
});

describe("library registry", () => {
	it("creates a project directory with the full memaster structure", async () => {
		const work = await mkdtemp(join(tmpdir(), "mm-workdir-"));
		const project = await createProject(library, { name: "订单系统", workingDir: work });

		expect(project.id).toMatch(/^p_[0-9a-f]{10}$/);
		expect(project.dir).toBe(join(library, "订单系统"));
		expect(project.workingDir).toBe(work);

		// The structured store exists and is readable independently of the service.
		const config = await new Core(project.dir).filesystem.loadConfig();
		expect(config?.projectName).toBe("订单系统");
		expect(config?.projectId).toBe(project.id);
		expect(config?.workingDir).toBe(work);
		expect(config?.filesystemOnly).toBe(true);
		expect(await Bun.file(join(project.dir, "memaster", "overview.md")).exists()).toBe(true);
		expect(await readdir(join(project.dir, RESOURCES_DIR_NAME))).toEqual([]);
	});

	it("creates projects without a working directory", async () => {
		const project = await createProject(library, { name: "旅行筹备" });
		expect(project.workingDir).toBeUndefined();
		const config = await new Core(project.dir).filesystem.loadConfig();
		expect(config?.workingDir).toBeUndefined();
	});

	it("lists every project and resolves by name, dirname and id", async () => {
		const a = await createProject(library, { name: "订单系统" });
		const b = await createProject(library, { name: "旅行筹备" });

		expect((await listProjects(library)).map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
		expect((await resolveProject(library, "订单系统")).id).toBe(a.id);
		expect((await resolveProject(library, "旅行筹备")).id).toBe(b.id);
		expect((await resolveProject(library, a.id)).id).toBe(a.id);
		expect((await getProjectById(library, b.id)).name).toBe("旅行筹备");
	});

	it("refuses missing and ambiguous references with usable errors", async () => {
		await createProject(library, { name: "订单系统" });
		// Two directories can claim the same display name only if hand-crafted; emulate
		// ambiguity by matching on directory name vs a second project's display name.
		await expect(resolveProject(library, "不存在")).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND,
		});

		const stray = new Core(join(library, "手工目录"));
		const { initializeProject } = await import("../core/init.ts");
		await initializeProject(stray, {
			projectName: "订单系统", // same display name as the real project
			integrationMode: "none",
			filesystemOnly: true,
		});
		const error = await resolveProject(library, "订单系统").catch((e) => e);
		expect(error).toMatchObject({ code: LIBRARY_ERROR_CODES.PROJECT_AMBIGUOUS, status: 409 });
		expect((error.details as { candidates: unknown[] }).candidates).toHaveLength(2);
	});

	it("rejects duplicate names and invalid inputs", async () => {
		await createProject(library, { name: "订单系统" });
		await expect(createProject(library, { name: "订单系统" })).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.PROJECT_EXISTS,
		});
		await expect(createProject(library, { name: "  " })).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.VALIDATION,
		});
		await expect(createProject(library, { name: "a/b" })).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.VALIDATION,
		});
		await expect(createProject(library, { name: "x", workingDir: "/no/such/dir" })).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.VALIDATION,
		});
	});

	it("sanitizes directory names without mangling CJK", () => {
		expect(sanitizeProjectDirName("订单系统")).toBe("订单系统");
		expect(sanitizeProjectDirName("旅行 筹备")).toBe("旅行-筹备");
		expect(sanitizeProjectDirName('a/b:c*d?"<>|')).not.toContain("/");
		expect(sanitizeProjectDirName("   ")).toBe("project");
		expect(sanitizeProjectDirName("..")).toBe("project");
	});

	it("round-trips the three overview sections and preserves untouched ones", async () => {
		const project = await createProject(library, { name: "订单系统" });

		const before = await readOverview(project.dir);
		expect(before.description).toContain("订单系统");
		expect(before.goal).toContain("待补充");

		const updated = await writeOverview(project.dir, { current: "退款任务进行中" });
		expect(updated.current).toBe("退款任务进行中");
		expect(updated.description).toBe(before.description);
		expect(updated.goal).toBe(before.goal);
	});
});
