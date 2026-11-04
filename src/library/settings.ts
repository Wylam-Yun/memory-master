import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	accessDisabledError,
	type ClientSlot,
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
			clients[id] = { enabled: false, token: null };
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
			return AppSettingsStore.defaultSettings();
		}
		let raw: unknown;
		try {
			raw = await file.json();
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
					const { enabled, token } = slot as Record<string, unknown>;
					settings.clients[id] = {
						enabled: enabled === true,
						token: typeof token === "string" ? token : null,
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
		const { chmod, rename } = await import("node:fs/promises");
		// The file carries client credentials — restrict the temp file before the
		// rename publishes it, so it is never briefly world-readable.
		await chmod(tmpPath, 0o600).catch(() => {});
		await rename(tmpPath, this.filePath);
		this.settings = next;
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
	 * Flip one client's authorization switch. Enabling generates a credential on
	 * first use and reuses it afterwards; disabling keeps the token so the client
	 * configuration stays valid for the next enable. The new state is persisted
	 * before this resolves.
	 */
	async setClientEnabled(clientId: LibraryClientId, enabled: boolean): Promise<ClientSlot> {
		return await this.mutate((draft) => {
			const slot = draft.clients[clientId];
			slot.enabled = enabled;
			if (enabled && !slot.token) {
				slot.token = AppSettingsStore.generateToken(clientId);
			}
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

	/** True only when the token maps to a client whose switch is currently on. */
	async isAuthorized(token: string | null | undefined): Promise<boolean> {
		if (!token) return false;
		const clientId = await this.resolveToken(token);
		if (!clientId) return false;
		return (await this.getClient(clientId)).enabled;
	}

	/**
	 * Throw unless the credential currently maps to an enabled client. Called at
	 * request entry and again inside the write lock immediately before persisting,
	 * so a revoke that already returned cannot be outrun by a parked write.
	 */
	async assertAuthorized(token: string | null | undefined): Promise<LibraryClientId> {
		if (!token) throw unauthorizedError();
		const clientId = await this.resolveToken(token);
		if (!clientId) throw unauthorizedError();
		if (!(await this.getClient(clientId)).enabled) throw accessDisabledError(clientId);
		return clientId;
	}
}
