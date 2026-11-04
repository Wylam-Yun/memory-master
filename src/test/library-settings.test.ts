import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppSettingsStore } from "../library/settings.ts";
import { LIBRARY_ERROR_CODES, LibraryError } from "../library/types.ts";

let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-settings-"));
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

describe("AppSettingsStore", () => {
	it("returns safe defaults when no settings file exists", async () => {
		const store = new AppSettingsStore(home);
		const settings = await store.getSettings();

		expect(settings.libraryRoot).toBeNull();
		expect(settings.port).toBe(6420);
		expect(settings.clients.codex).toEqual({
			enabled: false,
			token: null,
			connection: "none",
			installError: null,
			lastSeenAt: null,
		});
		expect(settings.clients["claude-code"]).toEqual({
			enabled: false,
			token: null,
			connection: "none",
			installError: null,
			lastSeenAt: null,
		});
	});

	it("persists library root and port across instances (service restart)", async () => {
		const store = new AppSettingsStore(home);
		await store.setLibraryRoot("/tmp/my-library");

		const restarted = new AppSettingsStore(home);
		expect(await restarted.getLibraryRoot()).toBe("/tmp/my-library");
		expect(await restarted.getPort()).toBe(6420);
	});

	it("generates a credential on first enable and reuses it on re-enable", async () => {
		const store = new AppSettingsStore(home);

		const enabled = await store.setClientEnabled("codex", true);
		expect(enabled.enabled).toBe(true);
		expect(enabled.token).toMatch(/^mm_codex_[0-9a-f]{32}$/);

		await store.setClientEnabled("codex", false);
		const reenabled = await store.setClientEnabled("codex", true);
		expect(reenabled.token).toBe(enabled.token);

		const other = await store.setClientEnabled("claude-code", true);
		expect(other.token).toMatch(/^mm_claude_[0-9a-f]{32}$/);
		expect(other.token).not.toBe(enabled.token);
	});

	it("restores enabled state and tokens after a restart", async () => {
		const store = new AppSettingsStore(home);
		const { token } = await store.setClientEnabled("claude-code", true);

		const restarted = new AppSettingsStore(home);
		expect(await restarted.getClient("claude-code")).toEqual({
			enabled: true,
			token,
			connection: "configured",
			installError: null,
			lastSeenAt: null,
			setupGeneration: 1,
		});
		expect(await restarted.getClient("codex")).toEqual({
			enabled: false,
			token: null,
			connection: "none",
			installError: null,
			lastSeenAt: null,
			setupGeneration: 0,
		});
	});

	it("resolves tokens to clients and enforces the current enabled state", async () => {
		const store = new AppSettingsStore(home);
		const { token } = await store.setClientEnabled("codex", true);

		expect(await store.resolveToken(token!)).toBe("codex");
		expect(await store.resolveToken("mm_codex_wrong")).toBeNull();
		// Enabled + configured is not yet authorized — the client must connect first.
		expect(await store.isAuthorized(token)).toBe(false);
		await store.markConnected("codex");
		expect(await store.isAuthorized(token)).toBe(true);
		expect(await store.isAuthorized("mm_codex_wrong")).toBe(false);
		expect(await store.isAuthorized(null)).toBe(false);

		// Revocation takes effect on the very next check — the same credential is refused.
		await store.setClientEnabled("codex", false);
		expect(await store.isAuthorized(token)).toBe(false);
		expect(await store.resolveToken(token!)).toBe("codex"); // still identifies, just not authorized
	});

	it("assertAuthorized distinguishes unknown credentials from disabled clients", async () => {
		const store = new AppSettingsStore(home);
		const { token } = await store.setClientEnabled("codex", true);
		await store.setClientEnabled("codex", false);

		await expect(store.assertAuthorized("nope")).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.UNAUTHORIZED,
			status: 401,
		});
		await expect(store.assertAuthorized(token)).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.ACCESS_DISABLED,
			status: 403,
		});
		expect(await store.assertAuthorized(token).catch((e) => e)).toBeInstanceOf(LibraryError);

		// Re-enabled but not yet connected: the probe gate still applies.
		await store.setClientEnabled("codex", true);
		await expect(store.assertAuthorized(token)).rejects.toMatchObject({
			code: LIBRARY_ERROR_CODES.CONNECTION_PENDING,
			status: 403,
		});
		await store.markConnected("codex");
		expect(await store.assertAuthorized(token)).toBe("codex");
	});

	it("serializes concurrent mutations without losing either one", async () => {
		const store = new AppSettingsStore(home);
		await Promise.all([
			store.setClientEnabled("codex", true),
			store.setClientEnabled("claude-code", true),
			store.setLibraryRoot("/tmp/lib"),
		]);
		const settings = await new AppSettingsStore(home).getSettings();
		expect(settings.clients.codex.enabled).toBe(true);
		expect(settings.clients["claude-code"].enabled).toBe(true);
		expect(settings.libraryRoot).toBe("/tmp/lib");
	});
});
