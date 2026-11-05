import { join } from "node:path";

/**
 * Project architecture persistence.
 *
 * Each library project may keep one `memaster/architecture.md`: a single
 * versioned record (diagram source + composition notes + provenance) shared by
 * the web page and agents through the same write unit. Structure inside the
 * document — composition tables, linked task IDs — is derived by Markdown
 * parsing on the read side; the service never validates the format.
 */

export const ARCHITECTURE_FILE_NAME = "architecture.md";

export function architectureFilePath(projectDir: string): string {
	return join(projectDir, "memaster", ARCHITECTURE_FILE_NAME);
}

/** 项目架构是一份整体 Markdown（图源+组成说明+核对信息）。缺失按空内容处理。 */
export async function readArchitecture(projectDir: string): Promise<string> {
	const file = Bun.file(architectureFilePath(projectDir));
	return (await file.exists()) ? await file.text() : "";
}
