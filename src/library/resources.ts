import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { LIBRARY_ERROR_CODES, LibraryError } from "./types.ts";

/**
 * 项目资料 (uploaded resources): user-provided original files stored under the
 * project's `资料/` directory. Agents see the manifest (list) and read files
 * on demand; uploads are a web-channel (user) action. Files carry no version —
 * there is no update path, only upload → list → read.
 */

export const RESOURCE_DIR_NAME = "资料";
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;

export interface ResourceInfo {
	name: string;
	size: number;
	modifiedAt: string;
}

export function resourcesDir(projectDir: string): string {
	return join(projectDir, RESOURCE_DIR_NAME);
}

/** Names must be plain basenames — no traversal, no hidden files, no nested paths. */
export function assertSafeResourceName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed || trimmed !== basename(trimmed) || trimmed.startsWith(".")) {
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, `Invalid resource name "${name}".`, 400);
	}
	return trimmed;
}

export async function saveResource(projectDir: string, name: string, bytes: Uint8Array): Promise<ResourceInfo> {
	const safe = assertSafeResourceName(name);
	if (bytes.byteLength > MAX_RESOURCE_BYTES) {
		throw new LibraryError(
			LIBRARY_ERROR_CODES.VALIDATION,
			`Resource "${safe}" exceeds the ${Math.floor(MAX_RESOURCE_BYTES / 1024 / 1024)}MB limit.`,
			413,
		);
	}
	const dir = resourcesDir(projectDir);
	await mkdir(dir, { recursive: true });
	await Bun.write(join(dir, safe), bytes);
	const info = await stat(join(dir, safe));
	return { name: safe, size: info.size, modifiedAt: info.mtime.toISOString() };
}

export async function listResources(projectDir: string): Promise<ResourceInfo[]> {
	const dir = resourcesDir(projectDir);
	const out: ResourceInfo[] = [];
	try {
		for (const name of await readdir(dir)) {
			if (name.startsWith(".")) continue;
			const filePath = join(dir, name);
			const info = await stat(filePath).catch(() => null);
			if (info?.isFile()) out.push({ name, size: info.size, modifiedAt: info.mtime.toISOString() });
		}
	} catch {}
	return out.sort((a, b) => a.name.localeCompare(b.name));
}

const TEXT_EXTENSIONS = new Set([
	".md",
	".txt",
	".csv",
	".json",
	".yaml",
	".yml",
	".xml",
	".html",
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".toml",
	".ini",
	".log",
	".sh",
	".sql",
	".svg",
]);

export interface ResourceContent {
	name: string;
	size: number;
	contentType: string;
	/** UTF-8 text when the file looks textual; otherwise base64. */
	text?: string;
	base64?: string;
}

export async function readResource(projectDir: string, name: string): Promise<ResourceContent> {
	const safe = assertSafeResourceName(name);
	const file = Bun.file(join(resourcesDir(projectDir), safe));
	if (!(await file.exists())) {
		throw new LibraryError(LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND, `Resource "${safe}" not found.`, 404);
	}
	const bytes = await file.bytes();
	if (TEXT_EXTENSIONS.has(extname(safe).toLowerCase())) {
		return {
			name: safe,
			size: bytes.byteLength,
			contentType: "text/plain; charset=utf-8",
			text: new TextDecoder().decode(bytes),
		};
	}
	return {
		name: safe,
		size: bytes.byteLength,
		contentType: file.type || "application/octet-stream",
		base64: Buffer.from(bytes).toString("base64"),
	};
}
