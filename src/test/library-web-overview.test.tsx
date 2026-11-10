import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { LibraryService } from "../library/service.ts";
import { AppSettingsStore } from "../library/settings.ts";
import App from "../library-web/App.tsx";
import { clearDraft, setDraft } from "../library-web/components/drafts.ts";
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
	for (const key of [
		"overview",
		"overview:description",
		"overview:current",
		"overview:features",
		"overview:agreements",
		"overview:criticalPaths",
		"dynamic:goals",
		"dynamic:progress",
	])
		clearDraft(project.id, key);
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
async function mount(page = "progress") {
	dom.window.history.replaceState({}, "", `/projects/${project.id}${page ? `/${page}` : ""}`);
	await act(async () => root.render(<App />));
	for (
		let i = 0;
		i < 60 &&
		!(page === ""
			? container.querySelector("#latest-progress")
			: Array.from(container.querySelectorAll("button")).some(
					(b) => b.textContent === "编辑" || b.textContent === "保存",
				));
		i++
	)
		await flush();
}
async function navigate(label: string) {
	const link = Array.from(container.querySelectorAll<HTMLAnchorElement>('[aria-label="概览页面"] a')).find(
		(a) => a.textContent === label,
	);
	if (!link) throw new Error(`Page link missing: ${label}`);
	await act(async () => link.click());
	for (
		let i = 0;
		i < 60 &&
		!Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "编辑" || b.textContent === "保存");
		i++
	)
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
	expect(article.textContent).not.toContain("参与者完成主题讨论");
	const record = article.querySelector("details")!;
	expect(record.open).toBe(false);
	await act(async () => {
		record.open = true;
	});
	await flush();
	expect(article.textContent).toContain("参与者完成主题讨论");
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

test("项目约定独立完整阅读，单页编辑与进展更新均保存到同一正文", async () => {
	await mount("agreements");
	await click("编辑");
	await fill("项目约定", "## 已确定的安排\n\n- 网页保持五个一级入口，问题在聊天确认。\n- 只使用用户主动选入的资料。");
	expect(container.querySelector('[aria-label="当前进展"]')).toBeNull();
	await click("保存");
	const o = await snapshot();
	expect(o.agreements).toContain("五个一级入口");
	expect(await disk()).toContain(o.agreements);
	expect(container.querySelector("details")).toBeNull();
	expect(container.textContent).toContain("只使用用户主动选入");
	await navigate("进展与目标");
	await click("编辑");
	await fill("当前进展", "材料入口已核对，参与者已能打开；下一步整理反馈。");
	await click("保存");
	expect((await snapshot()).agreements).toBe(o.agreements);
});

test("旧草稿分到对应页面，进展冲突保留输入并保持最新约定", async () => {
	const before = await snapshot();
	expect(
		(await api("overview", { baseVersion: before.version, agreements: "用户已明确：不增加待决定页面。" }, "PUT"))
			.status,
	).toBe(200);
	setDraft(
		project.id,
		"overview",
		JSON.stringify({
			baseVersion: before.version,
			fields: {
				description: before.description,
				goal: before.goal,
				current: "旧草稿里还没保存的详细进展。",
				features: before.features,
			},
		}),
	);
	await mount();
	expect(container.querySelector('[aria-label="项目约定"]')).toBeNull();
	expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前进展"]')?.value).toBe(
		"旧草稿里还没保存的详细进展。",
	);
	await click("保存");
	expect(container.textContent).toContain("内容已更新");
	expect(container.querySelector<HTMLTextAreaElement>('[aria-label="当前进展"]')?.value).toBe(
		"旧草稿里还没保存的详细进展。",
	);
	expect((await snapshot()).agreements).toBe("用户已明确：不增加待决定页面。");
});

test("默认概览摘取简介首句，独立详情地址保留原文，刷新直达仍选中概览", async () => {
	const o = await snapshot();
	const intro = "读书会为第一次参与的读者提供完整背景。".repeat(12);
	expect(
		(
			await api(
				"overview",
				{
					baseVersion: o.version,
					description: intro,
					current: "当前专属进展正文",
					features: "### 阅读材料\n用法专属步骤正文",
					agreements: "约定专属正文",
				},
				"PUT",
			)
		).status,
	).toBe(200);
	await mount("");
	expect(container.textContent).toContain("读书会为第一次参与的读者提供完整背景。");
	expect(container.textContent).not.toContain(intro);
	expect(container.textContent).toContain("当前专属进展正文");
	const sidebar = container.querySelector('[aria-label="项目导航"]');
	expect(sidebar?.querySelector('[aria-current="page"]')?.textContent).toBe("概览");
	const introLink = container.querySelector<HTMLAnchorElement>('a[href$="/intro"]');
	expect(introLink).not.toBeNull();
	await act(async () => introLink?.click());
	await flush();
	for (const [label, path, body, absent] of [
		["进展与目标", "progress", "当前专属进展正文", intro],
		["功能与用法", "features", "用法专属步骤正文", "当前专属进展正文"],
		["项目约定", "agreements", "约定专属正文", "用法专属步骤正文"],
		["项目简介", "intro", intro, "约定专属正文"],
	]) {
		await navigate(label!);
		expect(dom.window.location.pathname).toBe(`/projects/${project.id}${path ? `/${path}` : ""}`);
		expect(container.textContent).toContain(body!);
		expect(container.textContent).not.toContain(absent!);
		expect(container.querySelector('[aria-label="项目导航"] [aria-current="page"]')?.textContent).toBe("概览");
	}
	await act(async () => root.unmount());
	root = createRoot(container);
	await mount("features");
	expect(container.querySelector("h1")?.textContent).toBe("功能与用法");
	expect(container.textContent).toContain("用法专属步骤正文");
});

test("概览从共享记录直达重点任务和进展历史", async () => {
	const previous = await snapshot();
	const updated = await api("overview", { baseVersion: previous.version, current: "先核对阅读入口。" }, "PUT");
	expect(updated.status).toBe(200);
	const taskResponse = await api("tasks", { title: "确认阅读入口", description: "打开项目后进入资料页。" });
	expect(taskResponse.status).toBe(201);
	const task = await taskResponse.json();
	expect((await api("tasks", { title: "已完成的准备", status: "Done" })).status).toBe(201);
	expect((await api("tasks", { title: "稍后处理", priority: "p1" })).status).toBe(201);

	await mount("");
	await flush();
	const link = container.querySelector<HTMLAnchorElement>(`a[href$="/tasks?task=${task.id}"]`);
	expect(link?.textContent).toBe("确认阅读入口");
	expect(container.textContent).not.toContain("已完成的准备");
	expect(container.textContent).not.toContain("稍后处理");
	expect(container.querySelector('[aria-label="项目导航"] a[href$="/tasks"]')).toBeNull();
	await act(async () => link?.click());
	await flush();
	expect(dom.window.location.search).toBe(`?task=${task.id}`);
	expect(container.querySelector(`#task-row-${task.id}`)?.textContent).toContain("打开项目后进入资料页。");
	expect(dom.window.document.activeElement?.id).toBe(`task-row-${task.id}`);
	const back = Array.from(container.querySelectorAll<HTMLAnchorElement>("main a")).find((a) =>
		a.textContent?.includes("返回概览"),
	);
	await act(async () => back?.click());
	await flush();

	const history = container.querySelector<HTMLAnchorElement>('a[href$="/history?field=current"]');
	expect(history).not.toBeNull();
	await act(async () => history?.click());
	await flush();
	expect(dom.window.location.search).toBe("?field=current");
	expect(container.textContent).not.toContain("确认阅读入口");
	const change = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((button) =>
		button.textContent?.includes("更新概览 · 当前进展"),
	);
	expect(change).toBeDefined();
	await act(async () => change?.click());
	await flush();
	expect(container.textContent).toContain("先核对阅读入口。");
	expect(container.textContent).toContain(previous.current);
});

test("切页保留各自草稿，单页覆盖冲突不会覆盖其他页新内容", async () => {
	const original = await snapshot();
	await mount("intro");
	await click("编辑");
	await fill("项目简介", "我修改的完整简介，保留用途与使用背景。");
	await navigate("功能与用法");
	await click("编辑");
	await fill("功能与用法", "我尚未保存的详细使用步骤。");
	await navigate("项目简介");
	expect(container.querySelector<HTMLTextAreaElement>('[aria-label="项目简介"]')?.value).toContain("我修改的完整简介");
	expect(container.querySelectorAll("textarea")).toHaveLength(1);
	await click("保存");
	const saved = await snapshot();
	expect(saved.description).toContain("我修改的完整简介");
	expect(saved.current).toBe(original.current);
	await navigate("功能与用法");
	expect(container.querySelector<HTMLTextAreaElement>('[aria-label="功能与用法"]')?.value).toContain("我尚未保存");
	await click("保存");
	expect(container.textContent).toContain("内容已更新");
	await click("以我的内容覆盖");
	const final = await snapshot();
	expect(final.description).toBe(saved.description);
	expect(final.features).toContain("我尚未保存");
	expect(final.current).toBe(original.current);
	expect(await disk()).toContain(final.features);
	expect(await disk()).toContain(final.description);
});

test("概览导航已标明当前页，正文不再重复显示同名大标题且保留可访问标题", async () => {
	await mount("features");
	const main = container.querySelector("#main-content")!;
	expect(main.querySelector('[aria-label="概览页面"] [aria-current="page"]')?.textContent).toBe("功能与用法");
	const title = main.querySelector("h1")!;
	expect(title.textContent).toBe("功能与用法");
	expect(title.classList.contains("sr-only")).toBe(true);
	const header = main.querySelector("header")!;
	expect(header.querySelector('[aria-label="概览页面"]')).not.toBeNull();
	expect(Array.from(header.querySelectorAll("button")).some((b) => b.textContent === "编辑")).toBe(true);
});

test("功能目录逐项定位真实标题，完整正文、全局引用及HTML文本化保持有效", async () => {
	const before = await snapshot();
	const features =
		"# 项目使用说明\n\n## 创建项目\n\n先读[入口说明][guide]。\n\n## 读取资料\n\n资料正文完整可读。\n\n```md\n## 不应进入目录\n```\n\n## 更新进展\n\n<img src=x onerror=alert(1)>\n\n[guide]: https://example.com/guide";
	expect((await api("overview", { baseVersion: before.version, features }, "PUT")).status).toBe(200);
	await mount("features");
	const directory = container.querySelector('[aria-label="功能与用法目录"]')!;
	expect(directory).not.toBeNull();
	const links = Array.from(directory.querySelectorAll<HTMLAnchorElement>("a"));
	expect(links.map((a) => a.textContent)).toEqual(["创建项目", "读取资料", "更新进展"]);
	for (const link of links) {
		const id = decodeURIComponent(new URL(link.href).hash.slice(1));
		expect(document.getElementById(id)?.textContent).toContain(link.textContent!);
	}
	const content = container.querySelector('article[aria-label="功能与用法"]')!;
	expect(content.querySelector('a[href="https://example.com/guide"]')).not.toBeNull();
	expect(content.querySelector("img")).toBeNull();
	expect(content.textContent).toContain("<img src=x onerror=alert(1)>");
	await act(async () => links[1]!.click());
	await flush();
	expect(decodeURIComponent(dom.window.location.hash.slice(1))).toBe(
		decodeURIComponent(new URL(links[1]!.href).hash.slice(1)),
	);
	expect((await snapshot()).features).toBe(features);
	expect(await disk()).toContain(features);
});

test("少量用法无需目录；当前进展四段可直接阅读，旧文不生成推测状态", async () => {
	const before = await snapshot();
	const current =
		"## 已完成\n\n资料已保存。\n\n## 当前停点\n\n正在核对材料入口。\n\n## 未完成或未验证\n\n尚未确认另一位参与者能打开。\n\n## 下一步\n\n先用参与者的入口核对。";
	expect(
		(await api("overview", { baseVersion: before.version, current, features: "### 阅读资料\n\n完整使用步骤。" }, "PUT"))
			.status,
	).toBe(200);
	await mount("features");
	expect(container.querySelector('[aria-label="功能与用法目录"]')).toBeNull();
	expect(container.textContent).toContain("完整使用步骤");
	await navigate("进展与目标");
	const article = container.querySelector('article[aria-label="当前进展"]')!;
	expect(Array.from(article.querySelectorAll("dt")).map((n) => n.textContent)).toEqual([
		"已完成",
		"当前停点",
		"未完成或未验证",
		"下一步",
	]);
	expect(article.textContent).toContain("尚未确认另一位参与者能打开");
	expect(article.querySelector("dd:last-child")?.textContent).toContain("资料已保存");
	expect((await snapshot()).current).toBe(current);
	const latest = await snapshot();
	const old = "材料已经整理好，正在确认参与者能否打开，日期还没定。";
	expect((await api("overview", { baseVersion: latest.version, current: old }, "PUT")).status).toBe(200);
	await navigate("项目简介");
	await navigate("进展与目标");
	const legacy = container.querySelector('article[aria-label="当前进展"]')!;
	expect(legacy.textContent).toBe(old);
	expect(legacy.querySelector("dt")).toBeNull();
});
