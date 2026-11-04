/** Thin fetch helpers for the library web API (localhost-trusted, no credential). */

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
}

export interface Task {
	id: string;
	title: string;
	status: string;
	description?: string;
	createdDate?: string;
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
	const res = await fetch(path, {
		method: init?.method ?? "GET",
		headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
	if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status, data.code);
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
	putOverview: (id: string, update: Partial<ProjectOverview>) =>
		request<ProjectOverview>(`/api/projects/${id}/overview`, { method: "PUT", body: update }),
	listTasks: (id: string) => request<Task[]>(`/api/projects/${id}/tasks`),
	createTask: (id: string, title: string) =>
		request<Task>(`/api/projects/${id}/tasks`, { method: "POST", body: { title } }),
	updateTask: (id: string, taskId: string, update: Partial<Pick<Task, "title" | "status" | "description">>) =>
		request<Task>(`/api/projects/${id}/tasks/${taskId}`, { method: "PUT", body: update }),
	listClients: () => request<ClientSlotInfo[]>("/api/clients"),
	setClient: (id: string, enabled: boolean) =>
		request<ClientSlotInfo>(`/api/clients/${id}`, { method: "PUT", body: { enabled } }),
};
