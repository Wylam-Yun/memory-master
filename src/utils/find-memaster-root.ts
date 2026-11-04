import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { resolveMemasterDirectory } from "./memaster-directory.ts";

/**
 * Check if a file exists
 */
async function fileExists(path: string): Promise<boolean> {
	try {
		const s = await stat(path);
		return s.isFile();
	} catch {
		return false;
	}
}

/**
 * Finds the Memaster project root by walking up the directory tree.
 *
 * Search order:
 * 1. Walk up from startDir looking for a supported memaster directory or `memaster.json` file
 * 2. If not found, fall back to git repository root (via `git rev-parse --show-toplevel`)
 * 3. Return null if no Memaster project found
 *
 * @param startDir - The directory to start searching from (typically process.cwd())
 * @returns The project root path, or null if no Memaster project found
 */
export async function findMemasterRoot(startDir: string): Promise<string | null> {
	let current = startDir;

	// Walk up the directory tree looking for a memaster config or memaster.json
	while (current !== dirname(current)) {
		const memasterResolution = resolveMemasterDirectory(current);
		if (memasterResolution.configPath) {
			return current;
		}

		// Check for memaster.json file
		const memasterJson = join(current, "memaster.json");
		if (await fileExists(memasterJson)) {
			return current;
		}

		current = dirname(current);
	}

	// Fallback: try git repository root
	try {
		const result = await $`git rev-parse --show-toplevel`.cwd(startDir).quiet();
		const gitRoot = result.stdout.toString().trim();

		if (gitRoot) {
			// Verify the git root has a memaster setup
			const memasterJson = join(gitRoot, "memaster.json");

			const memasterResolution = resolveMemasterDirectory(gitRoot);
			if (memasterResolution.configPath || (await fileExists(memasterJson))) {
				return gitRoot;
			}
		}
	} catch {
		// Not in a git repository or git not available
	}

	return null;
}

// Cache for the project root within a single CLI execution
let cachedProjectRoot: string | null | undefined;

/**
 * Gets the Memaster project root, with caching for performance.
 * Call clearProjectRootCache() to reset the cache if needed.
 */
export async function getProjectRoot(startDir: string): Promise<string | null> {
	if (cachedProjectRoot !== undefined) {
		return cachedProjectRoot;
	}

	cachedProjectRoot = await findMemasterRoot(startDir);
	return cachedProjectRoot;
}

/**
 * Clears the cached project root. Useful for testing.
 */
export function clearProjectRootCache(): void {
	cachedProjectRoot = undefined;
}
