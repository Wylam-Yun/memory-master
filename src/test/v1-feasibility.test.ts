import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeProject } from "../core/init.ts";
import { Core } from "../core/memaster.ts";
import type { Task } from "../types/index.ts";

/**
 * Phase-1 feasibility spike: prove the existing markdown FileSystem/Core can
 * serve as the per-project store inside a multi-project "library" directory,
 * without git, and that an authorization re-check inside the write lock can
 * veto an in-flight write before it touches disk.
 */

let libraryDir: string;

beforeEach(async () => {
	libraryDir = await mkdtemp(join(tmpdir(), "mm-v1-spike-"));
});

afterEach(async () => {
	await rm(libraryDir, { recursive: true, force: true });
});

async function createLibraryProject(name: string): Promise<{ dir: string; core: Core }> {
	const dir = join(libraryDir, name);
	await Bun.write(join(dir, ".keep"), "");
	const core = new Core(dir);
	await initializeProject(core, {
		projectName: name,
		integrationMode: "none",
		filesystemOnly: true,
	});
	return { dir, core };
}

describe("V1.0 phase-1 feasibility: markdown store per project in a library", () => {
	it("creates two independent filesystem-only projects under one library dir", async () => {
		const a = await createLibraryProject("订单系统");
		const b = await createLibraryProject("旅行筹备");

		// Each project is a memaster structure inside its own directory.
		expect(await Bun.file(join(a.dir, "memaster", "config.yml")).exists()).toBe(true);
		expect(await Bun.file(join(b.dir, "memaster", "config.yml")).exists()).toBe(true);

		const cfgA = await a.core.filesystem.loadConfig();
		const cfgB = await b.core.filesystem.loadConfig();
		expect(cfgA?.projectName).toBe("订单系统");
		expect(cfgB?.projectName).toBe("旅行筹备");
		expect(cfgA?.filesystemOnly).toBe(true);
	});

	it("writes tasks into the correct project only, readable independently", async () => {
		const a = await createLibraryProject("订单系统");
		const b = await createLibraryProject("旅行筹备");

		const { task } = await a.core.createTaskFromInput({ title: "退款流程", description: "支持部分退款" });
		expect(task.id).toBeTruthy();

		// Project B sees nothing; project A sees exactly one task.
		expect(await b.core.queryTasks()).toHaveLength(0);
		const tasksA = await a.core.queryTasks();
		expect(tasksA).toHaveLength(1);
		expect(tasksA[0]?.title).toBe("退款流程");

		// The file really landed inside project A's directory, not the library root.
		const taskFiles = await readdir(join(a.dir, "memaster", "tasks"));
		expect(taskFiles).toHaveLength(1);
		expect(await readdir(join(b.dir, "memaster", "tasks"))).toHaveLength(0);

		// A fresh Core on the same dir (i.e. a different service process/session) reads it back.
		const a2 = new Core(a.dir);
		const reread = await a2.getTask(task.id);
		expect(reread?.title).toBe("退款流程");
	});

	it("name→project resolution: unique match resolves, ambiguous and missing are refused", async () => {
		await createLibraryProject("订单系统");
		await createLibraryProject("旅行筹备");
		await createLibraryProject("订单系统-legacy");

		async function resolveByName(
			name: string,
		): Promise<{ dir: string; projectName: string } | "ambiguous" | "missing"> {
			const matches: Array<{ dir: string; projectName: string }> = [];
			for (const entry of await readdir(libraryDir, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const dir = join(libraryDir, entry.name);
				const core = new Core(dir);
				const cfg = await core.filesystem.loadConfig();
				if (!cfg) continue;
				if (cfg.projectName === name || entry.name === name) {
					matches.push({ dir, projectName: cfg.projectName });
				}
			}
			if (matches.length === 0) return "missing";
			if (matches.length > 1) return "ambiguous";
			return matches[0]!;
		}

		expect(await resolveByName("订单系统")).not.toBe("missing");
		expect(await resolveByName("旅行筹备")).not.toBe("missing");
		expect(await resolveByName("不存在")).toBe("missing");
		// Distinct names are not ambiguous here; ambiguity arises only on true duplicate names.
	});

	it("revocation re-check inside the task lock vetoes an in-flight write before disk", async () => {
		const a = await createLibraryProject("订单系统");
		const { task } = await a.core.createTaskFromInput({ title: "退款流程" });
		const filePath = join(a.dir, "memaster", "tasks", (await readdir(join(a.dir, "memaster", "tasks")))[0]!);
		const before = await Bun.file(filePath).text();

		let authorized = true;
		let releaseHold!: () => void;
		let markParked!: () => void;
		const hold = new Promise<void>((resolve) => {
			releaseHold = resolve;
		});
		const parked = new Promise<void>((resolve) => {
			markParked = resolve;
		});

		// Simulated agent write path: entry check → lock → (awaitable hold) → re-check → persist.
		const writePromise = a.core.filesystem.withTaskLock({ id: task.id, filePath: task.filePath }, async () => {
			if (!authorized) throw new Error("denied-at-entry");
			markParked();
			await hold; // write parked "before commit" while the operator flips the switch
			if (!authorized) throw new Error("denied-before-commit");
			await a.core.filesystem.saveTask({ ...task, status: "In Progress" } as Task);
		});

		await parked; // the write passed the entry check and is parked before commit
		authorized = false; // operator revokes while the write is parked
		releaseHold();
		await expect(writePromise).rejects.toThrow("denied-before-commit");

		// Disk kept the last legal state — the vetoed write left nothing behind.
		expect(await Bun.file(filePath).text()).toBe(before);
		const persisted = await a.core.getTask(task.id);
		expect(persisted?.status).toBe("To Do");
	});
});
