import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../index.ts";
import { formatRootEntry, printRootEntry } from "../ui/root-entry.ts";
import { getTestCliPath } from "./test-cli.ts";

let TEST_DIR: string;
const CLI_PATH = getTestCliPath();

describe("CLI root entry (bare run)", () => {
	beforeEach(async () => {
		TEST_DIR = await mkdtemp(join(tmpdir(), "memaster-root-entry-"));
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("can colorize the plain root entry when color is enabled", () => {
		const out = formatRootEntry({ version: "1.2.3", initialized: true, color: true });

		expect(out).toContain("\u001B[1;36m██████╗");
		expect(out).toContain("\u001B[1mMemaster\u001B[0m v1.2.3");
		expect(out).toContain("\u001B[1;33mCommon workflow:\u001B[0m");
		expect(out).toContain("\u001B[0m");
	});

	it("honors explicit color false even when stdout is a TTY", async () => {
		const originalWrite = process.stdout.write;
		const originalIsTTY = process.stdout.isTTY;
		let output = "";

		Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
		process.stdout.write = ((chunk: string | Uint8Array) => {
			output += chunk.toString();
			return true;
		}) as typeof process.stdout.write;

		try {
			await printRootEntry({ version: "1.2.3", initialized: true, color: false });
		} finally {
			process.stdout.write = originalWrite;
			Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
		}

		expect(output).toContain("Memaster v1.2.3");
		expect(output).not.toContain("\u001B[");
		expect(output).not.toContain("\u001B]");
	});

	it("prints a plain local entry point in non-initialized repo", async () => {
		const result = await $`bun ${CLI_PATH}`.cwd(TEST_DIR).quiet();
		const out = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(out).toContain("██████╗");
		expect(out).toContain("Memaster v");
		expect(out).toContain("This directory is not initialized for Memaster.");
		expect(out).toContain("Project setup:");
		expect(out).toContain("memaster init");
		expect(out).toContain("Local instructions:");
		expect(out).toContain("memaster instructions");
		expect(out).toContain("memaster instructions overview");
		expect(out).toContain("memaster <command> --help");
		expect(out).toContain("Docs: https://github.com/Wylam-Yun/memory-master");
		expect(out).not.toContain("\u001B[");
		expect(out).not.toContain("\u001B]");
	});

	it("prints a plain local entry point in initialized repo", async () => {
		// Initialize Git + project via Core
		const core = new Core(TEST_DIR);
		await initializeFilesystemTestProject(core, "Splash Test");

		const result = await $`bun ${CLI_PATH}`.cwd(TEST_DIR).quiet();
		const out = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(out).toContain("██████╗");
		expect(out).toContain("Common workflow:");
		expect(out).toContain("memaster task view TASK-123 --plain");
		expect(out).toContain("memaster task create");
		expect(out).toContain("memaster board");
		expect(out).toContain("Open the TUI Kanban board");
		expect(out).toContain("memaster browser");
		expect(out).toContain("Open the Web UI Kanban board");
		expect(out).toContain("Local instructions:");
		expect(out).toContain("memaster instructions task-execution");
		expect(out).not.toContain("memaster init");
		expect(out).toContain("Docs: https://github.com/Wylam-Yun/memory-master");
		expect(out).not.toContain("\u001B[");
		expect(out).not.toContain("\u001B]");
	});

	it("--help shows commander help, not the root entry", async () => {
		const result = await $`bun ${CLI_PATH} --help`.cwd(TEST_DIR).quiet();
		const out = result.stdout.toString();
		expect(result.exitCode).toBe(0);
		expect(out).toMatch(/Usage: .*memaster/);
		expect(out).not.toContain("Local instructions:");
	});
});

import { initializeFilesystemTestProject } from "./test-utils.ts";
