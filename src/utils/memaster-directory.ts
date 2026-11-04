import { readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_FILES } from "../constants/index.ts";

export type MemasterDirectorySource = "memaster" | ".memaster" | "custom";
export type MemasterConfigSource = "folder" | "root";

export interface MemasterDirectoryResolution {
	projectRoot: string;
	memasterDir: string | null;
	memasterPath: string | null;
	source: MemasterDirectorySource | null;
	configPath: string | null;
	configSource: MemasterConfigSource | null;
	rootConfigPath: string;
	rootConfigExists: boolean;
}

interface MemasterConfigMetadata {
	projectName: string | null;
	memasterDirectory: string | null;
}

function directoryExists(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function fileExists(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function parseMemasterConfigMetadata(content: string): MemasterConfigMetadata {
	let projectName: string | null = null;
	let memasterDirectory: string | null = null;

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) {
			continue;
		}
		const key = line.slice(0, colonIndex).trim();
		const value = line
			.slice(colonIndex + 1)
			.trim()
			.replace(/^['"]|['"]$/g, "");
		if ((key === "project_name" || key === "projectName") && value) {
			projectName = value;
			continue;
		}
		if (key === "memaster_directory" || key === "memasterDirectory") {
			memasterDirectory = normalizeProjectMemasterDirectory(value);
		}
	}
	return { projectName, memasterDirectory };
}

function readRootMemasterConfigMetadata(rootConfigPath: string): MemasterConfigMetadata | null {
	if (!fileExists(rootConfigPath)) {
		return null;
	}
	try {
		const metadata = parseMemasterConfigMetadata(readFileSync(rootConfigPath, "utf8"));
		return metadata.projectName ? metadata : null;
	} catch {
		return null;
	}
}

function resolveFolderConfigPath(memasterPath: string): string | null {
	const primary = join(memasterPath, DEFAULT_FILES.CONFIG);
	if (fileExists(primary)) {
		return primary;
	}
	const alternate = join(memasterPath, DEFAULT_FILES.CONFIG_YAML);
	return fileExists(alternate) ? alternate : null;
}

function resolveBuiltInMemasterDirectory(projectRoot: string): {
	memasterDir: string;
	memasterPath: string;
	source: "memaster" | ".memaster";
} | null {
	const defaultMemasterPath = join(projectRoot, DEFAULT_DIRECTORIES.MEMASTER);
	const hiddenMemasterPath = join(projectRoot, DEFAULT_DIRECTORIES.HIDDEN_MEMASTER);
	const defaultMemasterExists = directoryExists(defaultMemasterPath);
	const hiddenMemasterExists = directoryExists(hiddenMemasterPath);
	const defaultConfigPath = defaultMemasterExists ? resolveFolderConfigPath(defaultMemasterPath) : null;
	const hiddenConfigPath = hiddenMemasterExists ? resolveFolderConfigPath(hiddenMemasterPath) : null;

	if (defaultConfigPath) {
		return {
			memasterDir: DEFAULT_DIRECTORIES.MEMASTER,
			memasterPath: defaultMemasterPath,
			source: "memaster",
		};
	}

	if (hiddenConfigPath) {
		return {
			memasterDir: DEFAULT_DIRECTORIES.HIDDEN_MEMASTER,
			memasterPath: hiddenMemasterPath,
			source: ".memaster",
		};
	}

	if (defaultMemasterExists) {
		return {
			memasterDir: DEFAULT_DIRECTORIES.MEMASTER,
			memasterPath: defaultMemasterPath,
			source: "memaster",
		};
	}

	if (hiddenMemasterExists) {
		return {
			memasterDir: DEFAULT_DIRECTORIES.HIDDEN_MEMASTER,
			memasterPath: hiddenMemasterPath,
			source: ".memaster",
		};
	}

	return null;
}

export function resolveMemasterDirectoryFromRootConfig(
	projectRoot: string,
	memasterDirectory: string | null | undefined,
): MemasterDirectoryResolution {
	const rootConfigPath = join(projectRoot, DEFAULT_FILES.ROOT_CONFIG);
	const configuredMemasterDir = normalizeProjectMemasterDirectory(memasterDirectory);
	if (configuredMemasterDir) {
		const configuredMemasterPath = join(projectRoot, configuredMemasterDir);
		const configuredSource: MemasterDirectorySource =
			configuredMemasterDir === DEFAULT_DIRECTORIES.MEMASTER
				? "memaster"
				: configuredMemasterDir === DEFAULT_DIRECTORIES.HIDDEN_MEMASTER
					? ".memaster"
					: "custom";
		return {
			projectRoot,
			memasterDir: configuredMemasterDir,
			memasterPath: configuredMemasterPath,
			source: configuredSource,
			configPath: rootConfigPath,
			configSource: "root",
			rootConfigPath,
			rootConfigExists: true,
		};
	}

	const builtIn = resolveBuiltInMemasterDirectory(projectRoot);
	if (builtIn) {
		return {
			projectRoot,
			memasterDir: builtIn.memasterDir,
			memasterPath: builtIn.memasterPath,
			source: builtIn.source,
			configPath: rootConfigPath,
			configSource: "root",
			rootConfigPath,
			rootConfigExists: true,
		};
	}

	return {
		projectRoot,
		memasterDir: null,
		memasterPath: null,
		source: null,
		configPath: null,
		configSource: null,
		rootConfigPath,
		rootConfigExists: true,
	};
}

export function normalizeProjectMemasterDirectory(value: string | null | undefined): string | null {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) {
		return null;
	}
	if (/^(?:[a-zA-Z]:)?[\\/]/.test(trimmed)) {
		return null;
	}

	const normalized = normalize(trimmed).replace(/\\/g, "/").replace(/\/+$/g, "");
	if (!normalized || normalized === ".") {
		return null;
	}
	if (normalized === ".." || normalized.startsWith("../")) {
		return null;
	}
	return normalized;
}

export function resolveMemasterDirectory(projectRoot: string): MemasterDirectoryResolution {
	const rootConfigPath = join(projectRoot, DEFAULT_FILES.ROOT_CONFIG);
	const rootConfigExists = fileExists(rootConfigPath);

	if (rootConfigExists) {
		const metadata = readRootMemasterConfigMetadata(rootConfigPath);
		if (metadata) {
			return resolveMemasterDirectoryFromRootConfig(projectRoot, metadata.memasterDirectory);
		}
	}

	const builtIn = resolveBuiltInMemasterDirectory(projectRoot);
	if (!builtIn) {
		return {
			projectRoot,
			memasterDir: null,
			memasterPath: null,
			source: null,
			configPath: null,
			configSource: null,
			rootConfigPath,
			rootConfigExists,
		};
	}

	const folderConfigPath = resolveFolderConfigPath(builtIn.memasterPath);
	return {
		projectRoot,
		memasterDir: builtIn.memasterDir,
		memasterPath: builtIn.memasterPath,
		source: builtIn.source,
		configPath: folderConfigPath,
		configSource: folderConfigPath ? "folder" : null,
		rootConfigPath,
		rootConfigExists,
	};
}
