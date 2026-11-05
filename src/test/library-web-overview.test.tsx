import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import OverviewPage from "../library-web/pages/OverviewPage.tsx";
import { clearDraft } from "../library-web/components/drafts.ts";
import { setNativeInputValue } from "./react-dom-input.ts";

let home: string,
	base: string,
	project: { id: string; name: string; dir: string },
	dom: JSDOM,
	root: Root,
	container: HTMLElement,
	service: LibraryService;
const nativeFetch = globalThis.fetch;
const saved = new Map<string, PropertyDescriptor | undefined>();
const api = async (path: string, body?: unknown, method = body ? "POST" : "GET") =>
	nativeFetch(`${base}/api/projects/${project.id}/${path}`, {
		method,
		headers: body ? { "content-type": "application/json" } : {},
		...(body ? { body: JSON.stringify(body) } : {}),
	});
const snapshot = async () => {
	let result: Awaited<ReturnType<Response["json"]>>;
	await act(async () => {
		result = await (await api("overview")).json();
		await new Promise((r) => setTimeout(r, 20));
	});
	return result;
};
const flush = async () => {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 30));
	});
};
const findButton = (text: string, scope: ParentNode = container) => {
	const b = Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find((x) => x.textContent === text);
	if (!b) throw new Error(`Button missing: ${text}`);
	return b;
};
const click = async (text: string, scope: ParentNode = container) => {
	await act(async () => findButton(text, scope).click());
	await flush();
};
const fill = async (label: string, value: string) => {
	const el = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`);
	if (!el) throw new Error(`Input missing: ${label}`);
	await act(async () => setNativeInputValue(el, value));
};
const disk = () => readFile(join(project.dir, "memaster/overview.md"), "utf8");

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "mm-overview-dom-"));
	const settings = new AppSettingsStore(home);
	await settings.setLibraryRoot(join(home, "library"));
	service = new LibraryService({ settings });
	await service.start(0);
	base = service.baseUrl();
	project = await (
		await nativeFetch(`${base}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "读书会" }),
		})
	).json();
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
		Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
	}
	Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		nativeFetch(new URL(String(input), base), init)) as typeof fetch;
	container = document.getElementById("root")!;
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	for (const key of ["overview", "dynamic:goals", "dynamic:progress"]) clearDraft(project.id, key);
	dom.window.close();
	globalThis.fetch = nativeFetch;
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
	await service.stop();
	await rm(home, { recursive: true, force: true });
});
async function mount() {
	await act(async () =>
		root.render(
			<MemoryRouter>
				<Routes>
					<Route element={<Outlet context={{ project }} />}>
						<Route path="/" element={<OverviewPage />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		),
	);
	await flush();
}

test("人在概览创建目标、完成并展开归档，服务器文件确实改变", async () => {
	await mount();
	await click("添加目标");
	await fill("目标内容", "让大家完成第一次阅读交流");
	await click("保存");
	expect((await snapshot()).goals[0].title).toBe("让大家完成第一次阅读交流");
	expect(await disk()).toContain("让大家完成第一次阅读交流");
	await click("完成");
	await click("保存");
	expect((await snapshot()).goals).toHaveLength(0);
	const details = Array.from(container.querySelectorAll("details")).find((e) =>
		e.querySelector("summary")?.textContent?.startsWith("已完成目标"),
	)!;
	expect(details.open).toBe(false);
	await act(async () => {
		details.open = true;
		await new Promise((r) => setTimeout(r, 30));
	});
	await flush();
	expect(details.textContent).toContain("让大家完成第一次阅读交流");
	expect(details.textContent).toContain("完成于");
	expect((await disk()).includes('"status": "completed"')).toBe(true);
});

test("关键阶段的详细成果能保存与修正，归档只在展开时读取并分页", async () => {
	for (let i = 0; i < 21; i++) {
		const o = await snapshot();
		expect(
			(
				await api("progress", {
					baseVersion: o.version,
					key: `p-${i}`,
					title: `已有成果${i}`,
					summary: `第${i}项的详细成果说明。`,
					completedAt: null,
				})
			).status,
		).toBe(200);
	}
	let reads = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input).includes("/progress?")) reads++;
		return realFetch(input, init);
	}) as typeof fetch;
	await mount();
	expect(reads).toBe(0);
	await click("记录阶段成果");
	await fill("成果标题", "完成首次交流");
	await fill("成果说明", "参与者完成主题讨论，阅读材料已发给大家。尚未收集长期反馈，后续继续跟进。");
	await click("保存");
	expect((await snapshot()).archiveCounts.progress).toBe(22);
	expect(await disk()).toContain("参与者完成主题讨论");
	const details = Array.from(container.querySelectorAll("details")).find((e) =>
		e.querySelector("summary")?.textContent?.startsWith("阶段进展"),
	)!;
	await act(async () => {
		details.open = true;
		await new Promise((r) => setTimeout(r, 30));
	});
	await flush();
	expect(reads).toBeGreaterThan(0);
	expect(details.querySelectorAll("article").length).toBe(20);
	await click("显示更多", details);
	expect(details.querySelectorAll("article").length).toBe(22);
	const article = Array.from(details.querySelectorAll("article")).find((e) => e.textContent?.includes("完成首次交流"))!;
	await click("修正记录", article);
	await fill("成果说明", "交流完成后，阅读材料与主题讨论记录均已发给参与者。");
	await click("保存");
	expect(await disk()).toContain("阅读材料与主题讨论记录均已发给参与者");
	expect((await snapshot()).archiveCounts.progress).toBe(22);
});

test("并发冲突保留输入，经明确核对后重试，最新简报不会被目标操作覆盖", async () => {
	await mount();
	await click("添加目标");
	await fill("目标内容", "保留我的目标输入");
	const o = await snapshot();
	expect(
		(
			await api(
				"overview",
				{ baseVersion: o.version, current: "另一位Agent已准备好材料，正在确认场地，日期尚未决定。" },
				"PUT",
			)
		).status,
	).toBe(200);
	await click("保存");
	expect(container.querySelector<HTMLInputElement>('[aria-label="目标内容"]')?.value).toBe("保留我的目标输入");
	expect(container.textContent).toContain("你的输入已保留");
	await click("核对后按最新版本保存");
	expect((await snapshot()).goals[0].title).toBe("保留我的目标输入");
	expect((await snapshot()).current).toContain("日期尚未决定");
});

test("修正归档日期时保留原日期，未知日期不会自动变成今天", async () => {
	const o = await snapshot();
	const g = await (await api("goals", { baseVersion: o.version, key: "date-test", title: "完成材料整理" })).json();
	const next = await snapshot();
	expect(
		(await api(`goals/${g.id}`, { baseVersion: next.version, status: "completed", occurredAt: "2026-01-01" }, "PUT"))
			.status,
	).toBe(200);
	await mount();
	const details = Array.from(container.querySelectorAll("details")).find((e) =>
		e.querySelector("summary")?.textContent?.startsWith("已完成目标"),
	)!;
	await act(async () => {
		details.open = true;
		await new Promise((r) => setTimeout(r, 30));
	});
	await flush();
	await click("修正日期", details);
	expect(container.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-01-01");
	const form = container.querySelector("form")!;
	const unknown = form.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
	await act(async () => unknown.click());
	await click("保存");
	expect((await (await api(`goals/${g.id}`)).json()).completedAt).toBeNull();
	await flush();
	await click("修正日期", details);
	expect(container.querySelector<HTMLInputElement>('form input[type="checkbox"]')?.checked).toBe(true);
});
