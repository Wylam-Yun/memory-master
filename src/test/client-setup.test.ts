import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeConfig, clientDetected, clientFiles, connectSnippet, installClient } from "../library/client-setup.ts";
import { AppSettingsStore } from "../library/settings.ts";
import { LIBRARY_CLIENT_IDS, LIBRARY_CLIENT_LABELS, type LibraryClientId } from "../library/types.ts";

/**
 * Per-harness installer tests (Phase 4 follow-up): every client id in
 * LIBRARY_CLIENT_IDS must have a label, a token prefix (proven by a minted
 * credential), a ClientFiles record, and a connect snippet — the registry
 * audit the interface-consistency rule requires. Each new-format installer
 * also gets real on-disk assertions: files land where the harness reads
 * them, parse in the harness's format, and never duplicate on re-install.
 */

const SERVICE_URL = "http://127.0.0.1:6423";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-clients-"));
	process.env.MEMORY_MASTER_CLIENT_HOME = home;
});

afterEach(async () => {
	delete process.env.MEMORY_MASTER_CLIENT_HOME;
	delete process.env.OPENCODE_CONFIG_DIR;
	delete process.env.HERMES_HOME;
	delete process.env.DSH_HOME;
	await rm(home, { recursive: true, force: true });
});

async function install(id: LibraryClientId) {
	return await installClient(id, { serviceUrl: SERVICE_URL, token: `mm_test_${id}` });
}

describe("client registry consistency", () => {
	it("every client id has a label, files record, token prefix, and connect snippet", async () => {
		const store = new AppSettingsStore(join(home, "settings-home"));
		for (const id of LIBRARY_CLIENT_IDS) {
			expect(LIBRARY_CLIENT_LABELS[id]?.length).toBeGreaterThan(0);
			const { token } = await store.ensureToken(id);
			expect(token.startsWith(`mm_${id.split("-")[0]}_`)).toBe(true);
			const files = clientFiles(id);
			expect(files.mcp.configPath).toBeTruthy();
			expect(files.instructionsPath).toBeTruthy();
			expect(files.skillPath).toBeTruthy();
			expect(connectSnippet(id, bridgeConfig(SERVICE_URL, token)).length).toBeGreaterThan(10);
		}
	});

	it("installs every registered client without error and all land a skill bundle", async () => {
		for (const id of LIBRARY_CLIENT_IDS) {
			const result = await install(id);
			expect(result.error).toBeUndefined();
			expect(result.ok).toBe(true);
			const skillDir = join(clientFiles(id).skillPath, "..");
			for (const name of ["SKILL.md", "CONTENT-STANDARD.md", "ARCHITECTURE-FORMAT.md"]) {
				expect(await Bun.file(join(skillDir, name)).exists()).toBe(true);
			}
		}
	});
});

describe("json-mcpServers family (claude-code / devin / cursor)", () => {
	it("devin writes mcp_config.json + AGENTS.md + skills, preserving existing keys", async () => {
		const configPath = join(home, ".config", "devin", "mcp_config.json");
		await Bun.write(configPath, JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));

		const result = await install("devin");
		expect(result.ok).toBe(true);

		const parsed = JSON.parse(await readFile(configPath, "utf8"));
		expect(parsed.theme).toBe("dark");
		expect(parsed.mcpServers.other.command).toBe("x");
		expect(parsed.mcpServers["memory-master"].env.MEMORY_MASTER_URL).toBe(SERVICE_URL);
		expect(parsed.mcpServers["memory-master"].env.MEMORY_MASTER_TOKEN).toBe("mm_test_devin");
		expect(parsed.mcpServers["memory-master"].args.at(-1)).toBe("bridge");

		const agentsMd = await readFile(join(home, ".config", "devin", "AGENTS.md"), "utf8");
		expect(agentsMd).toContain("<!-- memory-master:begin -->");
		expect(await Bun.file(join(home, ".config", "devin", "skills", "memory-master", "SKILL.md")).exists()).toBe(true);
	});

	it("cursor writes mcp.json + frontmatter .mdc rule + skills", async () => {
		const result = await install("cursor");
		expect(result.ok).toBe(true);

		const parsed = JSON.parse(await readFile(join(home, ".cursor", "mcp.json"), "utf8"));
		expect(parsed.mcpServers["memory-master"].command).toBeTruthy();
		expect(parsed.mcpServers["memory-master"].env.MEMORY_MASTER_TOKEN).toBe("mm_test_cursor");

		const rule = await readFile(join(home, ".cursor", "rules", "memory-master.mdc"), "utf8");
		expect(rule).toContain("alwaysApply: true");
		expect(rule).toContain("<!-- memory-master:begin -->");

		// Re-install: same file replaced, never duplicated.
		expect((await install("cursor")).ok).toBe(true);
		const rule2 = await readFile(join(home, ".cursor", "rules", "memory-master.mdc"), "utf8");
		expect((rule2.match(/<!-- memory-master:begin -->/g) ?? []).length).toBe(1);
	});
});

describe("opencode installer", () => {
	it("writes the opencode-shaped mcp entry, preserving the user's other keys", async () => {
		const dir = join(home, ".config", "opencode");
		const configPath = join(dir, "opencode.json");
		await Bun.write(
			configPath,
			JSON.stringify({ $schema: "https://opencode.ai/config.json", model: "m/x", provider: { p: {} } }),
		);

		const result = await install("opencode");
		expect(result.ok).toBe(true);

		const parsed = JSON.parse(await readFile(configPath, "utf8"));
		expect(parsed.model).toBe("m/x");
		expect(parsed.provider).toEqual({ p: {} });
		expect(parsed.mcp["memory-master"].type).toBe("local");
		expect(parsed.mcp["memory-master"].command.at(-1)).toBe("bridge");
		expect(parsed.mcp["memory-master"].environment.MEMORY_MASTER_TOKEN).toBe("mm_test_opencode");

		const agents = await readFile(join(dir, "AGENTS.md"), "utf8");
		expect(agents).toContain("<!-- memory-master:begin -->");
	});

	it("reinstall replaces the entry instead of duplicating it", async () => {
		await install("opencode");
		await install("opencode");
		const parsed = JSON.parse(await readFile(join(home, ".config", "opencode", "opencode.json"), "utf8"));
		expect(Object.keys(parsed.mcp).filter((k) => k === "memory-master").length).toBe(1);
	});

	it("a JSONC (commented) config fails loudly instead of being corrupted", async () => {
		const configPath = join(home, ".config", "opencode", "opencode.json");
		await Bun.write(configPath, '{\n  // user comment\n  "model": "m/x"\n}\n');
		const result = await install("opencode");
		expect(result.ok).toBe(false);
		expect(result.error).toContain("opencode");
		// Untouched — the user's file survives.
		expect(await readFile(configPath, "utf8")).toContain("// user comment");
	});
});

describe("hermes installer", () => {
	const configPath = () => join(home, ".hermes", "config.yaml");
	const envPath = () => join(home, ".hermes", ".env");

	it("creates the mcp_servers section and the .env credential", async () => {
		const result = await install("hermes");
		expect(result.ok).toBe(true);
		// config.yaml + .env + instructions + 6 skill files.
		expect(result.installed.length).toBe(9);

		const yaml = await readFile(configPath(), "utf8");
		const parsed = Bun.YAML.parse(yaml) as Record<string, Record<string, Record<string, unknown>>>;
		expect(parsed.mcp_servers?.["memory-master"]?.env).toEqual({
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional YAML ${VAR} interpolation reference
			MEMORY_MASTER_URL: "${MEMORY_MASTER_URL}",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: intentional YAML ${VAR} interpolation reference
			MEMORY_MASTER_TOKEN: "${MEMORY_MASTER_TOKEN}",
		});
		// The secret lives in .env, referenced as ${VAR} — never inline in yaml.
		expect(yaml).not.toContain("mm_test_hermes");
		const env = await readFile(envPath(), "utf8");
		expect(env).toContain("MEMORY_MASTER_TOKEN=mm_test_hermes");
		expect(env).toContain(`MEMORY_MASTER_URL=${SERVICE_URL}`);

		const soul = await readFile(join(home, ".hermes", "SOUL.md"), "utf8");
		expect(soul).toContain("<!-- memory-master:begin -->");
	});

	it("splices the entry into an existing commented mcp_servers map", async () => {
		await Bun.write(
			configPath(),
			[
				"# Hermes 自己的注释，不许丢",
				"model: deepseek/chat",
				"mcp_servers:",
				"  time:",
				'    command: "uvx"',
				'    args: ["mcp-server-time"]',
				"other_key: true",
				"",
			].join("\n"),
		);
		const result = await install("hermes");
		expect(result.ok).toBe(true);
		const yaml = await readFile(configPath(), "utf8");
		expect(yaml).toContain("# Hermes 自己的注释");
		expect(yaml).toContain("time:");
		expect(yaml).toContain("other_key: true");
		const parsed = Bun.YAML.parse(yaml) as Record<string, Record<string, unknown>>;
		expect(parsed.mcp_servers?.time).toBeTruthy();
		expect(parsed.mcp_servers?.["memory-master"]).toBeTruthy();
	});

	it("expands an empty `mcp_servers: {}` and survives a commented example block", async () => {
		await Bun.write(configPath(), "mcp_servers: {}\n");
		expect((await install("hermes")).ok).toBe(true);
		const parsed = Bun.YAML.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
		expect(parsed.mcp_servers).toBeTruthy();

		// The shipped example has the whole mcp_servers block commented out.
		await rm(join(home, ".hermes"), { recursive: true, force: true });
		await Bun.write(configPath(), "# mcp_servers:\n#   time:\n#     command: uvx\n#     args: [mcp-server-time]\n");
		expect((await install("hermes")).ok).toBe(true);
		const parsed2 = Bun.YAML.parse(await readFile(configPath(), "utf8")) as Record<string, Record<string, unknown>>;
		expect(parsed2.mcp_servers?.["memory-master"]).toBeTruthy();
	});

	it("refuses a hand-written duplicate entry and a broken flow-style value", async () => {
		await Bun.write(configPath(), "mcp_servers:\n  memory-master:\n    command: mine\n");
		const dup = await install("hermes");
		expect(dup.ok).toBe(false);
		expect(dup.error).toContain("memory-master");
		expect(await readFile(configPath(), "utf8")).toContain("command: mine");

		await Bun.write(configPath(), 'mcp_servers: {time: {command: "uvx"}}\n');
		const flow = await install("hermes");
		expect(flow.ok).toBe(false);
		expect(flow.error).toContain("flow style");
	});

	it("re-install replaces the marked entry and never duplicates", async () => {
		await install("hermes");
		expect((await install("hermes")).ok).toBe(true);
		const yaml = await readFile(configPath(), "utf8");
		expect((yaml.match(/# >>> memory-master >>>/g) ?? []).length).toBe(1);
		const parsed = Bun.YAML.parse(yaml) as Record<string, Record<string, unknown>>;
		expect(Object.keys(parsed.mcp_servers ?? {}).filter((k) => k === "memory-master").length).toBe(1);
		const env = await readFile(envPath(), "utf8");
		expect((env.match(/MEMORY_MASTER_TOKEN=/g) ?? []).length).toBe(1);
	});
});

describe("dsh installer (cordis patch list)", () => {
	const patchPath = () => join(home, ".dsh", "cordis.patch.yml");
	const shippedDefault =
		"# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n";

	it("replaces the shipped `[]` default and keeps the file a valid patch list", async () => {
		await Bun.write(patchPath(), shippedDefault);
		const result = await install("dsh");
		expect(result.ok).toBe(true);

		const text = await readFile(patchPath(), "utf8");
		expect(text).toContain("# Your patch layer");
		expect(text.trim().startsWith("[]")).toBe(false);
		const parsed = Bun.YAML.parse(text) as Array<{
			insert?: Array<{ id?: string; name?: string; config?: Record<string, unknown> }>;
		}>;
		const entry = parsed.flatMap((e) => e.insert ?? []).find((i) => i.id === "mcp-memory-master");
		expect(entry?.name).toBe("@deepseek-ai/dsh-mcp-client");
		expect(entry?.config?.serverName).toBe("memory-master");
		expect(entry?.config?.transport).toBe("stdio");
		expect((entry?.config?.env as Record<string, string>)?.MEMORY_MASTER_TOKEN).toBe("mm_test_dsh");

		const agents = await readFile(join(home, ".dsh", "AGENTS.md"), "utf8");
		expect(agents).toContain("<!-- memory-master:begin -->");
		expect(await Bun.file(join(home, ".dsh", "skills", "memory-master", "SKILL.md")).exists()).toBe(true);
	});

	it("appends after existing user entries and reinstall never duplicates", async () => {
		await Bun.write(patchPath(), "- insert:\n  - id: user-plugin\n    name: '@acme/plugin'\n");
		expect((await install("dsh")).ok).toBe(true);
		expect((await install("dsh")).ok).toBe(true);

		const text = await readFile(patchPath(), "utf8");
		expect(text).toContain("user-plugin");
		expect((text.match(/mcp-memory-master/g) ?? []).length).toBe(1);
		const parsed = Bun.YAML.parse(text) as unknown[];
		expect(parsed.length).toBe(2);
	});

	it("refuses a hand-written memory-master entry and a non-list top level", async () => {
		await Bun.write(patchPath(), "- insert:\n  - id: mcp-memory-master\n    name: '@acme/mine'\n");
		const dup = await install("dsh");
		expect(dup.ok).toBe(false);
		expect(dup.error).toContain("memory-master");
		expect(await readFile(patchPath(), "utf8")).toContain("@acme/mine");

		await Bun.write(patchPath(), "key: value\n");
		const notList = await install("dsh");
		expect(notList.ok).toBe(false);
		expect(notList.error).toContain("patch list");
	});
});

describe("harness detection", () => {
	it("reports undetected without config dirs, detected once they exist", async () => {
		expect(clientDetected("devin")).toBe(false);
		expect(clientDetected("cursor")).toBe(false);
		expect(clientDetected("dsh")).toBe(false);
		await install("devin");
		expect(clientDetected("devin")).toBe(true);
		await install("dsh");
		expect(clientDetected("dsh")).toBe(true);
	});
});
