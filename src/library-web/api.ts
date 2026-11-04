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
	/** Content-hash version — must be sent back as baseVersion on update. */
	version: string;
}

export interface Task {
	id: string;
	title: string;
	status: string;
	description?: string;
	createdDate?: string;
	/** Content-hash version — must be sent back as baseVersion on update. */
	version?: string;
}

export interface HistoryEntry {
	ts: string;
	actor: { type: "user" } | { type: "agent"; client: string };
	target: { type: "project" | "task" | "overview"; id?: string; title?: string };
	action: "create" | "update";
	changes: Record<string, { from?: string; to?: string }>;
	version: string;
}

export interface ClientSlotInfo {
	id: "codex" | "claude-code";
	label: string;
	enabled: boolean;
	token: string | null;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code?: string;
	constructor(message: string, status: number, code?: string) {
		super(message);
		this.status = status;
		this.code = code;
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
	const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
	if (!res.ok) {
		if (res.status === 401) onUnauthorized?.();
		throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code);
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
	getOverview: (id: string) => request<ProjectOverview>(`/api/projects/${id}/overview`),
	putOverview: (id: string, update: Partial<Omit<ProjectOverview, "version">>, baseVersion: string) =>
		request<ProjectOverview>(`/api/projects/${id}/overview`, { method: "PUT", body: { ...update, baseVersion } }),
	listTasks: (id: string) => request<Task[]>(`/api/projects/${id}/tasks`),
	createTask: (id: string, title: string) =>
		request<Task>(`/api/projects/${id}/tasks`, { method: "POST", body: { title } }),
	updateTask: (
		id: string,
		taskId: string,
		update: Partial<Pick<Task, "title" | "status" | "description">>,
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
};
