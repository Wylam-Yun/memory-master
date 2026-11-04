import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMemasterDirectory } from "../utils/memaster-directory.ts";

describe("resolveMemasterDirectory", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = join(tmpdir(), `memaster-directory-test-${Date.now()}`);
		await mkdir(testDir, { recursive: true });
	});

	afterEach(async () => {
		await rm(testDir, { recursive: true, force: true });
	});

	it("prefers root memaster.config.yml with memaster_directory for custom folders", async () => {
		await mkdir(join(testDir, "planning", "memaster-data", "tasks"), { recursive: true });
		await writeFile(
			join(testDir, "memaster.config.yml"),
			'project_name: "Test"\nmemaster_directory: "planning/memaster-data"\n',
		);

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe("custom");
		expect(resolution.configSource).toBe("root");
		expect(resolution.memasterDir).toBe("planning/memaster-data");
		expect(resolution.configPath).toBe(join(testDir, "memaster.config.yml"));
	});

	it("keeps root memaster.config.yml canonical even when the configured memaster directory does not exist yet", async () => {
		await writeFile(
			join(testDir, "memaster.config.yml"),
			'project_name: "Test"\nmemaster_directory: "planning/memaster-data"\n',
		);

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe("custom");
		expect(resolution.configSource).toBe("root");
		expect(resolution.memasterDir).toBe("planning/memaster-data");
		expect(resolution.memasterPath).toBe(join(testDir, "planning", "memaster-data"));
		expect(resolution.configPath).toBe(join(testDir, "memaster.config.yml"));
	});

	it("uses root memaster.config.yml with built-in memaster folder when memaster_directory is omitted", async () => {
		await mkdir(join(testDir, "memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, "memaster.config.yml"), 'project_name: "Test"\n');

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe("memaster");
		expect(resolution.configSource).toBe("root");
		expect(resolution.memasterDir).toBe("memaster");
		expect(resolution.configPath).toBe(join(testDir, "memaster.config.yml"));
	});

	it("falls back to folder-local config when root memaster.config.yml is absent", async () => {
		await mkdir(join(testDir, ".memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, ".memaster", "config.yml"), 'project_name: "Test"\n');

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe(".memaster");
		expect(resolution.configSource).toBe("folder");
		expect(resolution.memasterDir).toBe(".memaster");
		expect(resolution.configPath).toBe(join(testDir, ".memaster", "config.yml"));
	});

	it("falls back to folder-local config when root memaster.config.yml is invalid", async () => {
		await mkdir(join(testDir, ".memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, ".memaster", "config.yml"), 'project_name: "Test"\n');
		await writeFile(join(testDir, "memaster.config.yml"), 'name: "placeholder"\n');

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe(".memaster");
		expect(resolution.configSource).toBe("folder");
		expect(resolution.memasterDir).toBe(".memaster");
		expect(resolution.configPath).toBe(join(testDir, ".memaster", "config.yml"));
	});

	it("prefers the built-in memaster folder that has a config marker", async () => {
		await mkdir(join(testDir, "memaster"), { recursive: true });
		await mkdir(join(testDir, ".memaster", "tasks"), { recursive: true });
		await writeFile(join(testDir, ".memaster", "config.yml"), 'project_name: "Test"\n');

		const resolution = resolveMemasterDirectory(testDir);
		expect(resolution.source).toBe(".memaster");
		expect(resolution.configSource).toBe("folder");
		expect(resolution.memasterDir).toBe(".memaster");
		expect(resolution.configPath).toBe(join(testDir, ".memaster", "config.yml"));
	});
});
