import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	CODEX_TOML_BEGIN,
	CODEX_TOML_END,
	instructionBlock,
	MANAGED_BEGIN,
	MANAGED_END,
	SKILL_MD,
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
 * actual ~/.claude* or ~/.codex* files.
 */

export interface BridgeConfig {
	command: string;
	args: string[];
	env: { MEMORY_MASTER_URL: string; MEMORY_MASTER_TOKEN: string };
}

/** The bridge launch spec embedded into each client's MCP config. */
export function bridgeConfig(serviceUrl: string, token: string): BridgeConfig {
	return {
		// Absolute paths — works whether `memaster` is on PATH or not, and in the
		// packaged app the same pair (runtime + entry script) still applies.
		command: process.execPath,
		args: [resolve(import.meta.dir, "..", "cli.ts"), "bridge"],
		env: { MEMORY_MASTER_URL: serviceUrl, MEMORY_MASTER_TOKEN: token },
	};
}

function clientHome(): string {
	return process.env.MEMORY_MASTER_CLIENT_HOME ?? homedir();
}

interface ClientFiles {
	configPath: string;
	instructionsPath: string;
	skillPath: string;
}

function clientFiles(clientId: LibraryClientId): ClientFiles {
	const home = clientHome();
	if (clientId === "claude-code") {
		return {
			configPath: join(home, ".claude.json"),
			instructionsPath: join(home, ".claude", "CLAUDE.md"),
			skillPath: join(home, ".claude", "skills", "memory-master", "SKILL.md"),
		};
	}
	return {
		configPath: join(home, ".codex", "config.toml"),
		instructionsPath: join(home, ".codex", "AGENTS.md"),
		skillPath: join(home, ".codex", "skills", "memory-master.md"),
	};
}

async function writeAtomic(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}`;
	await writeFile(tmp, content, "utf8");
	if (mode !== undefined) await chmod(tmp, mode);
	await rename(tmp, path);
}

/** Replace the marked section if present; otherwise append it. */
export function upsertMarkedBlock(content: string, begin: string, end: string, block: string): string {
	const start = content.indexOf(begin);
	if (start !== -1) {
		const stop = content.indexOf(end, start);
		if (stop !== -1) {
			return `${content.slice(0, start)}${block}${content.slice(stop + end.length)}`;
		}
	}
	const sep = content.trimEnd() ? "\n\n" : "";
	return `${content.trimEnd()}${sep}${block}\n`;
}

/** Merge our server entry into ~/.claude.json without touching other keys. */
async function installClaudeConfig(config: BridgeConfig): Promise<string[]> {
	const { configPath } = clientFiles("claude-code");
	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw new Error(`Cannot parse ${configPath}: ${(error as Error).message}`);
		}
	}
	const mcpServers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
	mcpServers["memory-master"] = config;
	parsed.mcpServers = mcpServers;
	await writeAtomic(configPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
	return [configPath];
}

/** Marker-guarded [mcp_servers.memory-master] block for Codex config.toml. */
async function installCodexConfig(config: BridgeConfig): Promise<string[]> {
	const { configPath } = clientFiles("codex");
	const block = `${CODEX_TOML_BEGIN}
[mcp_servers.memory-master]
command = ${JSON.stringify(config.command)}
args = ${JSON.stringify(config.args)}
env = { MEMORY_MASTER_URL = ${JSON.stringify(config.env.MEMORY_MASTER_URL)}, MEMORY_MASTER_TOKEN = ${JSON.stringify(config.env.MEMORY_MASTER_TOKEN)} }
${CODEX_TOML_END}`;
	let content = "";
	try {
		content = await readFile(configPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await writeAtomic(configPath, upsertMarkedBlock(content, CODEX_TOML_BEGIN, CODEX_TOML_END, block), 0o600);
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

async function installSkill(clientId: LibraryClientId): Promise<string[]> {
	const { skillPath } = clientFiles(clientId);
	await writeAtomic(skillPath, SKILL_MD);
	return [skillPath];
}

export interface InstallResult {
	ok: boolean;
	installed: string[];
	error?: string;
}

/**
 * Install (or repair) everything a client needs. Idempotent: re-running
 * replaces only our own entries and never duplicates. A partial failure
 * reports the error and leaves already-installed pieces in place — the next
 * retry converges.
 */
export async function installClient(
	clientId: LibraryClientId,
	opts: { serviceUrl: string; token: string },
): Promise<InstallResult> {
	const files = clientFiles(clientId);
	const config = bridgeConfig(opts.serviceUrl, opts.token);
	const installed: string[] = [];
	try {
		installed.push(
			...(clientId === "claude-code" ? await installClaudeConfig(config) : await installCodexConfig(config)),
		);
		installed.push(...(await installInstructions(clientId, opts.serviceUrl)));
		installed.push(...(await installSkill(clientId)));
		return { ok: true, installed };
	} catch (error) {
		return {
			ok: false,
			installed,
			error: `Failed to configure ${clientId} at ${files.configPath}: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
