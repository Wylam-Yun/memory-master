import {
	type AgentInstructionFile,
	type AgentInstructionWriteResult,
	addAgentInstructions,
	ensureMcpGuidelines,
	installClaudeAgent,
} from "../agent-instructions.ts";
import { DEFAULT_INIT_CONFIG } from "../constants/index.ts";
import type { MemasterConfig } from "../types/index.ts";
import {
	formatMcpClientSetupCommand,
	getMcpClientSetupCommand,
	isMcpClientSetupKey,
	type McpClientSetupKey,
	runMcpClientSetupCommand,
} from "../utils/mcp-client-setup.ts";
import { normalizeProjectMemasterDirectory } from "../utils/memaster-directory.ts";
import { getTaskPrefixError } from "../utils/prefix-config.ts";
import type { Core } from "./memaster.ts";

export const MCP_SERVER_NAME = "memaster";
export const MCP_GUIDE_URL = "https://github.com/Wylam-Yun/memory-master#-mcp-integration-model-context-protocol";

export type IntegrationMode = "mcp" | "cli" | "none";
export type McpClient = "claude" | "codex" | "gemini" | "kiro" | "guide";

const MCP_CLIENT_INSTRUCTION_MAP: Record<McpClientSetupKey, AgentInstructionFile> = {
	claude: "CLAUDE.md",
	codex: "AGENTS.md",
	gemini: "GEMINI.md",
	kiro: "AGENTS.md",
};

function formatAgentInstructionResults(results: AgentInstructionWriteResult[]): string {
	const labels: Array<[AgentInstructionWriteResult["action"], string]> = [
		["created", "Created"],
		["updated", "Updated"],
		["unchanged", "Unchanged"],
	];

	return labels
		.map(([action, label]) => {
			const fileNames = results.filter((result) => result.action === action).map((result) => result.fileName);
			return fileNames.length > 0 ? `${label}: ${fileNames.join(", ")}` : null;
		})
		.filter((line): line is string => line !== null)
		.join("\n");
}

export interface InitializeProjectOptions {
	projectName: string;
	memasterDirectory?: string;
	memasterDirectorySource?: "memaster" | ".memaster" | "custom";
	configLocation?: "folder" | "root";
	integrationMode: IntegrationMode;
	mcpClients?: McpClient[];
	agentInstructions?: AgentInstructionFile[];
	installClaudeAgent?: boolean;
	filesystemOnly?: boolean;
	advancedConfig?: {
		checkActiveBranches?: boolean;
		remoteOperations?: boolean;
		activeBranchDays?: number;
		bypassGitHooks?: boolean;
		autoCommit?: boolean;
		zeroPaddedIds?: number;
		defaultEditor?: string;
		definitionOfDone?: string[];
		defaultPort?: number;
		autoOpenBrowser?: boolean;
		/** Custom task prefix (e.g., "JIRA"). Only set during first init, read-only after. */
		taskPrefix?: string;
	};
	/** Existing config for re-initialization */
	existingConfig?: MemasterConfig | null;
}

export interface InitializeProjectResult {
	success: boolean;
	projectName: string;
	isReInitialization: boolean;
	config: MemasterConfig;
	mcpResults?: Record<string, string>;
}

async function runMcpClientCommand(client: McpClientSetupKey): Promise<string> {
	const { label, command, args } = getMcpClientSetupCommand(client, MCP_SERVER_NAME);
	try {
		await runMcpClientSetupCommand(command, args);
		return `Added Memaster MCP server to ${label}`;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Unable to configure ${label} automatically (${message}). Run manually: ${formatMcpClientSetupCommand(command, args)}`,
		);
	}
}

/**
 * Core initialization logic shared between CLI and browser.
 * Both CLI and browser validate input before calling this function.
 */
export async function initializeProject(
	core: Core,
	options: InitializeProjectOptions,
): Promise<InitializeProjectResult> {
	const {
		projectName,
		integrationMode,
		mcpClients = [],
		agentInstructions = [],
		installClaudeAgent: installClaudeAgentFlag = false,
		advancedConfig = {},
		existingConfig,
		filesystemOnly = false,
	} = options;

	const isReInitialization = !!existingConfig;
	// An explicitly requested prefix is always validated; existing prefixes are preserved below untouched.
	const taskPrefixError = getTaskPrefixError(advancedConfig.taskPrefix ?? "");
	if (taskPrefixError) {
		throw new Error(taskPrefixError);
	}
	const projectRoot = core.filesystem.rootDir;
	const effectiveFilesystemOnly = filesystemOnly || existingConfig?.filesystemOnly === true;
	const normalizedAdvancedConfig = effectiveFilesystemOnly
		? {
				...advancedConfig,
				checkActiveBranches: false,
				remoteOperations: false,
				bypassGitHooks: false,
				autoCommit: false,
			}
		: advancedConfig;
	const hasDefaultEditorOverride = Object.hasOwn(normalizedAdvancedConfig, "defaultEditor");
	const hasZeroPaddedIdsOverride = Object.hasOwn(normalizedAdvancedConfig, "zeroPaddedIds");
	const hasDefinitionOfDoneOverride = Object.hasOwn(normalizedAdvancedConfig, "definitionOfDone");

	// Build config, preserving existing values for re-initialization.
	// Re-init should be idempotent for fields that init does not explicitly manage.
	const d = DEFAULT_INIT_CONFIG;
	const baseConfig: MemasterConfig = {
		projectName,
		statuses: ["To Do", "In Progress", "Done"],
		labels: [],
		defaultStatus: "To Do",
		dateFormat: "yyyy-mm-dd",
		maxColumnWidth: 20,
		filesystemOnly: effectiveFilesystemOnly || d.filesystemOnly,
		autoCommit: normalizedAdvancedConfig.autoCommit ?? existingConfig?.autoCommit ?? d.autoCommit,
		remoteOperations:
			normalizedAdvancedConfig.remoteOperations ?? existingConfig?.remoteOperations ?? d.remoteOperations,
		bypassGitHooks: normalizedAdvancedConfig.bypassGitHooks ?? existingConfig?.bypassGitHooks ?? d.bypassGitHooks,
		checkActiveBranches:
			normalizedAdvancedConfig.checkActiveBranches ?? existingConfig?.checkActiveBranches ?? d.checkActiveBranches,
		activeBranchDays:
			normalizedAdvancedConfig.activeBranchDays ?? existingConfig?.activeBranchDays ?? d.activeBranchDays,
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		taskResolutionStrategy: existingConfig?.taskResolutionStrategy || "most_recent",
		// Preserve existing prefixes on re-init, or use custom prefix if provided during first init
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
	};
	const config: MemasterConfig = {
		...baseConfig,
		...(existingConfig ?? {}),
		projectName,
		filesystemOnly: effectiveFilesystemOnly || d.filesystemOnly,
		autoCommit: normalizedAdvancedConfig.autoCommit ?? existingConfig?.autoCommit ?? d.autoCommit,
		remoteOperations:
			normalizedAdvancedConfig.remoteOperations ?? existingConfig?.remoteOperations ?? d.remoteOperations,
		bypassGitHooks: normalizedAdvancedConfig.bypassGitHooks ?? existingConfig?.bypassGitHooks ?? d.bypassGitHooks,
		checkActiveBranches:
			normalizedAdvancedConfig.checkActiveBranches ?? existingConfig?.checkActiveBranches ?? d.checkActiveBranches,
		activeBranchDays:
			normalizedAdvancedConfig.activeBranchDays ?? existingConfig?.activeBranchDays ?? d.activeBranchDays,
		defaultPort: normalizedAdvancedConfig.defaultPort ?? existingConfig?.defaultPort ?? d.defaultPort,
		autoOpenBrowser: normalizedAdvancedConfig.autoOpenBrowser ?? existingConfig?.autoOpenBrowser ?? d.autoOpenBrowser,
		prefixes: existingConfig?.prefixes || {
			task: normalizedAdvancedConfig.taskPrefix || "task",
		},
		...(hasDefaultEditorOverride && normalizedAdvancedConfig.defaultEditor
			? { defaultEditor: normalizedAdvancedConfig.defaultEditor }
			: {}),
		...(hasZeroPaddedIdsOverride &&
		typeof normalizedAdvancedConfig.zeroPaddedIds === "number" &&
		normalizedAdvancedConfig.zeroPaddedIds > 0
			? { zeroPaddedIds: normalizedAdvancedConfig.zeroPaddedIds }
			: {}),
		...(hasDefinitionOfDoneOverride && Array.isArray(normalizedAdvancedConfig.definitionOfDone)
			? { definitionOfDone: [...normalizedAdvancedConfig.definitionOfDone] }
			: {}),
	};
	// Preserve all non-init-managed fields, but allow init-managed optional fields to be explicitly cleared.
	if (hasDefaultEditorOverride && !normalizedAdvancedConfig.defaultEditor) {
		delete config.defaultEditor;
	}
	if (
		hasZeroPaddedIdsOverride &&
		!(typeof normalizedAdvancedConfig.zeroPaddedIds === "number" && normalizedAdvancedConfig.zeroPaddedIds > 0)
	) {
		delete config.zeroPaddedIds;
	}
	if (hasDefinitionOfDoneOverride && !Array.isArray(normalizedAdvancedConfig.definitionOfDone)) {
		delete config.definitionOfDone;
	}

	// Create structure and save config
	if (isReInitialization) {
		await core.filesystem.saveConfig(config);
	} else {
		const normalizedMemasterDirectory = normalizeProjectMemasterDirectory(options.memasterDirectory);
		const inferredMemasterDirectorySource = normalizedMemasterDirectory
			? normalizedMemasterDirectory === ".memaster"
				? ".memaster"
				: normalizedMemasterDirectory === "memaster"
					? "memaster"
					: "custom"
			: undefined;
		if (
			options.memasterDirectorySource &&
			inferredMemasterDirectorySource &&
			options.memasterDirectorySource !== inferredMemasterDirectorySource
		) {
			throw new Error("Memaster directory source and memaster directory value must agree.");
		}
		const effectiveMemasterDirectorySource = options.memasterDirectorySource ?? inferredMemasterDirectorySource;
		if (effectiveMemasterDirectorySource === "custom" && !normalizedMemasterDirectory) {
			throw new Error("Memaster directory must be a valid project-relative path.");
		}
		const effectiveConfigLocation =
			options.configLocation ?? (effectiveMemasterDirectorySource === "custom" ? "root" : "folder");
		if (effectiveMemasterDirectorySource === "custom" && effectiveConfigLocation !== "root") {
			throw new Error("Custom memaster directories require root config discovery.");
		}
		const selectedMemasterDirectory =
			normalizedMemasterDirectory ??
			(effectiveMemasterDirectorySource === ".memaster"
				? ".memaster"
				: effectiveMemasterDirectorySource === "memaster"
					? "memaster"
					: "memaster");
		core.filesystem.setMemasterDirectory(selectedMemasterDirectory);
		core.filesystem.setConfigLocation(effectiveConfigLocation);
		await core.filesystem.ensureMemasterStructure();
		await core.filesystem.saveConfig(config);
		await core.ensureConfigLoaded();
	}

	const mcpResults: Record<string, string> = {};

	// Handle MCP integration
	if (integrationMode === "mcp" && mcpClients.length > 0) {
		for (const client of mcpClients) {
			try {
				if (client === "guide") {
					mcpResults.guide = `Setup guide: ${MCP_GUIDE_URL}`;
					continue;
				}
				if (!isMcpClientSetupKey(client)) {
					continue;
				}

				mcpResults[client] = await runMcpClientCommand(client);
				await ensureMcpGuidelines(projectRoot, MCP_CLIENT_INSTRUCTION_MAP[client]);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				mcpResults[client] = `Failed: ${message}`;
			}
		}
	}

	// Handle CLI integration - agent instruction files
	if (integrationMode === "cli" && agentInstructions.length > 0) {
		try {
			const agentInstructionResults = await addAgentInstructions(
				projectRoot,
				core.gitOps,
				agentInstructions,
				config.autoCommit,
			);
			mcpResults.agentFiles = formatAgentInstructionResults(agentInstructionResults);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResults.agentFiles = `Failed: ${message}`;
		}
	}

	// Handle Claude agent installation
	if (integrationMode === "cli" && installClaudeAgentFlag) {
		try {
			await installClaudeAgent(projectRoot);
			mcpResults.claudeAgent = "Installed to .claude/agents/";
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			mcpResults.claudeAgent = `Failed: ${message}`;
		}
	}

	return {
		success: true,
		projectName,
		isReInitialization,
		config,
		mcpResults: Object.keys(mcpResults).length > 0 ? mcpResults : undefined,
	};
}
