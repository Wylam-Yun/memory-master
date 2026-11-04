/**
 * Memory Master V1.0 library types.
 *
 * The "library" （记忆库） is a user-chosen directory holding one subdirectory per
 * project. Each project directory contains a memaster/ structure (Markdown
 * records + config.yml) that is the authoritative store, plus a 资料/ directory
 * for user-uploaded files. Application-level settings (library location and
 * per-client authorization) live outside project storage in settings.json.
 */

/** Agent client slots with independent authorization switches. */
export const LIBRARY_CLIENT_IDS = ["codex", "claude-code"] as const;
export type LibraryClientId = (typeof LIBRARY_CLIENT_IDS)[number];

export function isLibraryClientId(value: string): value is LibraryClientId {
	return (LIBRARY_CLIENT_IDS as readonly string[]).includes(value);
}

export const LIBRARY_CLIENT_LABELS: Record<LibraryClientId, string> = {
	codex: "Codex",
	"claude-code": "Claude Code",
};

/** Per-client authorization slot: enable switch + access credential. */
export interface ClientSlot {
	enabled: boolean;
	/** Credential identifying this client; kept across disable so re-enable reuses config. */
	token: string | null;
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

/** The three maintained sections of a project's memaster/overview.md. */
export interface ProjectOverview {
	description: string;
	goal: string;
	current: string;
}

/** Error codes surfaced through the agent/web API boundary. */
export const LIBRARY_ERROR_CODES = {
	UNAUTHORIZED: "UNAUTHORIZED",
	ACCESS_DISABLED: "ACCESS_DISABLED",
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
