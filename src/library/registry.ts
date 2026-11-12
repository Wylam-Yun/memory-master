import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import Fuse from "fuse.js";
import lockfile from "proper-lockfile";
import { initializeProject } from "../core/init.ts";
import { Core } from "../core/memaster.ts";
import { initialOverviewContent, overviewFilePath, readOverview } from "./overview.ts";
import {
	LIBRARY_ERROR_CODES,
	LibraryError,
	type LibraryProject,
	projectAmbiguousError,
	projectNotFoundError,
} from "./types.ts";

/**
 * Project registry for a memory library.
 *
 * A library project is a directory containing a standard memaster/ structure
 * (filesystem_only, no git). The stable project ID lives in the project's own
 * config as `project_id`, so moving or renaming the directory never changes it.
 * Listing scans the library directory; nothing is cached outside the projects.
 */

export const RESOURCES_DIR_NAME = "资料";

function generateProjectId(): string {
	return `p_${randomBytes(5).toString("hex")}`;
}

/** Turn a display name into a safe single-level directory name (keeps CJK). */
export function sanitizeProjectDirName(name: string): string {
	const cleaned = name.replace(/[/\\:*?"<>|\s-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	return cleaned || "project";
}

function assertValidProjectName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) {
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Project name cannot be empty.", 400);
	}
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") {
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, `Invalid project name "${name}".`, 400);
	}
	if (trimmed.includes('"') || trimmed.includes("'")) {
		// config.yml serializes project_name inside quotes without escaping.
		throw new LibraryError(
			LIBRARY_ERROR_CODES.VALIDATION,
			`Project name "${name}" cannot contain quote characters.`,
			400,
		);
	}
	// config.yml is line-based — a newline would inject forged config keys.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejecting control characters
	if (/[\x00-\x1f\x7f]/.test(trimmed)) {
		throw new LibraryError(
			LIBRARY_ERROR_CODES.VALIDATION,
			`Project name "${name}" cannot contain control characters.`,
			400,
		);
	}
	return trimmed;
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function loadLibraryProject(dir: string): Promise<LibraryProject | null> {
	try {
		const core = new Core(dir, { enableWatchers: false });
		const config = await core.filesystem.loadConfig();
		if (!config?.projectName) return null;
		return {
			// Older or hand-made dirs without project_id still resolve, keyed by their dirname.
			id: config.projectId ?? `dir-${basename(dir)}`,
			name: config.projectName,
			dir,
			workingDir: config.workingDir,
		};
	} catch {
		return null;
	}
}

/** All projects in the library, sorted by name for stable display. */
export async function listProjects(libraryRoot: string): Promise<LibraryProject[]> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(libraryRoot, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const projects: LibraryProject[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const project = await loadLibraryProject(join(libraryRoot, entry.name));
		if (project) projects.push(project);
	}
	return projects.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

/**
 * Resolve a user/agent-supplied reference to exactly one project.
 * An exact match on ID, display name, or directory name opens immediately.
 * Anything fuzzier — a substring of a name or dirname — answers with the
 * candidate list instead of guessing (409), so the caller must reopen with an
 * exact reference or ID. Zero candidates → not found.
 */
export async function resolveProject(libraryRoot: string, reference: string): Promise<LibraryProject> {
	const query = reference.trim();
	if (!query) throw projectNotFoundError(reference);
	const projects = await listProjects(libraryRoot);

	const exact = projects.filter((p) => p.id === query || p.name === query || basename(p.dir) === query);
	if (exact.length === 1) return exact[0]!;
	if (exact.length > 1) throw projectAmbiguousError(query, exact);

	const fuzzy = projects.filter((p) => p.name.includes(query) || basename(p.dir).includes(query));
	if (fuzzy.length > 0) throw projectAmbiguousError(query, fuzzy);
	throw projectNotFoundError(reference);
}

/** Look up a project by its stable ID only (API path parameter resolution). */
export async function getProjectById(libraryRoot: string, id: string): Promise<LibraryProject> {
	const projects = await listProjects(libraryRoot);
	const found = projects.find((p) => p.id === id);
	if (!found) throw projectNotFoundError(id);
	return found;
}

/**
 * Create a project inside the library: its own directory with a memaster/
 * structured store (filesystem_only), an overview.md, a 资料/ directory, and a
 * stable project_id + optional working_dir in the project config.
 */
export async function createProject(
	libraryRoot: string,
	options: { name: string; workingDir?: string },
	hooks: { beforeCommit?: () => Promise<void>; onCreated?: (project: LibraryProject) => Promise<void> } = {},
): Promise<LibraryProject> {
	await mkdir(libraryRoot, { recursive: true });
	const release = await lockfile.lock(libraryRoot, { retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
	try {
		return await createProjectLocked(libraryRoot, options, hooks);
	} finally {
		await release();
	}
}

export async function validateWorkingDir(value: unknown): Promise<string | undefined> {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string")
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Working directory must be a string or null.", 400);
	const path = value.trim();
	if (!path) return undefined;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: paths cannot contain config line separators
	if (/[\x00-\x1f\x7f]/.test(path) || !isAbsolute(path))
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, "Working directory must be an absolute path.", 400);
	if (!(await isDirectory(path)))
		throw new LibraryError(LIBRARY_ERROR_CODES.VALIDATION, `Working directory "${path}" does not exist.`, 400);
	return path;
}

async function createProjectLocked(
	libraryRoot: string,
	options: { name: string; workingDir?: string },
	hooks: { beforeCommit?: () => Promise<void>; onCreated?: (project: LibraryProject) => Promise<void> },
): Promise<LibraryProject> {
	const name = assertValidProjectName(options.name);
	const existing = await listProjects(libraryRoot);
	if (existing.some((p) => p.name === name)) {
		throw new LibraryError(
			LIBRARY_ERROR_CODES.PROJECT_EXISTS,
			`A project named "${name}" already exists in this library.`,
			409,
		);
	}

	// Validate the working directory before creating anything, so a bad value
	// leaves no half-made project directory behind.
	const workingDir = await validateWorkingDir(options.workingDir);

	const dirName = sanitizeProjectDirName(name);
	const dir = join(libraryRoot, dirName);
	if (await isDirectory(dir)) {
		const contents = await readdir(dir).catch(() => [] as string[]);
		if (contents.length > 0) {
			throw new LibraryError(
				LIBRARY_ERROR_CODES.PROJECT_EXISTS,
				`Directory "${dirName}" already exists in the library and is not empty.`,
				409,
			);
		}
	}
	const staging = await mkdtemp(join(libraryRoot, ".project-"));
	try {
		const core = new Core(staging, { enableWatchers: false });
		await initializeProject(core, {
			projectName: name,
			integrationMode: "none",
			filesystemOnly: true,
		});

		const config = await core.filesystem.loadConfig();
		const id = generateProjectId();
		if (config) {
			config.projectId = id;
			// New projects are born speaking the P0/P1 priority vocabulary.
			config.priorities = ["P0", "P1"];
			if (workingDir) config.workingDir = workingDir;
			await core.filesystem.saveConfig(config);
		}

		await Bun.write(overviewFilePath(staging), initialOverviewContent(name));
		await mkdir(join(staging, RESOURCES_DIR_NAME), { recursive: true });
		await hooks.onCreated?.({ id, name, dir: staging, workingDir });
		await hooks.beforeCommit?.();
		// Publishing a fully initialized directory also publishes its creation history.
		if (await isDirectory(dir)) await rmdir(dir);
		await rename(staging, dir);
		return { id, name, dir, workingDir };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** Read-only candidate discovery. The chatting agent decides semantic relevance with the user. */
export async function searchProjects(libraryRoot: string, query: string, workingDir?: string) {
	const projects = await listProjects(libraryRoot);
	const records = await Promise.all(
		projects.map(async (project) => {
			const overview = await readOverview(project.dir);
			const context = await Bun.file(overviewFilePath(project.dir))
				.text()
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return "";
					throw error;
				});
			return {
				...project,
				description: overview.description,
				current: overview.current,
				context,
			};
		}),
	);
	const search = new Fuse(records, {
		keys: ["name", "description", "current", "context", "workingDir"],
		threshold: 0.35,
		ignoreLocation: true,
		minMatchCharLength: 2,
	});
	const textMatches = query.trim() ? search.search(query.trim()).map(({ item }) => item) : [];
	const directoryMatches = workingDir ? records.filter((project) => project.workingDir === workingDir) : [];
	const matches = [...new Map([...directoryMatches, ...textMatches].map((project) => [project.id, project])).values()];
	return {
		total: matches.length,
		projects: matches.slice(0, 20).map(({ context: _context, ...project }) => ({
			...project,
			description: project.description.slice(0, 600),
			current: project.current.slice(0, 600),
		})),
	};
}
