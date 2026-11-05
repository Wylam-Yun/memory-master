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
 * Client config roots default to the real home directory; tests redirect the
 * whole family with MEMORY_MASTER_CLIENT_HOME so nothing touches the user's
 * actual ~/.claude* or ~/.codex* files. CLAUDE_CONFIG_DIR / CODEX_HOME are
 * honored for the relocated-config crowd.
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

function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(home(), ".claude");
}

function codexDir(): string {
	return process.env.CODEX_HOME ?? join(home(), ".codex");
}

interface ClientFiles {
	configPath: string;
	instructionsPath: string;
	skillPath: string;
}

function clientFiles(clientId: LibraryClientId): ClientFiles {
	if (clientId === "claude-code") {
		return {
			// ~/.claude.json lives at the home root even when CLAUDE_CONFIG_DIR moves .claude/.
			configPath: join(home(), ".claude.json"),
			instructionsPath: join(claudeDir(), "CLAUDE.md"),
			skillPath: join(claudeDir(), "skills", "memory-master", "SKILL.md"),
		};
	}
	return {
		configPath: join(codexDir(), "config.toml"),
		instructionsPath: join(codexDir(), "AGENTS.md"),
		// Codex discovers skills as <name>/SKILL.md; ~/.agents/skills is the
		// canonical user-scope location current Codex reads.
		skillPath: join(home(), ".agents", "skills", "memory-master", "SKILL.md"),
	};
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

/** The TOML block written between the markers — shared by installer and `connect`. */
export function codexTomlBlock(config: BridgeConfig): string {
	return `${CODEX_TOML_BEGIN}
[mcp_servers.memory-master]
command = ${JSON.stringify(config.command)}
args = ${JSON.stringify(config.args)}
env = { MEMORY_MASTER_URL = ${JSON.stringify(config.env.MEMORY_MASTER_URL)}, MEMORY_MASTER_TOKEN = ${JSON.stringify(config.env.MEMORY_MASTER_TOKEN)} }
${CODEX_TOML_END}`;
}

/** Merge our server entry into ~/.claude.json without touching other keys. */
async function installClaudeConfig(config: BridgeConfig): Promise<string[]> {
	const { configPath } = clientFiles("claude-code");
	let parsed: Record<string, unknown> = {};
	try {
		const text = await readFile(configPath, "utf8");
		parsed = text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			parsed = {};
		} else if (error instanceof SyntaxError) {
			throw new Error(`Cannot parse ${configPath}: ${error.message}`);
		} else {
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

const CODEX_SERVER_TABLE = /^\s*\[mcp_servers\.memory-master\]\s*$/m;

/**
 * Marker-guarded [mcp_servers.memory-master] block for Codex config.toml.
 * Hard rules: a same-name table outside the markers or a corrupted managed
 * block is REFUSED (a duplicated TOML table would corrupt the whole config),
 * and the result is TOML-validated before it touches disk.
 */
async function installCodexConfig(config: BridgeConfig): Promise<string[]> {
	const { configPath } = clientFiles("codex");
	let content = "";
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
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

async function installInstructions(clientId: LibraryClientId, serviceUrl: string): Promise<string[]> {
	const { instructionsPath } = clientFiles(clientId);
	const block = instructionBlock(serviceUrl);
	let content = "";
	try {
		content = await readFile(instructionsPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
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
	let step = `MCP configuration (${files.configPath})`;
	try {
		installed.push(
			...(clientId === "claude-code" ? await installClaudeConfig(config) : await installCodexConfig(config)),
		);
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
