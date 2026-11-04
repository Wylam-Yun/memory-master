import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { clearProjectRootCache, findMemasterRoot } from "../utils/find-memaster-root.ts";

describe("findMemasterRoot", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `memaster-root-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
		clearProjectRootCache();
	});

	afterEach(async () => {
		clearProjectRootCache();
		await rm(testDir, { recursive: true, force: true });
	});

	it("should find root when memaster/ directory with config exists at start dir", async () => {
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, "memaster", "config.yml"), "project_name: Test\n");

		const result = await findMemasterRoot(testDir);
		expect(result).toBe(testDir);
	});

	it("should find root when .memaster/ directory with config exists at start dir", async () => {
		await mkdir(join(testDir, ".memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, ".memaster", "config.yml"), "project_name: Test\n");

		const result = await findMemasterRoot(testDir);
		expect(result).toBe(testDir);
	});

	it("should NOT find root for bare memaster/ directory without config", async () => {
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });

		const result = await findMemasterRoot(testDir);
		expect(result).toBeNull();
	});

	it("should find root when memaster.json exists at start dir", async () => {
		// Create memaster.json at root
		await writeFile(join(testDir, "memaster.json"), JSON.stringify({ name: "Test" }));

		const result = await findMemasterRoot(testDir);
		expect(result).toBe(testDir);
	});

	it("should find root from a subfolder", async () => {
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, "memaster", "config.yml"), "project_name: Test\n");

		const subfolder = join(testDir, "src", "components", "ui");
		await mkdir(subfolder, { recursive: true });

		const result = await findMemasterRoot(subfolder);
		expect(result).toBe(testDir);
	});

	it("should find root from deeply nested subfolder", async () => {
		// Create memaster.json at root
		await writeFile(join(testDir, "memaster.json"), JSON.stringify({ name: "Test" }));

		// Create deeply nested subfolder
		const deepFolder = join(testDir, "a", "b", "c", "d", "e", "f");
		await mkdir(deepFolder, { recursive: true });

		const result = await findMemasterRoot(deepFolder);
		expect(result).toBe(testDir);
	});

	it("should return null when no memaster project found", async () => {
		// Create a folder with no memaster setup
		const emptyFolder = join(testDir, "empty");
		await mkdir(emptyFolder, { recursive: true });

		const result = await findMemasterRoot(emptyFolder);
		expect(result).toBeNull();
	});

	it("should prefer memaster/ directory over git root", async () => {
		await $`git init`.cwd(testDir).quiet();

		// Create memaster with config in a subfolder (simulating monorepo)
		const projectFolder = join(testDir, "packages", "my-project");
		await mkdir(join(projectFolder, "memaster", "tasks"), { recursive: true });
		await writeFile(join(projectFolder, "memaster", "config.yml"), "project_name: Test\n");

		const searchDir = join(projectFolder, "src");
		await mkdir(searchDir, { recursive: true });

		const result = await findMemasterRoot(searchDir);
		expect(result).toBe(projectFolder);
	});

	it("should find git root with memaster as fallback", async () => {
		await $`git init`.cwd(testDir).quiet();
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, "memaster", "config.yml"), "project_name: Test\n");

		const subfolder = join(testDir, "packages", "lib");
		await mkdir(subfolder, { recursive: true });

		const result = await findMemasterRoot(subfolder);
		expect(result).toBe(testDir);
	});

	it("should not use git root if it has no memaster setup", async () => {
		// Initialize git repo WITHOUT memaster
		await $`git init`.cwd(testDir).quiet();

		// Create subfolder
		const subfolder = join(testDir, "src");
		await mkdir(subfolder, { recursive: true });

		const result = await findMemasterRoot(subfolder);
		expect(result).toBeNull();
	});

	it("should handle nested git repos - find nearest memaster root", async () => {
		await $`git init`.cwd(testDir).quiet();
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, "memaster", "config.yml"), "project_name: Outer\n");

		const innerProject = join(testDir, "packages", "inner");
		await mkdir(innerProject, { recursive: true });
		await $`git init`.cwd(innerProject).quiet();
		await mkdir(join(innerProject, "memaster", "tasks"), { recursive: true });
		await writeFile(join(innerProject, "memaster", "config.yml"), "project_name: Inner\n");

		const innerSrc = join(innerProject, "src");
		await mkdir(innerSrc, { recursive: true });

		const result = await findMemasterRoot(innerSrc);
		expect(result).toBe(innerProject);
	});

	it("should handle memaster/ with config.yaml", async () => {
		// Create memaster structure with config.yaml instead of tasks/
		await mkdir(join(testDir, "memaster"), { recursive: true });
		await writeFile(join(testDir, "memaster", "config.yaml"), "name: Test");

		const result = await findMemasterRoot(testDir);
		expect(result).toBe(testDir);
	});

	it("should find root when project root memaster.config.yml points to a custom memaster directory", async () => {
		await mkdir(join(testDir, "planning", "memaster", "tasks"), { recursive: true });
		await writeFile(
			join(testDir, "memaster.config.yml"),
			'project_name: "Test"\nmemaster_directory: "planning/memaster"\n',
		);

		const result = await findMemasterRoot(testDir);
		expect(result).toBe(testDir);
	});

	it("should ignore placeholder memaster.config.yml files that do not look like Memaster config", async () => {
		await writeFile(join(testDir, "memaster.config.yml"), 'name: "placeholder"\n');

		const result = await findMemasterRoot(testDir);
		expect(result).toBeNull();
	});

	it("should not stop at nested custom memaster directories without a config marker", async () => {
		await mkdir(join(testDir, "planning", "memaster", "tasks"), { recursive: true });
		await writeFile(
			join(testDir, "memaster.config.yml"),
			'project_name: "Test"\nmemaster_directory: "planning/memaster"\n',
		);

		const nestedStart = join(testDir, "planning", "memaster", "tasks");
		const result = await findMemasterRoot(nestedStart);
		expect(result).toBe(testDir);
	});
});
