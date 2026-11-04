import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	accessDisabledError,
	type ClientSlot,
	connectionPendingError,
	LIBRARY_CLIENT_IDS,
	type LibraryClientId,
	LibraryError,
	type LibrarySettings,
	unauthorizedError,
} from "./types.ts";

const SETTINGS_VERSION = 1;
const DEFAULT_SERVICE_PORT = 6420;
const TOKEN_PREFIXES: Record<LibraryClientId, string> = {
	codex: "mm_codex",
	"claude-code": "mm_claude",
};

/**
 * Application-level settings store.
 *
 * Lives in `<home>/settings.json` where home defaults to `~/.memory-master` and is
 * overridable with the MEMORY_MASTER_HOME environment variable (tests point it at
 * temp dirs). Holds the library location and per-client authorization state —
 * both are app settings, independent of project storage.
 *
 * Writes are atomic (tmp file + rename) and every mutation persists before it is
 * observable, so a revoke that returned success cannot be outrun by a later read.
 */
export class AppSettingsStore {
	readonly homeDir: string;
	readonly filePath: string;
	private settings: LibrarySettings | null = null;
	private settingsMtime = 0;
	/** Serializes mutations so a token save can never interleave with a revoke. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(homeDir?: string) {
		this.homeDir = homeDir ?? AppSettingsStore.defaultHome();
		this.filePath = join(this.homeDir, "settings.json");
	}

	static defaultHome(): string {
		const override = process.env.MEMORY_MASTER_HOME?.trim();
		return override ? override : join(homedir(), ".memory-master");
	}

	static defaultSettings(): LibrarySettings {
		const clients = {} as Record<LibraryClientId, ClientSlot>;
		for (const id of LIBRARY_CLIENT_IDS) {
			clients[id] = { enabled: false, token: null, connection: "none", installError: null, lastSeenAt: null };
		}
		return { version: SETTINGS_VERSION, libraryRoot: null, port: DEFAULT_SERVICE_PORT, clients };
	}

	private static generateToken(clientId: LibraryClientId): string {
		return `${TOKEN_PREFIXES[clientId]}_${randomBytes(16).toString("hex")}`;
	}

	/** Loaded settings; callers must treat the returned object as read-only. */
	async getSettings(): Promise<LibrarySettings> {
		if (!this.settings) {
			this.settings = await this.load();
		}
		return this.settings;
	}

	private async load(): Promise<LibrarySettings> {
		const file = Bun.file(this.filePath);
		if (!(await file.exists())) {
			this.settingsMtime = 0;
			return AppSettingsStore.defaultSettings();
		}
		let raw: unknown;
		try {
			raw = await file.json();
			const { stat } = await import("node:fs/promises");
			this.settingsMtime = (await stat(this.filePath)).mtimeMs;
		} catch (error) {
			throw new LibraryError(
				"VALIDATION",
				`Cannot read Memory Master settings at ${this.filePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
				500,
			);
		}
		return AppSettingsStore.normalize(raw);
	}

	/** Merge a persisted value onto defaults so older/newer files stay loadable. */
	private static normalize(raw: unknown): LibrarySettings {
		const settings = AppSettingsStore.defaultSettings();
		if (typeof raw !== "object" || raw === null) return settings;
		const data = raw as Record<string, unknown>;
		if (typeof data.libraryRoot === "string") settings.libraryRoot = data.libraryRoot;
		if (typeof data.port === "number" && Number.isInteger(data.port) && data.port > 0) settings.port = data.port;
		const clients = data.clients;
		if (typeof clients === "object" && clients !== null) {
			for (const id of LIBRARY_CLIENT_IDS) {
				const slot = (clients as Record<string, unknown>)[id];
				if (typeof slot === "object" && slot !== null) {
					const { enabled, token, connection, installError, lastSeenAt } = slot as Record<string, unknown>;
					settings.clients[id] = {
						enabled: enabled === true,
						token: typeof token === "string" ? token : null,
						connection: connection === "configured" || connection === "connected" ? connection : "none",
						installError: typeof installError === "string" ? installError : null,
						lastSeenAt: typeof lastSeenAt === "string" ? lastSeenAt : null,
					};
				}
			}
		}
		return settings;
	}

	private async persist(next: LibrarySettings): Promise<void> {
		await Bun.write(join(this.homeDir, ".keep"), "");
		const tmpPath = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
		await Bun.write(tmpPath, `${JSON.stringify(next, null, 2)}\n`);
		const { chmod, rename, stat } = await import("node:fs/promises");
		// The file carries client credentials — restrict the temp file before the
		// rename publishes it, so it is never briefly world-readable.
		await chmod(tmpPath, 0o600).catch(() => {});
		await rename(tmpPath, this.filePath);
		this.settings = next;
		try {
			this.settingsMtime = (await stat(this.filePath)).mtimeMs;
		} catch {}
	}

	/**
	 * Re-read the file when it changed on disk. Mutations in this process update
	 * the cache directly, but a revoke from another process — or a hand edit —
	 * must be visible before the next authorization decision.
	 */
	private async refreshIfChanged(): Promise<void> {
		const { stat } = await import("node:fs/promises");
		let mtime = 0;
		try {
			mtime = (await stat(this.filePath)).mtimeMs;
		} catch {
			// Missing or unreadable file: keep the in-memory view; a missing file
			// only exists before the first persist, which is already the default.
			if (this.settingsMtime !== 0) this.settings = await this.load();
			return;
		}
		if (mtime !== this.settingsMtime) {
			this.settings = await this.load();
		}
	}

	/** Serialize a mutation: fn gets a mutable draft, result is persisted then returned. */
	private mutate<T>(fn: (draft: LibrarySettings) => T): Promise<T> {
		const run = this.queue.then(async () => {
			const current = await this.getSettings();
			const draft: LibrarySettings = structuredClone(current);
			const result = fn(draft);
			await this.persist(draft);
			return result;
		});
		this.queue = run.catch(() => {});
		return run;
	}

	async setLibraryRoot(libraryRoot: string): Promise<void> {
		await this.mutate((draft) => {
			draft.libraryRoot = libraryRoot;
		});
	}

	async getLibraryRoot(): Promise<string | null> {
		return (await this.getSettings()).libraryRoot;
	}

	async getPort(): Promise<number> {
		return (await this.getSettings()).port;
	}

	/** Persist the port the service actually bound so `connect` prints the right URL. */
	async setPort(port: number): Promise<void> {
		await this.mutate((draft) => {
			draft.port = port;
		});
	}

	/**
	 * Flip one client's authorization switch. Disabling keeps token and connection
	 * state so re-enabling can repair rather than recreate. Enabling directly
	 * (without the install flow) marks the slot configured — the probe gate still
	 * requires the client to actually connect before project access opens.
	 */
	async setClientEnabled(clientId: LibraryClientId, enabled: boolean): Promise<ClientSlot> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			slot.enabled = enabled;
			if (enabled && !slot.token) {
				slot.token = AppSettingsStore.generateToken(clientId);
			}
			if (enabled && slot.connection === "none") {
				slot.connection = "configured";
			}
			return { ...slot };
		});
	}

	/** Issue (or reuse) a credential for an install attempt; does not enable. */
	async ensureToken(clientId: LibraryClientId): Promise<string> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			if (!slot.token) slot.token = AppSettingsStore.generateToken(clientId);
			return slot.token as string;
		});
	}

	/** Install succeeded: enabled + configured, awaiting the client's first contact. */
	async markConfigured(clientId: LibraryClientId): Promise<ClientSlot> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			slot.enabled = true;
			slot.connection = "configured";
			slot.installError = null;
			return { ...slot };
		});
	}

	/** Install failed: stays disabled, records why for the UI's retry affordance. */
	async markInstallFailed(clientId: LibraryClientId, error: string): Promise<ClientSlot> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			slot.enabled = false;
			slot.installError = error;
			return { ...slot };
		});
	}

	/** The client's bridge reached the service — full project access opens. */
	async markConnected(clientId: LibraryClientId): Promise<ClientSlot> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			slot.connection = "connected";
			slot.lastSeenAt = new Date().toISOString();
			return { ...slot };
		});
	}

	async getClient(clientId: LibraryClientId): Promise<ClientSlot> {
		return { ...(await this.getSettings()).clients[clientId] };
	}

	/** Map a bearer credential to its client, or null when it matches no slot. */
	async resolveToken(token: string): Promise<LibraryClientId | null> {
		const { clients } = await this.getSettings();
		for (const id of LIBRARY_CLIENT_IDS) {
			const slot = clients[id];
			if (slot.token && slot.token === token) return id;
		}
		return null;
	}

	/** True only when the token maps to a connected (fully authorized) client. */
	async isAuthorized(token: string | null | undefined): Promise<boolean> {
		if (!token) return false;
		const clientId = await this.resolveToken(token);
		if (!clientId) return false;
		const slot = await this.getClient(clientId);
		return slot.enabled && slot.connection === "connected";
	}

	private async resolveEnabled(token: string | null | undefined): Promise<LibraryClientId> {
		if (!token) throw unauthorizedError();
		const clientId = await this.resolveToken(token);
		if (!clientId) throw unauthorizedError();
		if (!(await this.getClient(clientId)).enabled) throw accessDisabledError(clientId);
		return clientId;
	}

	/**
	 * Probe gate: enabled + at least configured. The ping route is the only
	 * thing open during probing — project read/write waits for `connected`.
	 */
	async assertProbeAuthorized(token: string | null | undefined): Promise<LibraryClientId> {
		await this.refreshIfChanged();
		const clientId = await this.resolveEnabled(token);
		const slot = await this.getClient(clientId);
		if (slot.connection === "none") throw connectionPendingError(clientId);
		return clientId;
	}

	/**
	 * Full gate: enabled + connected. Called at request entry and again inside
	 * the write lock immediately before persisting, so a revoke that already
	 * returned cannot be outrun by a parked write.
	 */
	async assertAuthorized(token: string | null | undefined): Promise<LibraryClientId> {
		await this.refreshIfChanged();
		const clientId = await this.resolveEnabled(token);
		const slot = await this.getClient(clientId);
		if (slot.connection !== "connected") throw connectionPendingError(clientId);
		return clientId;
	}
}
