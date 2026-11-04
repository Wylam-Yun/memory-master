import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { Core } from "../core/memaster.ts";
import {
	_loadAgentGuideline,
	AGENT_GUIDELINES,
	addAgentInstructions,
	CLI_AGENT_NUDGE,
	ensureMcpGuidelines,
	README_GUIDELINES,
} from "../index.ts";
import { createUniqueTestDir, initializeTestProject, isWindows, safeCleanup } from "./test-utils.ts";

let TEST_DIR: string;

describe("addAgentInstructions", () => {
	const itIfSymlinks = isWindows() ? it.skip : it;
	beforeEach(async () => {
		TEST_DIR = createUniqueTestDir("test-agent-instructions");
		await mkdir(TEST_DIR, { recursive: true });
	});

	afterEach(async () => {
		await safeCleanup(TEST_DIR);
	});

	it("creates guideline files when none exist", async () => {
		await addAgentInstructions(TEST_DIR);
		const agents = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		const claude = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();
		const gemini = await Bun.file(join(TEST_DIR, "GEMINI.md")).text();
		const copilot = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).text();

		// Check that files contain the markers and content
		expect(agents).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(agents).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(agents).toContain(CLI_AGENT_NUDGE);
		expect(agents).not.toContain("# Instructions for the usage of Memaster CLI Tool");

		expect(claude).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(claude).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(claude).toContain(CLI_AGENT_NUDGE);

		expect(gemini).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(gemini).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(gemini).toContain(CLI_AGENT_NUDGE);

		expect(copilot).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(copilot).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(copilot).toContain(CLI_AGENT_NUDGE);
	});

	it("auto-commit preserves unrelated staged work (BACK-563)", async () => {
		await $`git init`.cwd(TEST_DIR).quiet();

		const core = new Core(TEST_DIR);
		await initializeTestProject(core, "Agent Instructions Scope", true);
		await Bun.write(join(TEST_DIR, "UNRELATED.txt"), "baseline\n");
		await $`git add UNRELATED.txt`.cwd(TEST_DIR).quiet();
		await $`git commit -m "Add unrelated file"`.cwd(TEST_DIR).quiet();
		await Bun.write(join(TEST_DIR, "UNRELATED.txt"), "peer edit\n");
		await $`git add UNRELATED.txt`.cwd(TEST_DIR).quiet();

		await addAgentInstructions(TEST_DIR, core.gitOps, ["AGENTS.md"], true);

		const committed = await $`git show --name-only --pretty=format:`.cwd(TEST_DIR).text();
		expect(committed).toContain("AGENTS.md");
		expect(committed).not.toContain("UNRELATED.txt");
		expect(await $`git diff --cached --name-only`.cwd(TEST_DIR).text()).toContain("UNRELATED.txt");
	});

	itIfSymlinks("auto-commits selected instructions in each resolved repository", async () => {
		const externalRepo = createUniqueTestDir("test-agent-instructions-external");
		try {
			await mkdir(externalRepo, { recursive: true });
			for (const repo of [TEST_DIR, externalRepo]) {
				await $`git init -b main`.cwd(repo).quiet();
				await Bun.write(join(repo, "README.md"), "baseline\n");
				await $`git add README.md`.cwd(repo).quiet();
				await $`git commit -m baseline`.cwd(repo).quiet();
			}
			await symlink(externalRepo, join(TEST_DIR, ".github"));
			await $`git add .github`.cwd(TEST_DIR).quiet();
			await $`git commit -m "Add instruction symlink"`.cwd(TEST_DIR).quiet();

			const core = new Core(TEST_DIR);
			await addAgentInstructions(TEST_DIR, core.gitOps, ["AGENTS.md", ".github/copilot-instructions.md"], true);

			expect(await $`git show --name-only --pretty=format:`.cwd(TEST_DIR).text()).toContain("AGENTS.md");
			expect(await $`git show --name-only --pretty=format:`.cwd(externalRepo).text()).toContain(
				"copilot-instructions.md",
			);
			expect((await $`git status --short`.cwd(TEST_DIR).text()).trim()).toBe("");
			expect((await $`git status --short`.cwd(externalRepo).text()).trim()).toBe("");
		} finally {
			await safeCleanup(externalRepo);
		}
	});

	it("generated CLI nudge requires phase-specific workflow guides", async () => {
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const agents = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();

		expect(agents).toContain("Before task lifecycle actions, read the matching detailed guide:");
		expect(agents).toContain(
			"`memaster instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work",
		);
		expect(agents).toContain(
			"`memaster instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses",
		);
		expect(agents).not.toContain("Use the detailed guides when needed:");
	});

	it("appends guideline files when they already exist", async () => {
		await Bun.write(join(TEST_DIR, "AGENTS.md"), "Existing\n");
		const results = await addAgentInstructions(TEST_DIR);
		const agents = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		expect(agents.startsWith("Existing\n")).toBe(true);
		expect(agents).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(agents).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(agents).toContain(CLI_AGENT_NUDGE);
		expect(results.find((result) => result.fileName === "AGENTS.md")?.action).toBe("updated");
		expect(results.find((result) => result.fileName === "CLAUDE.md")?.action).toBe("created");
	});

	it("reports unchanged guideline files when the selected block already exists", async () => {
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const results = await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);

		expect(results).toEqual([
			{
				action: "unchanged",
				fileName: "AGENTS.md",
				filePath: join(TEST_DIR, "AGENTS.md"),
			},
		]);
	});

	it("replaces stale generated CLI guideline blocks", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		await Bun.write(
			agentsPath,
			[
				"Existing header",
				"<!-- MEMASTER GUIDELINES START -->",
				"Old generated Memaster guidance",
				"<!-- MEMASTER GUIDELINES END -->",
				"Existing footer",
				"",
			].join("\n"),
		);

		const results = await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const agents = await Bun.file(agentsPath).text();

		expect(results).toEqual([
			{
				action: "updated",
				fileName: "AGENTS.md",
				filePath: agentsPath,
			},
		]);
		expect(agents).toContain("Existing header");
		expect(agents).toContain("Existing footer");
		expect(agents).toContain(CLI_AGENT_NUDGE);
		expect(agents).not.toContain("Old generated Memaster guidance");
		expect((agents.match(/<!-- MEMASTER GUIDELINES START -->/g) || []).length).toBe(1);
	});

	it("creates only selected files", async () => {
		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md", "README.md"]);

		const agentsExists = await Bun.file(join(TEST_DIR, "AGENTS.md")).exists();
		const claudeExists = await Bun.file(join(TEST_DIR, "CLAUDE.md")).exists();
		const geminiExists = await Bun.file(join(TEST_DIR, "GEMINI.md")).exists();
		const copilotExists = await Bun.file(join(TEST_DIR, ".github/copilot-instructions.md")).exists();
		const readme = await Bun.file(join(TEST_DIR, "README.md")).text();

		expect(agentsExists).toBe(true);
		expect(claudeExists).toBe(false);
		expect(geminiExists).toBe(false);
		expect(copilotExists).toBe(false);
		expect(readme).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(readme).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(readme).toContain(await _loadAgentGuideline(README_GUIDELINES));
	});

	it("loads guideline content from file paths", async () => {
		const pathGuideline = join(__dirname, "../guidelines/agent-guidelines.md");
		const content = await _loadAgentGuideline(pathGuideline);
		expect(content).toContain("# Instructions for the usage of Memaster CLI Tool");
	});

	it("full agent workflow plans only after pickup and current-state research", async () => {
		const guideline = await _loadAgentGuideline(AGENT_GUIDELINES);
		const workflow = guideline.match(/## 6\. Typical Workflow[\s\S]*?(?=\n---)/)?.[0] ?? "";
		const readIndex = workflow.indexOf(
			"Read task details and confirm status, scope, acceptance criteria, and dependencies",
		);
		const pickupIndex = workflow.indexOf("Start eligible work: assign yourself & change status");
		const researchIndex = workflow.indexOf(
			"Research the current code, tests, conventions, and recent changes after activation",
		);
		const planIndex = workflow.indexOf("Add the current implementation plan");
		const conditionalReviewIndex = workflow.indexOf(
			"If the plan contains a material product, architecture, or workflow decision",
		);
		const implementationIndex = workflow.indexOf("Work on the task");

		expect(readIndex).toBeGreaterThan(-1);
		expect(pickupIndex).toBeGreaterThan(readIndex);
		expect(researchIndex).toBeGreaterThan(pickupIndex);
		expect(planIndex).toBeGreaterThan(researchIndex);
		expect(conditionalReviewIndex).toBeGreaterThan(planIndex);
		expect(implementationIndex).toBeGreaterThan(conditionalReviewIndex);
		expect(workflow).not.toContain("Share the plan with the user and wait for approval");
	});

	it("preserves existing content and adds Memaster content only once", async () => {
		const existingContent = "# My Existing Claude Instructions\n\nThis is my custom content.\n";
		await Bun.write(join(TEST_DIR, "CLAUDE.md"), existingContent);

		// First run
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const firstRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		// Second run - should not duplicate Memaster content
		await addAgentInstructions(TEST_DIR, undefined, ["CLAUDE.md"]);
		const secondRun = await Bun.file(join(TEST_DIR, "CLAUDE.md")).text();

		expect(firstRun).toBe(secondRun);
		expect(firstRun).toContain(existingContent);
		expect(firstRun).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(firstRun).toContain("<!-- MEMASTER GUIDELINES END -->");

		// Count occurrences of the marker to ensure it's only there once
		const startMarkerCount = (firstRun.match(/<!-- MEMASTER GUIDELINES START -->/g) || []).length;
		const endMarkerCount = (firstRun.match(/<!-- MEMASTER GUIDELINES END -->/g) || []).length;
		expect(startMarkerCount).toBe(1);
		expect(endMarkerCount).toBe(1);
	});

	it("replaces CLI guidelines with MCP nudge when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const cliBlock = [
			"Preface content",
			"<!-- MEMASTER GUIDELINES START -->",
			"CLI instructions here",
			"<!-- MEMASTER GUIDELINES END -->",
			"Footer line",
			"",
		].join("\n");
		await Bun.write(agentsPath, cliBlock);

		await ensureMcpGuidelines(TEST_DIR, "AGENTS.md");
		const updated = await Bun.file(agentsPath).text();

		expect(updated).not.toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(updated).not.toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(updated).toContain("<!-- MEMASTER MCP GUIDELINES START -->");
		expect(updated).toContain("<!-- MEMASTER MCP GUIDELINES END -->");
		expect(updated).toContain("Preface content");
		expect(updated).toContain("Footer line");
	});

	// BACK-431 / issue #595: multi-line input guidance must lead with forms that pass
	// the tree-sitter AST walkers used by Claude Code, Codex, and similar agent sandboxes.
	// ANSI-C strings ($'...'), command substitutions ($(...)), and heredocs are rejected
	// outright; the section must lead with safe alternatives so headless agent runs do
	// not waste tokens cycling through rejections before falling back.
	it("agent guidelines lead multi-line input with sandbox-safe forms (BACK-431/#595)", async () => {
		const guideline = await _loadAgentGuideline(AGENT_GUIDELINES);
		const sectionMatch = guideline.match(/### Multi[‑-]line Input[\s\S]*?(?=\n### |\n## |$)/);
		expect(sectionMatch).not.toBeNull();
		const section = sectionMatch?.[0] ?? "";
		// Must mention --append-* as a primary safe approach.
		expect(section).toMatch(/--append-/);
		// Must mention real-newlines-in-quotes as a primary safe approach.
		expect(section).toMatch(/[Rr]eal newlines/);
		// Must call out that ANSI-C / command-substitution forms are sandbox-rejected.
		expect(section).toMatch(/sandbox|tree[\s-]sitter|reject/i);
		// Issue #595 must be linked so future readers can find the rationale.
		expect(section).toMatch(/#595|issues\/595/);
		// The safe alternatives must appear before the shell-specific shorthand list.
		const appendIdx = section.search(/--append-/);
		const ansiCIdx = section.search(/\$'/);
		expect(appendIdx).toBeGreaterThan(-1);
		expect(ansiCIdx).toBeGreaterThan(appendIdx);
	});

	it("agent guidelines document literal backtick shell quoting (BACK-270)", async () => {
		const guideline = await _loadAgentGuideline(AGENT_GUIDELINES);
		const sectionMatch = guideline.match(/### Literal Backticks in CLI Task Text[\s\S]*?(?=\n### |\n## |$)/);
		expect(sectionMatch).not.toBeNull();
		const section = sectionMatch?.[0] ?? "";

		expect(section).toContain("single-quoted CLI arguments");
		expect(section).toContain("memaster task create 'Document `memaster init` setup'");
		expect(section).toContain("Memaster cannot recover the original text after the shell has already executed it");
	});

	// BACK-267: every installed instruction block carries a machine-readable version
	// marker derived from the running binary/package version, so tooling can compare
	// a project's local instructions against the bundled ones.
	it("writes a version marker matching package.json inside the guidelines block (BACK-267)", async () => {
		const { version } = await Bun.file(join(__dirname, "../../package.json")).json();
		const versionMarker = `<!-- memory-master-instructions-version: ${version} -->`;

		await addAgentInstructions(TEST_DIR);
		for (const fileName of ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md"]) {
			const content = await Bun.file(join(TEST_DIR, fileName)).text();
			expect(content).toContain(versionMarker);
			// Marker lives inside the managed block, right after the start marker
			expect(content.indexOf(versionMarker)).toBeGreaterThan(content.indexOf("<!-- MEMASTER GUIDELINES START -->"));
			expect(content.indexOf(versionMarker)).toBeLessThan(content.indexOf("<!-- MEMASTER GUIDELINES END -->"));
			expect((content.match(/<!-- memory-master-instructions-version: /g) || []).length).toBe(1);
		}
	});

	it("refreshes a stale version marker when updating an existing block (BACK-267)", async () => {
		const { version } = await Bun.file(join(__dirname, "../../package.json")).json();
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		await Bun.write(
			agentsPath,
			[
				"Existing header",
				"<!-- MEMASTER GUIDELINES START -->",
				"<!-- memory-master-instructions-version: 0.0.1 -->",
				"Old generated Memaster guidance",
				"<!-- MEMASTER GUIDELINES END -->",
				"",
			].join("\n"),
		);

		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const agents = await Bun.file(agentsPath).text();

		expect(agents).not.toContain("memory-master-instructions-version: 0.0.1");
		expect(agents).toContain(`<!-- memory-master-instructions-version: ${version} -->`);
		expect(agents).toContain("Existing header");
	});

	it("writes the version marker in MCP guideline blocks (BACK-267)", async () => {
		const { version } = await Bun.file(join(__dirname, "../../package.json")).json();

		await ensureMcpGuidelines(TEST_DIR, "AGENTS.md");
		const content = await Bun.file(join(TEST_DIR, "AGENTS.md")).text();
		const versionMarker = `<!-- memory-master-instructions-version: ${version} -->`;

		expect(content).toContain(versionMarker);
		expect(content.indexOf(versionMarker)).toBeGreaterThan(content.indexOf("<!-- MEMASTER MCP GUIDELINES START -->"));
		expect(content.indexOf(versionMarker)).toBeLessThan(content.indexOf("<!-- MEMASTER MCP GUIDELINES END -->"));
	});

	it("replaces MCP nudge with CLI guidelines when switching modes", async () => {
		const agentsPath = join(TEST_DIR, "AGENTS.md");
		const mcpBlock = [
			"Header",
			"<!-- MEMASTER MCP GUIDELINES START -->",
			"MCP reminder here",
			"<!-- MEMASTER MCP GUIDELINES END -->",
			"",
		].join("\n");
		await Bun.write(agentsPath, mcpBlock);

		await addAgentInstructions(TEST_DIR, undefined, ["AGENTS.md"]);
		const updated = await Bun.file(agentsPath).text();

		expect(updated).toContain("<!-- MEMASTER GUIDELINES START -->");
		expect(updated).toContain("<!-- MEMASTER GUIDELINES END -->");
		expect(updated).not.toContain("<!-- MEMASTER MCP GUIDELINES START -->");
		expect(updated).not.toContain("<!-- MEMASTER MCP GUIDELINES END -->");
		expect(updated).toContain("Header");
	});
});
