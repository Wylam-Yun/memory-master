import { join } from "node:path";

export function getTestCliPath(): string {
	return process.env.MEMASTER_TEST_CLI_BUNDLE?.trim() || join(process.cwd(), "src", "cli.ts");
}
