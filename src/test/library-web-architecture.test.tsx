import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
import ArchitecturePage from "../library-web/pages/ArchitecturePage.tsx";
import { clearDraft } from "../library-web/components/drafts.ts";

const source = `# 项目架构

项目整体说明。

## 组成关系

\`\`\`mermaid
flowchart LR
  signup[报名安排] --> venue[场地准备]
\`\`\`

## 组成说明

| 组成 ID | 名称 | 说明 | 来源 | 关联任务 |
| --- | --- | --- | --- | --- |
| signup | 报名安排 | 整理报名信息并确认参与人数。 | 用户确认 | TASK-1, TASK-2 |
| venue | 场地准备 | 根据人数安排合适的活动空间。 | | |

## 主要流程

先确认人数，再准备场地。
`;

const project = { id: "architecture-test", name: "读书会", dir: "/unused" };
const originalFetch = globalThis.fetch;
const savedGlobals = new Map<string, PropertyDescriptor | undefined>();
let root: Root | undefined;
let dom: JSDOM | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	dom?.window.close();
	dom = undefined;
	globalThis.fetch = originalFetch;
	clearDraft(project.id, "architecture");
	clearDraft(project.id, "sel:node");
	for (const [name, descriptor] of savedGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	savedGlobals.clear();
});

async function mount(content = source) {
	dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
	const globals = {
		window: dom.window,
		document: dom.window.document,
		navigator: dom.window.navigator,
		HTMLElement: dom.window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
		// No browser or diagram engine: this regression checks the actual page's DOM.
		requestAnimationFrame: () => 0,
		cancelAnimationFrame: () => {},
	};
	for (const [name, value] of Object.entries(globals)) {
		savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
	}
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.endsWith("/architecture")) return Response.json({ content, version: "v1" });
		if (url.endsWith("/tasks"))
			return Response.json([
				{ id: "TASK-1", title: "确认报名人数", status: "To Do", priority: "p0" },
				{ id: "TASK-2", title: "后续安排", status: "To Do", priority: "p1" },
			]);
		if (url.endsWith(`/projects/${project.id}`)) return Response.json({ ...project, p0: "p0" });
		throw new Error(`Unexpected request: ${url}`);
	}) as typeof fetch;
	const container = dom.window.document.getElementById("root")!;
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<MemoryRouter initialEntries={["/architecture"]}>
				<Routes>
					<Route element={<Outlet context={{ project }} />}>
						<Route path="architecture" element={<ArchitecturePage />} />
					</Route>
				</Routes>
			</MemoryRouter>,
		);
	});
	return container;
}

test("组成表只展示一次，职责默认可读，并位于主要流程之前", async () => {
	const container = await mount();
	expect(container.querySelectorAll("table").length).toBe(0);
	expect(container.textContent?.match(/整理报名信息并确认参与人数。/g)).toHaveLength(1);
	const row = container.querySelector("#comp-signup")!;
	expect(Boolean(row)).toBe(true);
	expect(row.textContent).toContain("整理报名信息并确认参与人数。");
	expect(Boolean(row.querySelector("p")?.closest("details"))).toBe(false);
	expect(container.textContent?.indexOf("各部分做什么")).toBeLessThan(container.textContent!.indexOf("主要流程"));
});

test("编辑预览与阅读使用相同布局，保留原始Markdown供编辑", async () => {
	const container = await mount();
	const edit = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "编辑")!;
	await act(async () => edit.click());
	expect(container.querySelector("textarea")?.value).toBe(source);
	expect(container.querySelectorAll("table").length).toBe(0);
	expect(container.querySelector("#comp-venue")?.textContent).toContain("根据人数安排合适的活动空间。");
	const cancel = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "取消")!;
	await act(async () => cancel.click());
});

test("没有组成表的已有架构仍完整展示，不生成空说明区", async () => {
	const container = await mount(
		"# 自由格式架构\n\n保留用户原有说明。\n\n| 时间 | 事件 |\n| --- | --- |\n| 周六 | 交流 |",
	);
	expect(container.textContent).toContain("保留用户原有说明。");
	expect(container.querySelectorAll("table")).toHaveLength(1);
	expect(container.textContent).not.toContain("各部分做什么");
});

test("点击图节点定位并突出说明，重复点击仍定位同一部分", async () => {
	const container = await mount();
	const row = container.querySelector<HTMLElement>("#comp-signup")!;
	let scrolled = 0;
	row.scrollIntoView = () => {
		scrolled++;
	};
	// Mermaid is not run in jsdom; supply the documented SVG node shape at the real event boundary.
	const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
	node.setAttribute("class", "node");
	node.setAttribute("id", "flowchart-signup-0");
	container.querySelector("pre")!.append(node);
	await act(async () => node.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true })));
	expect(row.className).toContain("bg-[#EDF0EA]");
	await act(async () => node.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true })));
	expect(row.className).toContain("bg-[#EDF0EA]");
	expect(scrolled).toBe(2);
	await act(async () => await new Promise((resolve) => setTimeout(resolve, 1850)));
	expect(row.className).not.toContain("bg-[#EDF0EA]");
	expect(row.textContent).toContain("整理报名信息并确认参与人数。");
});

test("只折叠补充信息，关联任务仍只显示P0", async () => {
	const container = await mount();
	const row = container.querySelector("#comp-signup")!;
	const details = row.querySelector("details")!;
	expect(details.open).toBe(false);
	expect(row.querySelector("h3")?.textContent).toBe("报名安排");
	await act(async () => {
		details.open = true;
		details.dispatchEvent(new dom!.window.Event("toggle"));
	});
	expect(details.textContent).toContain("来源：用户确认");
	expect(details.textContent).toContain("确认报名人数");
	expect(details.textContent).not.toContain("后续安排");
	expect(details.querySelector("a")?.getAttribute("href")).toBe(`/projects/${project.id}/tasks`);
});

test("关联任务读取失败可重试，不影响职责阅读", async () => {
	const container = await mount();
	const goodFetch = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) =>
		String(input).endsWith("/tasks")
			? Response.json({ error: "关联任务读取失败" }, { status: 500 })
			: goodFetch(input)) as typeof fetch;
	const row = container.querySelector("#comp-signup")!;
	const details = row.querySelector("details")!;
	await act(async () => {
		details.open = true;
		details.dispatchEvent(new dom!.window.Event("toggle"));
	});
	expect(row.textContent).toContain("整理报名信息并确认参与人数。");
	expect(details.textContent).not.toContain("正在读取关联任务");
	const retry = Array.from(details.querySelectorAll("button")).find((b) => b.textContent === "重试");
	expect(Boolean(retry)).toBe(true);
	globalThis.fetch = goodFetch;
	await act(async () => retry?.click());
	expect(details.textContent).toContain("确认报名人数");
	expect(details.textContent).not.toContain("重试");
});
