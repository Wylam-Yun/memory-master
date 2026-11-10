/**
 * Memory Master V1.0 library types.
 *
 * The "library" （记忆库） is a user-chosen directory holding one subdirectory per
 * project. Each project directory contains a memaster/ structure (Markdown
 * records + config.yml) that is the authoritative store, plus a 资料/ directory
 * for user-uploaded files. Application-level settings (library location and
 * per-client authorization) live outside project storage in settings.json.
 */

/**
 * Agent client slots with independent authorization switches. Every entry
 * must have a label below, a token prefix in settings.ts, and a ClientFiles
 * record in client-setup.ts — tests assert the maps stay in sync.
 */
export const LIBRARY_CLIENT_IDS = ["codex", "claude-code", "devin", "cursor", "opencode", "hermes", "dsh"] as const;
export type LibraryClientId = (typeof LIBRARY_CLIENT_IDS)[number];

export function isLibraryClientId(value: string): value is LibraryClientId {
	return (LIBRARY_CLIENT_IDS as readonly string[]).includes(value);
}

export const LIBRARY_CLIENT_LABELS: Record<LibraryClientId, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
	devin: "Devin",
	cursor: "Cursor",
	opencode: "OpenCode",
	hermes: "Hermes",
	dsh: "DeepSeek Harness",
};

/**
 * Client setup state: `none` (never installed) → `configured` (files written,
 * awaiting the client's first contact) → `connected` (its bridge has reached
 * the service). Only `connected` opens project read/write; the probe phase
 * accepts just the ping route.
 */
export type ClientConnection = "none" | "configured" | "connected";

/** Per-client authorization slot: enable switch + access credential + setup state. */
export interface ClientSlot {
	enabled: boolean;
	/** Credential identifying this client; kept across disable so re-enable reuses config. */
	token: string | null;
	connection: ClientConnection;
	/** Last failed install attempt's reason — the UI shows it with a retry affordance. */
	installError: string | null;
	/** Last successful contact from this client's bridge. */
	lastSeenAt: string | null;
	/** Internal: monotonically bumped per install attempt; stale completions are ignored. */
	setupGeneration?: number;
}

/** Application settings persisted in <home>/settings.json (independent of project storage). */
export interface LibrarySettings {
	version: 1;
	/** Absolute path of the chosen memory library; null until the user confirms one. */
	libraryRoot: string | null;
	/** Preferred port for the local service. */
	port: number;
	clients: Record<LibraryClientId, ClientSlot>;
}

/** One project inside the library. */
export interface LibraryProject {
	/** Stable project ID stored in the project's config as project_id. */
	id: string;
	/** Display name (also the config's project_name). */
	name: string;
	/** Absolute path of the project directory inside the library. */
	dir: string;
	/** Optional associated working directory outside the library. */
	workingDir?: string;
}

/** Maintained overview sections, including optional long-lived project agreements. */
export interface ProjectOverview {
	/** Long-lived confirmed project decisions and constraints. */
	agreements: string;
	criticalPaths: string;
	description: string;
	goal: string;
	current: string;
	/** 功能与用法 — what the project can do and how to use each capability. */
	features: string;
}

/** Error codes surfaced through the agent/web API boundary. */
export const LIBRARY_ERROR_CODES = {
	UNAUTHORIZED: "UNAUTHORIZED",
	ACCESS_DISABLED: "ACCESS_DISABLED",
	CONNECTION_PENDING: "CONNECTION_PENDING",
	PROJECT_NOT_FOUND: "PROJECT_NOT_FOUND",
	PROJECT_AMBIGUOUS: "PROJECT_AMBIGUOUS",
	PROJECT_EXISTS: "PROJECT_EXISTS",
	VERSION_CONFLICT: "VERSION_CONFLICT",
	LIBRARY_NOT_SET: "LIBRARY_NOT_SET",
	VALIDATION: "VALIDATION",
} as const;
export type LibraryErrorCode = (typeof LIBRARY_ERROR_CODES)[keyof typeof LIBRARY_ERROR_CODES];

/** A failure with a stable code and an HTTP status, mapped by the service layer. */
export class LibraryError extends Error {
	readonly code: LibraryErrorCode;
	readonly status: number;
	/** Extra payload for API responses (e.g. ambiguous candidates). */
	readonly details?: Record<string, unknown>;

	constructor(code: LibraryErrorCode, message: string, status: number, details?: Record<string, unknown>) {
		super(message);
		this.name = "LibraryError";
		this.code = code;
		this.status = status;
		this.details = details;
	}
}

export function unauthorizedError(message = "Missing or unknown access token."): LibraryError {
	return new LibraryError(LIBRARY_ERROR_CODES.UNAUTHORIZED, message, 401);
}

/** Enabled but its bridge hasn't connected yet — only the probe route is open. */
export function connectionPendingError(clientId: string): LibraryError {
	return new LibraryError(
		LIBRARY_ERROR_CODES.CONNECTION_PENDING,
		`Client "${clientId}" is configured but has not connected to this service yet. Open ${clientId} so its Memory Master MCP bridge can reach the service.`,
		403,
	);
}

export function accessDisabledError(clientId: string): LibraryError {
	return new LibraryError(
		LIBRARY_ERROR_CODES.ACCESS_DISABLED,
		`Access for client "${clientId}" is currently disabled. Re-enable it in Memory Master settings.`,
		403,
	);
}

export function projectNotFoundError(reference: string): LibraryError {
	return new LibraryError(
		LIBRARY_ERROR_CODES.PROJECT_NOT_FOUND,
		`No Memory Master project matches "${reference}".`,
		404,
	);
}

/**
 * Optimistic-concurrency failure: the caller's base version no longer matches
 * the record on disk. `current` carries the latest record (with its version)
 * so the caller can decide whether to retry on top of it.
 */
export function versionConflictError(current: unknown, version: string): LibraryError {
	return new LibraryError(
		LIBRARY_ERROR_CODES.VERSION_CONFLICT,
		"The record changed since you read it. Review the latest value in `current` and retry if still appropriate.",
		409,
		{ current, version },
	);
}

export function projectAmbiguousError(
	reference: string,
	candidates: Array<Pick<LibraryProject, "id" | "name">>,
): LibraryError {
	const names = candidates.map((c) => `"${c.name}" (${c.id})`).join(", ");
	return new LibraryError(
		LIBRARY_ERROR_CODES.PROJECT_AMBIGUOUS,
		`"${reference}" is ambiguous between ${names}. Open by project ID instead.`,
		409,
		{ candidates },
	);
}
