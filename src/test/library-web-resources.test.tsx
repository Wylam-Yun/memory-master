import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import App from "../library-web/App.tsx";

let home: string;
let base: string;
let project: { id: string; dir: string };
let dom: JSDOM;
let root: Root;
let container: HTMLElement;
let service: LibraryService;
const nativeFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
const request = async (path: string, body?: unknown) =>
	nativeFetch(`${base}/api/projects/${project.id}/${path}`, {
		method: body ? "POST" : "GET",
		headers: body ? { "content-type": "application/json" } : {},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
const flush = async () => {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
};
const click = async (text: string) => {
	const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text);
	if (!button) throw new Error(`Missing button ${text}`);
	await act(async () => button.click());
	await flush();
};
const upload = async (text: string) =>
	request("resources", { name: "50%资料.md", base64: Buffer.from(text).toString("base64") });
const file = () => Bun.file(join(project.dir, "资料", "50%资料.md"));
const mount = async (detail = false) => {
	await act(async () => {
		window.history.replaceState(
			{},
			"",
			`/projects/${project.id}/resources${detail ? `/${encodeURIComponent("50%资料.md")}` : ""}`,
		);
		root.render(<App />);
	});
	for (let attempt = 0; attempt < 30; attempt++) {
		await flush();
		if (container.querySelector('[aria-label="删除 50%资料.md"]')) return;
	}
	throw new Error(`Resource page did not finish loading: ${container.textContent}`);
};

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-resource-dom-"));
	const settings = new AppSettingsStore(home);
	await settings.setLibraryRoot(join(home, "library"));
	service = new LibraryService({ settings });
	await service.start(0);
	base = service.baseUrl();
	project = await (
		await nativeFetch(`${base}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "资料测试" }),
		})
	).json();
	await upload("# 已上传的资料");
	dom = new JSDOM("<div id='root'></div>", { url: base });
	for (const [name, value] of Object.entries({
		window: dom.window,
		document: dom.window.document,
		navigator: dom.window.navigator,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (): number => 0,
		cancelAnimationFrame: () => {},
	})) {
		saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		nativeFetch(new URL(String(input), base), init)) as typeof fetch;
	const element = document.getElementById("root");
	if (!element) throw new Error("Missing test container");
	container = element;
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	dom.window.close();
	globalThis.fetch = nativeFetch;
	for (const [name, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	saved.clear();
	await service.stop();
	await rm(home, { recursive: true, force: true });
});

test("资料列表提供删除入口，取消保留文件，确认后刷新列表并记录历史", async () => {
	await mount();
	await click("删除");
	expect(container.querySelector('[role="dialog"]')?.textContent).toContain("50%资料.md");
	expect(await file().exists()).toBe(true);
	await click("取消");
	expect(await file().exists()).toBe(true);
	expect(container.querySelector('[role="dialog"]')).toBeNull();
	await click("删除");
	await click("确认删除");
	expect(await file().exists()).toBe(false);
	expect(container.textContent).toContain("暂无资料");
	const history = await (await request("history")).json();
	expect(
		history.some(
			(entry: { action: string; target: { id: string } }) =>
				entry.action === "delete" && entry.target.id === "50%资料.md",
		),
	).toBe(true);
});

test("资料详情页提供删除入口，确认后返回资料列表", async () => {
	await mount(true);
	expect(container.textContent).toContain("已上传的资料");
	await click("删除");
	await click("确认删除");
	expect(await file().exists()).toBe(false);
	expect(window.location.pathname).toBe(`/projects/${project.id}/resources`);
	for (let attempt = 0; attempt < 30 && !container.textContent?.includes("暂无资料"); attempt++) await flush();
	expect(container.textContent).toContain("暂无资料");
});

test("同名资料被替换后拒绝删除，显示冲突且保留新文件", async () => {
	await mount();
	await click("删除");
	await upload("新资料内容");
	await click("确认删除");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("资料已被替换");
	expect(await file().text()).toBe("新资料内容");
	expect(container.querySelector('[role="dialog"]')).not.toBeNull();
	await click("取消");
	expect(await file().text()).toBe("新资料内容");
});
