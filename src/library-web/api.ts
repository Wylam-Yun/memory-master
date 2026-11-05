/** Thin fetch helpers for the library web API (session-key authorized). */

/**
 * The web session key arrives out-of-band: `memaster serve` prints a `?k=` URL,
 * the user opens it (or pastes the key on the entry screen). We keep it in
 * sessionStorage only — never localStorage, never written anywhere an agent
 * process could read it as a file.
 */
const KEY_STORAGE = "mm-web-key";

let webKey = (() => {
	const url = new URL(window.location.href);
	const fromUrl = url.searchParams.get("k");
	if (fromUrl) {
		sessionStorage.setItem(KEY_STORAGE, fromUrl);
		url.searchParams.delete("k");
		window.history.replaceState(null, "", url);
	}
	return sessionStorage.getItem(KEY_STORAGE) ?? "";
})();

export function hasWebKey(): boolean {
	return webKey.length > 0;
}

export function setWebKey(raw: string): void {
	const input = raw.trim();
	// Accept a pasted full URL as well as the bare key.
	const viaUrl = input.includes("://") ? new URL(input).searchParams.get("k") : null;
	webKey = viaUrl ?? input;
	sessionStorage.setItem(KEY_STORAGE, webKey);
}

/** Called whenever the service answers 401 — App uses it to re-show the key screen. */
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(handler: (() => void) | null): void {
	onUnauthorized = handler;
}

export interface LibraryProject {
	id: string;
	name: string;
	dir: string;
	workingDir?: string;
}

export interface ProjectOverview {
	description: string;
	goal: string;
	current: string;
	/** 功能与用法 — available capabilities/deliverables and how to use them. */
	features: string;
	/** Content-hash version — must be sent back as baseVersion on update. */
	version: string;
}

export interface Task {
	id: string;
	title: string;
	status: string;
	description?: string;
	createdDate?: string;
	/** Normalized priority value ("p0"/"p1"); absent on pre-V1.1 records = P0. */
	priority?: string;
	/** Content-hash version — must be sent back as baseVersion on update. */
	version?: string;
}

export interface HistoryEntry {
	ts: string;
	actor: { type: "user" } | { type: "agent"; client: string };
	target: {
		type: "project" | "task" | "overview" | "question" | "resource" | "architecture";
		id?: string;
		title?: string;
	};
	action: "create" | "update";
	changes: Record<string, { from?: string; to?: string }>;
	version: string;
}

/** GET /api/projects/:id — project plus its task workflow/priority metadata. */
export type ProjectMeta = LibraryProject & {
	statuses: string[];
	doneStatus: string | null;
	p0: string;
	p1: string;
};

/** 项目架构 — one whole Markdown record (diagram source + composition notes). */
export interface ArchitectureRecord {
	content: string;
	/** Content-hash version — must be sent back as baseVersion on update. */
	version: string;
}

/** Single resource read — UTF-8 text for textual files, base64 otherwise. */
export interface ResourceContent {
	name: string;
	size: number;
	contentType: string;
	text?: string;
	base64?: string;
}

export interface ProjectQuestion {
	id: string;
	title: string;
	status: "Open" | "Answered";
	task?: string;
	askedBy: string;
	askedAt: string;
	answer?: string;
	answeredBy?: string;
	answeredAt?: string;
	detail?: string;
	version?: string;
}

export interface ResourceInfo {
	name: string;
	size: number;
	modifiedAt: string;
}

export type ClientConnection = "none" | "configured" | "connected";

export interface ClientSlotInfo {
	id: "codex" | "claude-code";
	label: string;
	enabled: boolean;
	token: string | null;
	connection: ClientConnection;
	installError: string | null;
	lastSeenAt: string | null;
	/** Present on a successful enable — the files the installer wrote. */
	installed?: string[];
}

export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;
	/** VERSION_CONFLICT payloads carry the server's latest record… */
	readonly current?: unknown;
	/** …and that record's version, for retrying on top of it. */
	readonly version?: string;
	constructor(message: string, status: number, code?: string, current?: unknown, version?: string) {
		super(message);
		this.status = status;
		this.code = code;
		this.current = current;
		this.version = version;
	}
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const headers: Record<string, string> = { authorization: `Bearer ${webKey}` };
	if (init?.body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(path, {
		method: init?.method ?? "GET",
		headers,
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	const data = (await res.json().catch(() => ({}))) as {
		error?: string;
		code?: string;
		current?: unknown;
		version?: string;
	};
	if (!res.ok) {
		if (res.status === 401) onUnauthorized?.();
		throw new ApiError(
			data.error ?? `Request failed (${res.status})`,
			res.status,
			data.code,
			data.current,
			data.version,
		);
	}
	return data as T;
}

export const api = {
	service: () => request<{ libraryRoot: string | null; defaultLibraryRoot: string; version: string }>("/api/service"),
	getLibrary: () =>
		request<{ libraryRoot: string | null; defaultLibraryRoot: string; projects: LibraryProject[] }>("/api/library"),
	setLibrary: (libraryRoot: string) =>
		request<{ libraryRoot: string; projects: LibraryProject[] }>("/api/library", {
			method: "PUT",
			body: { libraryRoot },
		}),
	listProjects: () => request<LibraryProject[]>("/api/projects"),
	createProject: (name: string, workingDir?: string) =>
		request<LibraryProject>("/api/projects", { method: "POST", body: { name, workingDir } }),
	getProject: (id: string) => request<ProjectMeta>(`/api/projects/${id}`),
	getOverview: (id: string) => request<ProjectOverview>(`/api/projects/${id}/overview`),
	putOverview: (id: string, update: Partial<Omit<ProjectOverview, "version">>, baseVersion: string) =>
		request<ProjectOverview>(`/api/projects/${id}/overview`, { method: "PUT", body: { ...update, baseVersion } }),
	listTasks: (id: string) => request<Task[]>(`/api/projects/${id}/tasks`),
	createTask: (id: string, title: string) =>
		request<Task>(`/api/projects/${id}/tasks`, { method: "POST", body: { title } }),
	updateTask: (
		id: string,
		taskId: string,
		update: Partial<Pick<Task, "title" | "status" | "description" | "priority">>,
		baseVersion: string,
	) =>
		request<Task>(`/api/projects/${id}/tasks/${taskId}`, {
			method: "PUT",
			body: { ...update, baseVersion },
		}),
	history: (id: string, range: { since?: string; until?: string } = {}) => {
		const params = new URLSearchParams();
		if (range.since) params.set("since", range.since);
		if (range.until) params.set("until", range.until);
		const query = params.size ? `?${params}` : "";
		return request<HistoryEntry[]>(`/api/projects/${id}/history${query}`);
	},
	listClients: () => request<ClientSlotInfo[]>("/api/clients"),
	setClient: (id: string, enabled: boolean) =>
		request<ClientSlotInfo>(`/api/clients/${id}`, { method: "PUT", body: { enabled } }),
	listQuestions: (id: string) => request<ProjectQuestion[]>(`/api/projects/${id}/questions`),
	createQuestion: (id: string, title: string, task?: string, detail?: string) =>
		request<ProjectQuestion>(`/api/projects/${id}/questions`, {
			method: "POST",
			body: { title, ...(task ? { task } : {}), ...(detail ? { detail } : {}) },
		}),
	answerQuestion: (id: string, questionId: string, answer: string) =>
		request<ProjectQuestion>(`/api/projects/${id}/questions/${questionId}`, {
			method: "PUT",
			body: { answer },
		}),
	listResources: (id: string) => request<ResourceInfo[]>(`/api/projects/${id}/resources`),
	uploadResource: (id: string, name: string, base64: string) =>
		request<ResourceInfo>(`/api/projects/${id}/resources`, { method: "POST", body: { name, base64 } }),
	getResource: (id: string, name: string) =>
		request<ResourceContent>(`/api/projects/${id}/resources/${encodeURIComponent(name)}`),
	getArchitecture: (id: string) => request<ArchitectureRecord>(`/api/projects/${id}/architecture`),
	putArchitecture: (id: string, content: string, baseVersion: string) =>
		request<ArchitectureRecord>(`/api/projects/${id}/architecture`, {
			method: "PUT",
			body: { content, baseVersion },
		}),
};
