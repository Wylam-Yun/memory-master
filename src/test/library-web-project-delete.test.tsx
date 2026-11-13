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
const mount = async (detail = false) => {
	await act(async () => {
		window.history.replaceState({}, "", detail ? `/projects/${project.id}` : "/");
		root.render(<App />);
	});
	for (let attempt = 0; attempt < 30; attempt++) {
		await flush();
		if (container.querySelector('[aria-label="删除项目 资料测试"]')) return;
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

test("项目列表可取消与确认删除，删除后更新列表", async () => {
	await mount();
	await click("删除项目");
	expect(container.querySelector('[role="dialog"]')?.textContent).toContain("资料测试");
	expect(container.querySelector('[role="dialog"]')?.textContent).toContain("回收目录");
	await click("取消");
	expect((await nativeFetch(`${base}/api/projects/${project.id}`)).status).toBe(200);
	await click("删除项目");
	await click("确认删除");
	for (let attempt = 0; attempt < 30 && !container.textContent?.includes("还没有项目"); attempt++) await flush();
	expect(container.textContent).toContain("还没有项目");
	expect((await nativeFetch(`${base}/api/projects/${project.id}`)).status).toBe(404);
});

test("项目概览显示删除入口，确认后返回所有项目", async () => {
	await mount(true);
	await click("删除项目");
	await click("确认删除");
	for (let attempt = 0; attempt < 30 && !container.textContent?.includes("还没有项目"); attempt++) await flush();
	expect(window.location.pathname).toBe("/");
	expect(container.textContent).toContain("还没有项目");
});

test("确认窗口打开后项目发生变化会提示冲突并保留项目", async () => {
	await mount();
	await click("删除项目");
	await request("tasks", { title: "Agent 新建任务" });
	await click("确认删除");
	expect(container.querySelector('[role="alert"]')?.textContent).toContain("项目内容已更新");
	expect((await nativeFetch(`${base}/api/projects/${project.id}`)).status).toBe(200);
});
