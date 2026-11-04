import { describe, expect, it } from "bun:test";
import {
	formatMcpClientSetupCommand,
	getMcpClientSetupCommand,
	runMcpClientSetupCommand,
} from "../utils/mcp-client-setup.ts";

describe("MCP client setup commands", () => {
	it("uses Codex's stdio command separator", () => {
		const setup = getMcpClientSetupCommand("codex", "memaster");

		expect(setup).toEqual({
			label: "OpenAI Codex",
			command: "codex",
			args: ["mcp", "add", "memaster", "--", "memaster", "mcp", "start"],
		});
		expect(formatMcpClientSetupCommand(setup.command, setup.args)).toBe("codex mcp add memaster -- memaster mcp start");
	});

	it("fails when a setup command exits non-zero", async () => {
		await expect(
			runMcpClientSetupCommand("bun", ["-e", "console.error('setup failed'); process.exit(42)"]),
		).rejects.toThrow("Command exited with code 42: setup failed");
	});
});
