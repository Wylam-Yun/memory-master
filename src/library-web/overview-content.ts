import { fromMarkdown } from "mdast-util-from-markdown";
import { CURRENT_PROGRESS_HEADINGS } from "../library/project-content.ts";

export interface ContentHeading {
	title: string;
	id: string;
	line: number;
}

function plainText(node: unknown): string {
	if (!node || typeof node !== "object") return "";
	if ("value" in node && typeof node.value === "string") return node.value;
	if ("children" in node && Array.isArray(node.children)) return node.children.map(plainText).join("");
	return "";
}

export function introductionSubtitle(source: string): string {
	const paragraph = fromMarkdown(source).children.find((node) => node.type === "paragraph");
	const text = plainText(paragraph).replace(/\s+/g, " ").trim();
	return (
		new Intl.Segmenter(undefined, { granularity: "sentence" })
			.segment(text)
			[Symbol.iterator]()
			.next()
			.value?.segment.trim() ?? ""
	);
}

export function featurePreview(source: string) {
	const chapters = contentOutline(source);
	const first = chapters[0];
	if (!first) return null;
	const root = fromMarkdown(source);
	const lines = source.split("\n");
	const next = chapters[1];
	const heading = root.children.find((node) => node.type === "heading" && node.position?.start.line === first.line);
	const chapter = lines.slice(heading?.position?.end.line ?? first.line, next ? next.line - 1 : undefined).join("\n");
	const opening = fromMarkdown(chapter).children[0];
	const end = opening?.type === "paragraph" ? (opening.position?.end.offset ?? 0) : 0;
	const definitions = root.children
		.filter((node) => node.type === "definition")
		.map((node) => source.slice(node.position?.start.offset, node.position?.end.offset))
		.join("\n");
	return {
		title: first.title,
		purpose: chapter.slice(0, end).trim(),
		steps: chapter.slice(end).trim(),
		older: next ? lines.slice(next.line - 1).join("\n") : "",
		definitions,
	};
}

/** Root headings only: code fences and nested list content never become navigation. */
export function contentOutline(source: string): ContentHeading[] {
	const headings = fromMarkdown(source).children.filter((node) => node.type === "heading");
	if (!headings.length) return [];
	const shallowest = Math.min(...headings.map((node) => node.depth));
	// A lone leading document title introduces the chapters rather than being their only entry.
	const hasDocumentTitle =
		headings.length > 1 &&
		headings[0]?.depth === shallowest &&
		headings.filter((node) => node.depth === shallowest).length === 1;
	const chapters = hasDocumentTitle ? headings.slice(1) : headings;
	const depth = Math.min(...chapters.map((node) => node.depth));
	const used = new Set<string>();
	return chapters
		.filter((node) => node.depth === depth)
		.flatMap((node) => {
			const title = plainText(node).trim();
			const line = node.position?.start.line;
			if (!title || line === undefined) return [];
			const slug =
				title
					.normalize("NFC")
					.toLowerCase()
					.replace(/[^\p{L}\p{N}]+/gu, "-")
					.replace(/^-|-$/g, "") || "section";
			const base = `mm-feature-${slug}`;
			let id = base;
			let occurrence = 2;
			while (used.has(id)) id = `${base}-${occurrence++}`;
			used.add(id);
			return [{ title, id, line }];
		});
}

export interface ProgressDocument {
	introduction: string;
	sections: { title: (typeof CURRENT_PROGRESS_HEADINGS)[number]; body: string }[];
	definitions: string;
}

/** Read explicit headings without inventing a status or extracting a second summary. */
export function progressSections(source: string): ProgressDocument {
	const root = fromMarkdown(source);
	const headings = root.children.filter(
		(node) => node.type === "heading" && CURRENT_PROGRESS_HEADINGS.some((title) => title === plainText(node).trim()),
	);
	if (!headings.length) return { introduction: source, sections: [], definitions: "" };
	const definitions = root.children
		.filter((node) => node.type === "definition")
		.map((node) => source.slice(node.position?.start.offset, node.position?.end.offset))
		.join("\n");
	return {
		introduction: source.slice(0, headings[0]?.position?.start.offset).trim(),
		sections: headings.flatMap((heading, index) => {
			const body = source
				.slice(heading.position?.end.offset, headings[index + 1]?.position?.start.offset ?? source.length)
				.trim();
			return body ? [{ title: plainText(heading).trim() as (typeof CURRENT_PROGRESS_HEADINGS)[number], body }] : [];
		}),
		definitions,
	};
}
