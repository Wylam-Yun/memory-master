import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "../library-web/components/Markdown.tsx";

const vendorCss = readFileSync(
	new URL("../../node_modules/@uiw/react-markdown-preview/markdown.css", import.meta.url),
	"utf8",
);

/** jsdom has no OS theme. Activate the installed vendor's real media rules explicitly. */
function cssForPreference(preference: "light" | "dark") {
	const dom = new JSDOM("<style></style>");
	try {
		dom.window.document.querySelector("style")!.textContent = vendorCss;
		return Array.from(dom.window.document.styleSheets[0]!.cssRules)
			.flatMap((rule) => {
				if (rule instanceof dom.window.CSSMediaRule) {
					return rule.conditionText === `(prefers-color-scheme: ${preference})`
						? Array.from(rule.cssRules, (child) => child.cssText)
						: [];
				}
				return rule.cssText;
			})
			.join("\n");
	} finally {
		dom.window.close();
	}
}

for (const preference of ["dark", "light"] as const) {
	test(`正文与页面统一为浅色，不受系统${preference}偏好影响`, () => {
		const html = renderToStaticMarkup(<Markdown source={"# 项目架构\n\n各部分的职责说明。\n\n`示例`"} />);
		const dom = new JSDOM(`<style>${cssForPreference(preference)}</style><main>${html}</main>`);
		try {
			const blocks = dom.window.document.querySelectorAll<HTMLElement>(".wmde-markdown");
			expect(blocks.length).toBeGreaterThan(0);
			for (const block of blocks) {
				const style = dom.window.getComputedStyle(block);
				expect(style.getPropertyValue("--color-canvas-default").trim()).toBe("#ffffff");
				expect(style.colorScheme).toBe("light");
				expect(style.backgroundColor).toBe("rgba(0, 0, 0, 0)");
			}
			expect(dom.window.document.querySelector("p")?.textContent).toBe("各部分的职责说明。");
		} finally {
			dom.window.close();
		}
	});
}
