import { useEffect, useMemo } from "react";
import { PROJECT_CONTENT_NAMES } from "../../library/project-content.ts";
import { contentOutline, progressSections } from "../overview-content.ts";
import type { OverviewField } from "../overview-pages.ts";
import Markdown from "./Markdown.tsx";

/** Different reading tasks, backed by the same original overview fields. */
export default function OverviewContent({ field, source }: { field: OverviewField; source: string }) {
	if (!source.trim())
		return <p className="text-[16px] leading-7 text-[#555B65]">还没有填写{PROJECT_CONTENT_NAMES[field]}。</p>;
	if (field === "features") return <FeaturesContent source={source} />;
	if (field === "current") return <CurrentContent source={source} />;
	if (field === "agreements")
		return (
			<article
				aria-label={PROJECT_CONTENT_NAMES.agreements}
				className="overview-agreements max-w-[780px] text-[16px] leading-7 [&_.wmde-markdown]:text-[16px] [&_.wmde-markdown]:leading-[1.8] [&_.wmde-markdown>ul>li]:mb-6 [&_.wmde-markdown>ol>li]:mb-6 [&_.wmde-markdown>ul]:pl-6 [&_.wmde-markdown>ol]:pl-6 [&_.wmde-markdown_h2]:mt-10 [&_.wmde-markdown_h3]:mt-8"
			>
				<Markdown source={source} />
			</article>
		);
	return (
		<article
			aria-label={PROJECT_CONTENT_NAMES.description}
			className="overview-introduction max-w-[760px] text-[17px] leading-[1.8] [&_.wmde-markdown]:text-[17px] [&_.wmde-markdown]:leading-[1.8] [&_.wmde-markdown_p]:mb-6 [&_.wmde-markdown_h2]:mt-10 [&_.wmde-markdown_h3]:mt-8"
		>
			<Markdown source={source} />
		</article>
	);
}

function FeaturesContent({ source }: { source: string }) {
	const outline = useMemo(() => contentOutline(source), [source]);
	const hasDirectory = outline.length >= 3;
	useEffect(() => {
		// A direct URL with a hash may arrive before the asynchronous document is mounted.
		let id: string;
		try {
			id = decodeURIComponent(window.location.hash.slice(1));
		} catch {
			return;
		}
		if (!outline.some((item) => item.id === id)) return;
		const target = document.getElementById(id);
		if (typeof target?.scrollIntoView === "function") target.scrollIntoView({ block: "start" });
	}, [outline]);
	const route = `${window.location.pathname}${window.location.search}`;
	return (
		<div
			className={
				hasDirectory
					? "overview-features grid gap-8 min-[1200px]:grid-cols-[160px_minmax(0,1fr)] min-[1200px]:gap-10"
					: "overview-features"
			}
		>
			{hasDirectory ? (
				<nav aria-label="功能与用法目录" className="self-start min-[1200px]:sticky min-[1200px]:top-6">
					<p className="mb-3 text-[16px] font-semibold leading-7">本页内容</p>
					<ol className="grid grid-cols-1 gap-x-5 gap-y-1 min-[640px]:grid-cols-2 min-[1200px]:grid-cols-1">
						{outline.map((item) => (
							<li key={item.id}>
								<a
									className="block py-2 text-[15px] leading-6 text-[#555B65] underline-offset-4 hover:text-[#3B57D0] hover:underline focus-visible:text-[#3B57D0]"
									href={`${route}#${encodeURIComponent(item.id)}`}
								>
									{item.title}
								</a>
							</li>
						))}
					</ol>
				</nav>
			) : null}
			<article
				aria-label={PROJECT_CONTENT_NAMES.features}
				className="min-w-0 text-[16px] leading-7 [&_.wmde-markdown]:text-[16px] [&_.wmde-markdown]:leading-[1.8] [&_.wmde-markdown_h2]:mt-12 [&_.wmde-markdown_h3]:mt-10 [&_.wmde-markdown_h2]:scroll-mt-8 [&_.wmde-markdown_h3]:scroll-mt-8 [&_.wmde-markdown>h2:first-child]:mt-0 [&_.wmde-markdown>h3:first-child]:mt-0"
			>
				<Markdown source={source} headingAnchors={outline} />
			</article>
		</div>
	);
}

function CurrentContent({ source }: { source: string }) {
	const progress = useMemo(() => progressSections(source), [source]);
	const readable = (body: string) => (progress.definitions ? `${body}\n\n${progress.definitions}` : body);
	return (
		<article aria-label={PROJECT_CONTENT_NAMES.current} className="overview-current text-[16px] leading-7">
			{progress.introduction.trim() ? (
				<div className={progress.sections.length ? "mb-7" : ""}>
					<Markdown source={readable(progress.introduction)} />
				</div>
			) : null}
			{progress.sections.length ? (
				<dl className="space-y-7">
					{progress.sections.map((section, index) => (
						<div
							key={`${section.title}:${index}`}
							className={`grid gap-2 min-[640px]:grid-cols-[124px_minmax(0,1fr)] min-[640px]:gap-6 ${section.title === "下一步" ? "border-l-2 border-[#3B57D0] pl-5" : ""}`}
						>
							<dt className="text-[16px] font-semibold leading-7">{section.title}</dt>
							<dd className="min-w-0 [&_.wmde-markdown]:text-[16px] [&_.wmde-markdown]:leading-[1.8] [&_.wmde-markdown>p:last-child]:mb-0">
								<Markdown source={readable(section.body)} />
							</dd>
						</div>
					))}
				</dl>
			) : null}
		</article>
	);
}
