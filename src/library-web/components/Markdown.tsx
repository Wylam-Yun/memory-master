import { useEffect, useMemo, useRef } from "react";
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
// The library workspace has a fixed light palette. Do not let the preview's
// independent prefers-color-scheme rules paint dark rectangles inside it.
const CONTENT_STYLE = { backgroundColor: "transparent", color: "inherit" };

/**
 * 项目内容受控渲染器：Markdown + Mermaid（securityLevel strict，HTML 全部
 * 文本化）。与 src/web 的 MermaidMarkdown 同一渲染链，只是不接任务 ID 链接。
 */
interface HeadingAnchor {
	line: number;
	id: string;
}
interface MarkdownNode {
	type?: string;
	tagName?: string;
	position?: { start?: { line?: number } };
	properties?: Record<string, unknown>;
	children?: MarkdownNode[];
}
const NO_ANCHORS: readonly HeadingAnchor[] = [];

export default function Markdown({
	source,
	headingAnchors = NO_ANCHORS,
}: {
	source: string;
	headingAnchors?: readonly HeadingAnchor[];
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const rehypePlugins = useMemo(() => {
		if (!headingAnchors.length) return [];
		const ids = new Map(headingAnchors.map((item) => [item.line, item.id]));
		return [
			function applyHeadingAnchors() {
				return (tree: unknown) => {
					const visit = (node: MarkdownNode) => {
						const line = node.position?.start?.line;
						const id = line === undefined ? undefined : ids.get(line);
						if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "") && id) {
							node.properties ??= {};
							node.properties.id = id;
						}
						if (Array.isArray(node.children)) node.children.forEach(visit);
					};
					visit(tree as MarkdownNode);
				};
			},
		];
	}, [headingAnchors]);

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
		<div ref={ref} className="wmde-markdown" data-color-mode="light" style={CONTENT_STYLE}>
			<MDEditor.Markdown
				source={source}
				style={CONTENT_STYLE}
				urlTransform={keepHashLinksInCurrentRoute}
				remarkPlugins={REMARK_PLUGINS}
				rehypePlugins={rehypePlugins}
			/>
		</div>
	);
}
