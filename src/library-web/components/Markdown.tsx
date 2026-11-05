import { useEffect, useRef } from "react";
import MDEditor from "@uiw/react-md-editor";
import { renderMermaidIn } from "../../web/utils/mermaid";

/**
 * Remark plugin that switches HTML syntax off in the Markdown parser, so tag-like text such
 * as `<repo>` is always plain text and the preview shows it as written, in prose and in code alike.
 *
 * This is also what keeps HTML in Markdown files inert. The preview library turns any HTML
 * the parser reports into real elements, and its `skipHtml` option does not switch that step
 * off, so `<script>`, `<img onerror=...>` and type strings such as `Result<List<MenuItem>>`
 * must never be reported as HTML. Autolinks (`<https://example.com>`, `<user@example.com>`)
 * are separate Markdown syntax and still link.
 * Mermaid diagrams are drawn from code blocks afterwards; `renderMermaidIn` keeps HTML out of those.
 */
function treatHtmlAsText(this: { data(): object }): void {
	// The processor's shared settings, where the Markdown parser looks up its extensions.
	const settings: { micromarkExtensions?: unknown[] } = this.data();
	settings.micromarkExtensions ??= [];
	// "htmlFlow" is block-level HTML and "htmlText" is inline HTML in micromark, the parser behind remark.
	settings.micromarkExtensions.push({ disable: { null: ["htmlFlow", "htmlText"] } });
}

function keepHashLinksInCurrentRoute(url: string, key: string): string {
	if (key !== "href" || !url.startsWith("#") || typeof window === "undefined") {
		return url;
	}

	return `${window.location.pathname}${window.location.search}${url}`;
}

const REMARK_PLUGINS = [treatHtmlAsText];

/**
 * 项目内容受控渲染器：Markdown + Mermaid（securityLevel strict，HTML 全部
 * 文本化）。与 src/web 的 MermaidMarkdown 同一渲染链，只是不接任务 ID 链接。
 */
export default function Markdown({ source }: { source: string }) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!ref.current) return;

		// Render mermaid diagrams after the markdown has been rendered
		// Use requestAnimationFrame to ensure MDEditor has finished rendering
		const frameId = requestAnimationFrame(() => {
			if (ref.current) {
				void renderMermaidIn(ref.current);
			}
		});

		return () => cancelAnimationFrame(frameId);
	}, [source]);

	return (
		<div ref={ref} className="wmde-markdown">
			<MDEditor.Markdown source={source} urlTransform={keepHashLinksInCurrentRoute} remarkPlugins={REMARK_PLUGINS} />
		</div>
	);
}
