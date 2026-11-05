import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CODEX_TOML_BEGIN,
	CODEX_TOML_END,
	instructionBlock,
	MANAGED_BEGIN,
	MANAGED_END,
	SKILL_FILES,
} from "./agent-content.ts";
import type { LibraryClientId } from "./types.ts";

/**
 * One-click client setup (Phase 4): enabling a client installs everything the
 * client needs to reach this service — its MCP server entry, the user-level
 * instruction block, and the collaboration skill — while preserving content
 * the user already has (JSON merge, marker-guarded blocks only).
 *
 * Each harness is described by a ClientFiles record: where its MCP server
 * config lives and in which format, where user-level instructions go, and
 * where skills are discovered. Adding a harness means adding one record in
 * clientFiles() plus (only when it speaks a new config format) an installer.
 *
 * Client config roots default to the real home directory; tests redirect the
 * whole family with MEMORY_MASTER_CLIENT_HOME so nothing touches the user's
 * actual config files. The harnesses' own relocation envs (CLAUDE_CONFIG_DIR,
 * CODEX_HOME, OPENCODE_CONFIG_DIR, HERMES_HOME) are honored where they exist.
 */

export interface BridgeConfig {
	command: string;
	args: string[];
	env: { MEMORY_MASTER_URL: string; MEMORY_MASTER_TOKEN: string };
}

/** The bridge launch spec embedded into each client's MCP config. */
export function bridgeConfig(serviceUrl: string, token: string): BridgeConfig {
	// Dev: process.execPath = the bun binary and the repo's cli.ts is a real
	// file → `bun /abs/cli.ts bridge`. Packaged (bun --compile): execPath is the
	// memaster binary itself and cli.ts only exists inside the embedded FS —
	// then the binary invokes its own `bridge` subcommand with no script arg.
	const scriptPath = resolve(import.meta.dir, "..", "cli.ts");
	return {
		command: process.execPath,
		args: existsSync(scriptPath) ? [scriptPath, "bridge"] : ["bridge"],
		env: { MEMORY_MASTER_URL: serviceUrl, MEMORY_MASTER_TOKEN: token },
	};
}

function home(): string {
	return process.env.MEMORY_MASTER_CLIENT_HOME ?? homedir();
}

/** XDG config root (~/.config on POSIX, %APPDATA% on Windows). */
function configHome(): string {
	if (process.platform === "win32") {
		return process.env.APPDATA ?? join(home(), "AppData", "Roaming");
	}
	return process.env.XDG_CONFIG_HOME ?? join(home(), ".config");
}

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(home(), ".claude");
}

function codexDir(): string {
	return process.env.CODEX_HOME ?? join(home(), ".codex");
}

function opencodeDir(): string {
	return process.env.OPENCODE_CONFIG_DIR ?? join(configHome(), "opencode");
}

function hermesDir(): string {
	return process.env.HERMES_HOME ?? join(home(), ".hermes");
}

function dshDir(): string {
	return process.env.DSH_HOME ?? join(home(), ".dsh");
}

/**
 * How the harness declares a stdio MCP server in its own config format.
 *  - json:     {"mcpServers": {"memory-master": {command, args, env}}}
 *  - toml:     marked [mcp_servers.memory-master] block (Codex)
 *  - opencode: {"mcp": {"memory-master": {type:"local", command:[...], environment:{}}}}
 *  - yaml:     mcp_servers.memory-master mapping inside config.yaml (Hermes);
 *              the token lives in envPath (.env) and is referenced as ${VAR}
 *  - cordis-patch: an `- insert:` entry appended to $DSH_HOME/cordis.patch.yml
 *              (DeepSeek Harness; the home-level patch applies to every profile)
 */
export type McpTarget =
	| { kind: "json"; configPath: string }
	| { kind: "toml"; configPath: string }
	| { kind: "opencode"; configPath: string }
	| { kind: "yaml"; configPath: string; envPath: string }
	| { kind: "cordis-patch"; configPath: string };

export interface ClientFiles {
	mcp: McpTarget;
	instructionsPath: string;
	/**
	 * Content written before the managed block when the instructions file is
	 * created — e.g. Cursor .mdc rules want a frontmatter header to apply.
	 */
	instructionsPrefix?: string;
	skillPath: string;
	/** Existence of any of these marks the harness as installed on this machine. */
	detectPaths: string[];
}

export function clientFiles(clientId: LibraryClientId): ClientFiles {
	switch (clientId) {
		case "claude-code":
			return {
				// ~/.claude.json lives at the home root even when CLAUDE_CONFIG_DIR moves .claude/.
				mcp: { kind: "json", configPath: join(home(), ".claude.json") },
				instructionsPath: join(claudeDir(), "CLAUDE.md"),
				skillPath: join(claudeDir(), "skills", "memory-master", "SKILL.md"),
				detectPaths: [join(home(), ".claude"), join(home(), ".claude.json")],
			};
		case "codex":
			return {
				mcp: { kind: "toml", configPath: join(codexDir(), "config.toml") },
				instructionsPath: join(codexDir(), "AGENTS.md"),
				// Codex discovers skills as <name>/SKILL.md; ~/.agents/skills is the
				// canonical user-scope location current Codex reads.
				skillPath: join(home(), ".agents", "skills", "memory-master", "SKILL.md"),
				detectPaths: [codexDir()],
			};
		case "devin":
			return {
				mcp: { kind: "json", configPath: join(configHome(), "devin", "mcp_config.json") },
				instructionsPath: join(configHome(), "devin", "AGENTS.md"),
				skillPath: join(configHome(), "devin", "skills", "memory-master", "SKILL.md"),
				detectPaths: detect([join(configHome(), "devin"), "/Applications/Devin.app"]),
			};
		case "cursor":
			return {
				mcp: { kind: "json", configPath: join(home(), ".cursor", "mcp.json") },
				// User-level rules are individual .mdc files — the whole file is
				// ours, so the managed block just happens to fill it. The
				// frontmatter makes Cursor apply it in every conversation.
				instructionsPath: join(home(), ".cursor", "rules", "memory-master.mdc"),
				instructionsPrefix:
					"---\ndescription: Memory Master 协作规则 —— 打开项目、维护进展与任务\nalwaysApply: true\n---\n",
				skillPath: join(home(), ".cursor", "skills", "memory-master", "SKILL.md"),
				detectPaths: detect([join(home(), ".cursor"), "/Applications/Cursor.app"]),
			};
		case "opencode":
			return {
				mcp: { kind: "opencode", configPath: join(opencodeDir(), "opencode.json") },
				instructionsPath: join(opencodeDir(), "AGENTS.md"),
				skillPath: join(opencodeDir(), "skills", "memory-master", "SKILL.md"),
				detectPaths: [opencodeDir(), join(home(), ".local", "bin", "opencode")],
			};
		case "hermes":
			return {
				mcp: {
					kind: "yaml",
					configPath: join(hermesDir(), "config.yaml"),
					envPath: join(hermesDir(), ".env"),
				},
				instructionsPath: join(hermesDir(), "SOUL.md"),
				skillPath: join(hermesDir(), "skills", "memory-master", "SKILL.md"),
				detectPaths: [hermesDir(), join(home(), ".local", "bin", "hermes")],
			};
		case "dsh":
			return {
				mcp: { kind: "cordis-patch", configPath: join(dshDir(), "cordis.patch.yml") },
				// dsh-agent-instructions reads the user-global chain
				// $DSH_HOME/AGENTS.md → ~/.agents/AGENTS.md, then project files.
				instructionsPath: join(dshDir(), "AGENTS.md"),
				// dsh-skill-filesystem scans <dshHome>/skills as the user-dsh root.
				skillPath: join(dshDir(), "skills", "memory-master", "SKILL.md"),
				detectPaths: detect([
					dshDir(),
					join(home(), ".local", "bin", "dsh"),
					"/opt/homebrew/bin/dsh",
					"/usr/local/bin/dsh",
				]),
			};
	}
}

/**
 * System-level paths (app bundles outside $HOME) count toward detection in a
 * real environment but not under MEMORY_MASTER_CLIENT_HOME — tests redirect
 * home and must not see the developer's real /Applications.
 */
function detect(paths: string[]): string[] {
	return process.env.MEMORY_MASTER_CLIENT_HOME ? paths.filter((p) => p.startsWith(home())) : paths;
}

/** A harness is considered installed when any of its well-known paths exists. */
export function clientDetected(clientId: LibraryClientId): boolean {
	return clientFiles(clientId).detectPaths.some((p) => existsSync(p));
}

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
	// Mode applies at creation — the tmp file (which may carry a token) is
	// never briefly world-readable before a chmod lands.
	await writeFile(tmp, content, mode !== undefined ? { encoding: "utf8", mode } : "utf8");
	await rename(tmp, path);
}

/**
 * Replace the marked section if present; otherwise append it. A BEGIN marker
 * without its END is a corrupted managed block — refuse rather than append a
 * second copy (in TOML a duplicated table would corrupt the whole file).
 */
export function upsertMarkedBlock(content: string, begin: string, end: string, block: string): string {
	const start = content.indexOf(begin);
	if (start !== -1) {
		const stop = content.indexOf(end, start);
		if (stop === -1) {
			throw new Error(
				`Found "${begin}" without the closing "${end}" marker. Delete the section between those markers and retry.`,
			);
		}
		return `${content.slice(0, start)}${block}${content.slice(stop + end.length)}`;
	}
	const sep = content.trimEnd() ? "\n\n" : "";
	return `${content.trimEnd()}${sep}${block}\n`;
}

async function readTextIfExists(path: string): Promise<string> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw error;
	}
}

/** Merge our server entry into a {"mcpServers": {...}} JSON file without touching other keys. */
async function installJsonMcpConfig(configPath: string, config: BridgeConfig): Promise<string[]> {
	let parsed: Record<string, unknown> = {};
	const text = await readTextIfExists(configPath);
	if (text.trim()) {
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error(`Cannot parse ${configPath}: ${error.message}`);
			}
			throw error;
		}
	}
	const existing = parsed.mcpServers;
	const mcpServers =
		typeof existing === "object" && existing !== null && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	mcpServers["memory-master"] = config;
	parsed.mcpServers = mcpServers;
	await writeAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
	return [configPath];
}

/**
 * OpenCode keeps MCP servers under top-level "mcp", with the command as one
 * array and env under "environment" — a different shape from mcpServers.
 * opencode.jsonc may carry comments, which JSON.parse rejects: report that
 * clearly instead of corrupting a hand-maintained file.
 */
async function installOpencodeMcpConfig(configPath: string, config: BridgeConfig): Promise<string[]> {
	let parsed: Record<string, unknown> = {};
	const text = await readTextIfExists(configPath);
	if (text.trim()) {
		try {
			parsed = JSON.parse(text) as Record<string, unknown>;
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error(
					`Cannot parse ${configPath} — it may be JSONC (comments) or malformed. ` +
						`Add the memory-master entry under the "mcp" key manually (\`memaster connect opencode\` prints it).`,
				);
			}
			throw error;
		}
	}
	const existing = parsed.mcp;
	const mcp =
		typeof existing === "object" && existing !== null && !Array.isArray(existing)
			? (existing as Record<string, unknown>)
			: {};
	mcp["memory-master"] = {
		type: "local",
		command: [config.command, ...config.args],
		enabled: true,
		environment: { ...config.env },
	};
	parsed.mcp = mcp;
	await writeAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
	return [configPath];
}

/** The TOML block written between the markers — shared by installer and `connect`. */
export function codexTomlBlock(config: BridgeConfig): string {
	return `${CODEX_TOML_BEGIN}
[mcp_servers.memory-master]
command = ${JSON.stringify(config.command)}
args = ${JSON.stringify(config.args)}
env = { MEMORY_MASTER_URL = ${JSON.stringify(config.env.MEMORY_MASTER_URL)}, MEMORY_MASTER_TOKEN = ${JSON.stringify(config.env.MEMORY_MASTER_TOKEN)} }
${CODEX_TOML_END}`;
}

const CODEX_SERVER_TABLE = /^\s*\[mcp_servers\.memory-master\]\s*$/m;

/**
 * Marker-guarded [mcp_servers.memory-master] block for Codex config.toml.
 * Hard rules: a same-name table outside the markers or a corrupted managed
 * block is REFUSED (a duplicated TOML table would corrupt the whole config),
 * and the result is TOML-validated before it touches disk.
 */
async function installCodexConfig(config: BridgeConfig, configPath: string): Promise<string[]> {
	const content = await readTextIfExists(configPath);
	const begin = content.indexOf(CODEX_TOML_BEGIN);
	const end = begin === -1 ? -1 : content.indexOf(CODEX_TOML_END, begin);
	const outside =
		begin === -1 ? content : content.slice(0, begin) + (end === -1 ? "" : content.slice(end + CODEX_TOML_END.length));
	if (CODEX_SERVER_TABLE.test(outside)) {
		throw new Error(
			`${configPath} already has a [mcp_servers.memory-master] table outside the managed block. Remove it (or let \`codex mcp remove memory-master\` clean it) and retry.`,
		);
	}
	const next = upsertMarkedBlock(content, CODEX_TOML_BEGIN, CODEX_TOML_END, codexTomlBlock(config));
	try {
		Bun.TOML.parse(next);
	} catch (error) {
		throw new Error(
			`Refusing to write ${configPath}: merged result is not valid TOML (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	await writeAtomic(configPath, next, 0o600);
	return [configPath];
}

const YAML_MARK_BEGIN = "# >>> memory-master >>>";
const YAML_MARK_END = "# <<< memory-master <<<";
const YAML_SECTION_KEY = /^mcp_servers\s*:(.*)$/;

/** The managed block: only the memory-master entry, indented under mcp_servers. */
function yamlEntryBlock(config: BridgeConfig, indent: string): string {
	const args = `[${config.args.map((a) => JSON.stringify(a)).join(", ")}]`;
	return `${indent}${YAML_MARK_BEGIN}
${indent}memory-master:
${indent}  command: ${JSON.stringify(config.command)}
${indent}  args: ${args}
${indent}  env:
${indent}    MEMORY_MASTER_URL: "\${MEMORY_MASTER_URL}"
${indent}    MEMORY_MASTER_TOKEN: "\${MEMORY_MASTER_TOKEN}"
${indent}${YAML_MARK_END}`;
}

/** The .env block hermes resolves ${VAR} from at startup — holds the credential. */
function hermesEnvBlock(env: BridgeConfig["env"]): string {
	return `${YAML_MARK_BEGIN}
MEMORY_MASTER_URL=${env.MEMORY_MASTER_URL}
MEMORY_MASTER_TOKEN=${env.MEMORY_MASTER_TOKEN}
${YAML_MARK_END}`;
}

/**
 * Hermes config.yaml is user-maintained and heavily commented — parse-rewrite
 * would destroy comments, so the entry is spliced in textually instead:
 *
 *  - a marked `memory-master:` entry inside the existing `mcp_servers:` map,
 *    or `mcp_servers:` + entry appended when the key is absent;
 *  - a hand-written memory-master entry outside the markers, an unmigrated
 *    flow-style `mcp_servers: {...}` value, or a corrupted marked block is
 *    REFUSED rather than guessed at (a duplicated YAML key silently wins);
 *  - the result must parse as YAML and expose mcp_servers.memory-master
 *    before it touches disk;
 *  - the credential goes to ~/.hermes/.env and is referenced as ${VAR}, so
 *    config.yaml stays free of secrets.
 */
async function installHermesConfig(config: BridgeConfig, configPath: string, envPath: string): Promise<string[]> {
	const installed: string[] = [];
	const content = await readTextIfExists(configPath);
	let next: string;
	if (content.includes(YAML_MARK_BEGIN)) {
		// Re-install: replace the managed entry wherever it sits.
		next = upsertMarkedBlock(content, YAML_MARK_BEGIN, YAML_MARK_END, yamlEntryBlock(config, "  "));
	} else {
		const lines = content.split("\n");
		const keyIdx = lines.findIndex((l) => YAML_SECTION_KEY.test(l));
		if (keyIdx === -1) {
			// No mcp_servers key at all — append the whole section at EOF.
			const section = `mcp_servers:\n${yamlEntryBlock(config, "  ")}`;
			const sep = content.trimEnd() ? "\n\n" : "";
			next = `${content.trimEnd()}${sep}${section}\n`;
		} else {
			// `mcp_servers:  # comment` is still an empty value — strip comments.
			const inlineValue = ((lines[keyIdx] ?? "").match(YAML_SECTION_KEY)?.[1] ?? "").replace(/#.*$/, "").trim();
			if (inlineValue && inlineValue !== "{}" && inlineValue !== "null" && inlineValue !== "~") {
				throw new Error(
					`${configPath} declares mcp_servers in flow style (${inlineValue.slice(0, 40)}…). ` +
						"Expand it to a block mapping manually, then retry.",
				);
			}
			// Guard against a hand-written duplicate entry inside the map.
			const blockEnd = lines.findIndex(
				(l, i) => i > keyIdx && l.trim() !== "" && !l.trimStart().startsWith("#") && !/^\s/.test(l),
			);
			const sectionLines = lines.slice(keyIdx + 1, blockEnd === -1 ? lines.length : blockEnd);
			if (sectionLines.some((l) => /^\s+memory-master\s*:/.test(l))) {
				throw new Error(
					`${configPath} already has a memory-master entry under mcp_servers outside the managed block. Remove it and retry.`,
				);
			}
			if (inlineValue === "{}") lines[keyIdx] = "mcp_servers:";
			lines.splice(keyIdx + 1, 0, yamlEntryBlock(config, "  "));
			next = lines.join("\n");
		}
	}
	let parsedYaml: unknown;
	try {
		parsedYaml = Bun.YAML.parse(next);
	} catch (error) {
		throw new Error(
			`Refusing to write ${configPath}: merged result is not valid YAML (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const servers = (parsedYaml as Record<string, unknown> | null)?.mcp_servers;
	if (typeof servers !== "object" || servers === null || !("memory-master" in (servers as Record<string, unknown>))) {
		throw new Error(`Refusing to write ${configPath}: merged result does not contain mcp_servers.memory-master.`);
	}
	await writeAtomic(configPath, next, 0o600);
	installed.push(configPath);

	// .env lands only after the YAML that references it — a failed splice
	// must not leave a credential in a file the config never asked about.
	const envContent = await readTextIfExists(envPath);
	const nextEnv = upsertMarkedBlock(envContent, YAML_MARK_BEGIN, YAML_MARK_END, hermesEnvBlock(config.env));
	await writeAtomic(envPath, nextEnv, 0o600);
	installed.push(envPath);
	return installed;
}

const CORDIS_MARK_BEGIN = "# >>> memory-master >>>";
const CORDIS_MARK_END = "# <<< memory-master <<<";

/**
 * The managed block appended to cordis.patch.yml — a top-level YAML array of
 * loader patch entries. Ours inserts one dsh-mcp-client plugin instance; the
 * plugin resolves from the dsh install, no profile dependency needed.
 */
export function cordisPatchBlock(config: BridgeConfig): string {
	const args = config.args.map((a) => `        - ${JSON.stringify(a)}`).join("\n");
	return `${CORDIS_MARK_BEGIN}
- insert:
  - id: mcp-memory-master
    name: "@deepseek-ai/dsh-mcp-client"
    config:
      serverName: memory-master
      transport: stdio
      command: ${JSON.stringify(config.command)}
      args:
${args}
      env:
        MEMORY_MASTER_URL: ${JSON.stringify(config.env.MEMORY_MASTER_URL)}
        MEMORY_MASTER_TOKEN: ${JSON.stringify(config.env.MEMORY_MASTER_TOKEN)}
${CORDIS_MARK_END}`;
}

/** The merged file must stay a patch list that still carries our insert. */
function assertCordisMerge(next: string, configPath: string): void {
	let parsed: unknown;
	try {
		parsed = Bun.YAML.parse(next);
	} catch (error) {
		throw new Error(
			`Refusing to write ${configPath}: merged result is not valid YAML (${error instanceof Error ? error.message : String(error)}).`,
		);
	}
	const found =
		Array.isArray(parsed) &&
		parsed.some(
			(entry) =>
				typeof entry === "object" &&
				entry !== null &&
				Array.isArray((entry as Record<string, unknown>).insert) &&
				((entry as Record<string, unknown>).insert as unknown[]).some(
					(i) => typeof i === "object" && i !== null && (i as Record<string, unknown>).id === "mcp-memory-master",
				),
		);
	if (!found) {
		throw new Error(`Refusing to write ${configPath}: merged result lost the mcp-memory-master insert.`);
	}
}

/**
 * dsh cordis.patch.yml is a user-owned YAML patch list. A hand-written
 * memory-master entry outside the markers is refused (a duplicate serverName
 * fails the later plugin instance), a top level that is not an array is
 * refused, and the shipped default `[]` is replaced rather than appended to —
 * a flow empty list cannot host block items.
 */
async function installCordisPatchConfig(configPath: string, config: BridgeConfig): Promise<string[]> {
	const content = await readTextIfExists(configPath);
	let next: string;
	if (content.includes(CORDIS_MARK_BEGIN)) {
		next = upsertMarkedBlock(content, CORDIS_MARK_BEGIN, CORDIS_MARK_END, cordisPatchBlock(config));
	} else {
		if (/\bmcp-memory-master\b/.test(content) || /serverName\s*:\s*["']?memory-master\b/.test(content)) {
			throw new Error(
				`${configPath} already declares a memory-master entry outside the managed block. Remove it and retry.`,
			);
		}
		let parsedOriginal: unknown;
		try {
			parsedOriginal = Bun.YAML.parse(content);
		} catch (error) {
			throw new Error(
				`Cannot parse ${configPath} (${error instanceof Error ? error.message : String(error)}). ` +
					"Add the insert entry manually (`memaster connect dsh` prints it).",
			);
		}
		if (parsedOriginal != null && !Array.isArray(parsedOriginal)) {
			throw new Error(
				`${configPath} is not a patch list (its top level must be a YAML array). Fix it manually and retry.`,
			);
		}
		// A lone `[]` can't host block items — drop it, keep the comments.
		const nonComment = content
			.split("\n")
			.filter((l) => {
				const t = l.trim();
				return t !== "" && !t.startsWith("#");
			})
			.join("\n")
			.trim();
		const base = nonComment === "[]" ? content.replace(/\[\]/, "") : content;
		const sep = base.trimEnd() ? "\n\n" : "";
		next = `${base.trimEnd()}${sep}${cordisPatchBlock(config)}\n`;
	}
	assertCordisMerge(next, configPath);
	await writeAtomic(configPath, next, 0o600);
	return [configPath];
}

async function installMcpConfig(files: ClientFiles, config: BridgeConfig): Promise<string[]> {
	switch (files.mcp.kind) {
		case "json":
			return installJsonMcpConfig(files.mcp.configPath, config);
		case "toml":
			return installCodexConfig(config, files.mcp.configPath);
		case "opencode":
			return installOpencodeMcpConfig(files.mcp.configPath, config);
		case "yaml":
			return installHermesConfig(config, files.mcp.configPath, files.mcp.envPath);
		case "cordis-patch":
			return installCordisPatchConfig(files.mcp.configPath, config);
	}
}

async function installInstructions(clientId: LibraryClientId, serviceUrl: string): Promise<string[]> {
	const { instructionsPath, instructionsPrefix } = clientFiles(clientId);
	const block = instructionBlock(serviceUrl);
	let content = await readTextIfExists(instructionsPath);
	if (!content && instructionsPrefix) content = instructionsPrefix;
	await writeAtomic(instructionsPath, upsertMarkedBlock(content, MANAGED_BEGIN, MANAGED_END, block));
	return [instructionsPath];
}

/**
 * The skill is a directory, not a single file: SKILL.md's relative links
 * (content standard, architecture format, upstream license) only resolve if
 * every file in SKILL_FILES lands next to it.
 */
async function installSkill(clientId: LibraryClientId): Promise<string[]> {
	const { skillPath } = clientFiles(clientId);
	const installed: string[] = [];
	for (const [name, content] of Object.entries(SKILL_FILES)) {
		const path = join(dirname(skillPath), name);
		await writeAtomic(path, content);
		installed.push(path);
	}
	return installed;
}

export interface InstallResult {
	ok: boolean;
	installed: string[];
	error?: string;
}

/**
 * Install (or repair) everything a client needs. Idempotent: re-running
 * replaces only our own entries and never duplicates. A partial failure
 * reports which step failed and leaves already-installed pieces in place —
 * the next retry converges.
 */
export async function installClient(
	clientId: LibraryClientId,
	opts: { serviceUrl: string; token: string },
): Promise<InstallResult> {
	const files = clientFiles(clientId);
	const config = bridgeConfig(opts.serviceUrl, opts.token);
	const installed: string[] = [];
	const mcpPath = files.mcp.kind === "yaml" ? `${files.mcp.configPath} + ${files.mcp.envPath}` : files.mcp.configPath;
	let step = `MCP configuration (${mcpPath})`;
	try {
		installed.push(...(await installMcpConfig(files, config)));
		step = `instructions (${files.instructionsPath})`;
		installed.push(...(await installInstructions(clientId, opts.serviceUrl)));
		step = `skill (${files.skillPath})`;
		installed.push(...(await installSkill(clientId)));
		return { ok: true, installed };
	} catch (error) {
		return {
			ok: false,
			installed,
			error: `Failed to install ${step}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * The paste-able form of a client's MCP entry for `memaster connect <client>`
 * — the same spec the installer writes, for manual or foreign setups.
 */
export function connectSnippet(clientId: LibraryClientId, config: BridgeConfig): string {
	const files = clientFiles(clientId);
	switch (files.mcp.kind) {
		case "toml":
			return codexTomlBlock(config);
		case "opencode":
			return JSON.stringify(
				{
					mcp: {
						"memory-master": {
							type: "local",
							command: [config.command, ...config.args],
							enabled: true,
							environment: config.env,
						},
					},
				},
				null,
				2,
			);
		case "yaml":
			return [
				`# ${files.mcp.configPath}`,
				`mcp_servers:\n${yamlEntryBlock(config, "  ")}`,
				"",
				`# ${files.mcp.envPath}`,
				`MEMORY_MASTER_URL=${config.env.MEMORY_MASTER_URL}`,
				`MEMORY_MASTER_TOKEN=${config.env.MEMORY_MASTER_TOKEN}`,
			].join("\n");
		case "cordis-patch":
			return [`# ${files.mcp.configPath}`, cordisPatchBlock(config)].join("\n");
		case "json":
			return JSON.stringify({ mcpServers: { "memory-master": config } }, null, 2);
	}
}
