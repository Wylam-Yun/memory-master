import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/memaster.ts";
import { createUniqueTestDir, isWindows, safeCleanup } from "./test-utils.ts";

describe("Symlinked memaster root", () => {
	const itIfSymlinks = isWindows() ? it.skip : it;
	let repoDir: string;
	let memasterDir: string;

	beforeEach(async () => {
		repoDir = createUniqueTestDir("test-symlink-root-repo");
		memasterDir = createUniqueTestDir("test-symlink-root-memaster");
		await mkdir(repoDir, { recursive: true });
		await mkdir(memasterDir, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(repoDir);
		await safeCleanup(memasterDir);
	});

	itIfSymlinks("creates tasks when memaster root is a symlink and autoCommit is false", async () => {
		await mkdir(join(memasterDir, "tasks"), { recursive: true });
		await mkdir(join(memasterDir, "drafts"), { recursive: true });
		await writeFile(
			join(memasterDir, "config.yml"),
			`project_name: "Symlink Root"
statuses: ["To Do", "In Progress", "Done"]
auto_commit: false
`,
		);

		await symlink(memasterDir, join(repoDir, "memaster"));

		const core = new Core(repoDir);
		const { task } = await core.createTaskFromInput({ title: "Symlink root task" });

		const files = await Array.fromAsync(new Bun.Glob("task-*.md").scan({ cwd: join(memasterDir, "tasks") }));
		expect(files.length).toBe(1);
		expect(task.id).toBe("TASK-1");

		const tasks = await core.listTasksWithMetadata();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]?.id).toBe("TASK-1");
	});

	itIfSymlinks("auto-commit writes to the symlinked memaster repo when enabled", async () => {
		await $`git init`.cwd(memasterDir).quiet();
		await writeFile(join(memasterDir, "README.md"), "# Memaster Repo");
		await $`git add README.md`.cwd(memasterDir).quiet();
		await $`git commit -m "Initial commit"`.cwd(memasterDir).quiet();

		await mkdir(join(memasterDir, "tasks"), { recursive: true });
		await mkdir(join(memasterDir, "drafts"), { recursive: true });
		await writeFile(
			join(memasterDir, "config.yml"),
			`project_name: "Symlink Root"
statuses: ["To Do", "In Progress", "Done"]
auto_commit: true
`,
		);

		await symlink(memasterDir, join(repoDir, "memaster"));

		const core = new Core(repoDir);
		await core.createTaskFromInput({ title: "Symlink root auto-commit" });

		const { stdout } = await $`git log -1 --pretty=format:%s`.cwd(memasterDir).quiet();
		expect(stdout.toString()).toContain("Create task");
	});

	itIfSymlinks("bulk auto-commit stages through an in-repository memaster symlink", async () => {
		const appDir = join(repoDir, "app");
		const sharedMemasterDir = join(repoDir, "shared", "memaster");
		await mkdir(join(appDir), { recursive: true });
		await mkdir(join(sharedMemasterDir, "tasks"), { recursive: true });
		await mkdir(join(sharedMemasterDir, "drafts"), { recursive: true });
		await writeFile(
			join(sharedMemasterDir, "config.yml"),
			`project_name: "In-repository Symlink"
statuses: ["To Do", "In Progress", "Done"]
auto_commit: false
`,
		);
		await symlink(join("..", "shared", "memaster"), join(appDir, "memaster"));

		await $`git init -b main`.cwd(repoDir).quiet();

		const core = new Core(appDir);
		const { task } = await core.createTaskFromInput({ title: "Bulk symlink task" }, false);
		await $`git add .`.cwd(repoDir).quiet();
		await $`git commit -m baseline`.cwd(repoDir).quiet();
		const current = await core.filesystem.loadTask(task.id);
		if (!current) throw new Error("Expected the task to exist");

		await core.updateTasksBulk([{ ...current, ordinal: 2000 }], "Bulk symlink update", true);

		expect(await core.gitOps.getLastCommitMessage()).toContain("Bulk symlink update");
		expect((await $`git status --short`.cwd(repoDir).text()).trim()).toBe("");
	});
});
