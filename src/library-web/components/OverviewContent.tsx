import { useEffect, useMemo } from "react";
import { PROJECT_CONTENT_NAMES } from "../../library/project-content.ts";
import { contentOutline, introductionSubtitle, progressSections } from "../overview-content.ts";
import type { OverviewField } from "../overview-pages.ts";
import Markdown from "./Markdown.tsx";

/** Different reading tasks, backed by the same original overview fields. */
export default function OverviewContent({
	field,
	source,
}: {
	field: Exclude<OverviewField, "current">;
	source: string;
}) {
	if (!source.trim())
		return <p className="text-[16px] leading-7 text-[#595F59]">还没有填写{PROJECT_CONTENT_NAMES[field]}。</p>;
	if (field === "features") return <FeaturesContent source={source} />;
	if (field === "agreements" || field === "criticalPaths")
		return (
			<article
				aria-label={PROJECT_CONTENT_NAMES[field]}
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
									className="block py-2 text-[15px] leading-6 text-[#595F59] underline-offset-4 hover:text-[#315DAD] hover:underline focus-visible:text-[#315DAD]"
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

export function CurrentContent({ source }: { source: string }) {
	const progress = useMemo(() => progressSections(source), [source]);
	const excerpt = useMemo(
		() =>
			progress.sections.length === 0 && progress.introduction.length > 300
				? introductionSubtitle(progress.introduction)
				: "",
		[progress],
	);
	const sections = progress.sections.filter(({ title }) => title !== "已完成");
	const prominent = sections.some(({ title }) => title !== "未完成或未验证");
	const order = ["当前停点", "下一步", "需要你决定", "未完成或未验证"];
	const ordered = [...sections].sort((a, b) => order.indexOf(a.title) - order.indexOf(b.title));
	const readable = (body: string) => (progress.definitions ? `${body}\n\n${progress.definitions}` : body);
	return (
		<article
			aria-label={PROJECT_CONTENT_NAMES.current}
			className="overview-current max-w-[760px] space-y-5 text-[15px] leading-[26px] text-[#242724]"
		>
			{excerpt ? (
				<details className="group">
					<summary className="cursor-pointer list-none py-1 text-[14px] text-[#595F59] hover:text-[#315DAD] [&::-webkit-details-marker]:hidden">
						<span className="mb-2 line-clamp-3 break-words text-[15px] leading-6 text-[#242724] group-open:hidden">
							{excerpt}
						</span>
						<span className="inline-flex items-center gap-1">
							<span aria-hidden="true" className="group-open:rotate-90">
								▸
							</span>
							完整进展
						</span>
					</summary>
					<div className="pt-2">
						<Markdown source={readable(progress.introduction)} />
					</div>
				</details>
			) : progress.introduction.trim() ? (
				<Markdown source={readable(progress.introduction)} />
			) : null}
			{ordered.length ? (
				<dl className="space-y-5">
					{ordered.map(({ title, body }, index) => {
						const key = `${title}:${index}`;
						if (title === "未完成或未验证" && prominent) {
							return (
								<div key={key}>
									<dt className="sr-only">{title}</dt>
									<dd>
										<details>
											<summary className="w-fit cursor-pointer py-1 text-[14px] text-[#595F59] hover:text-[#315DAD]">
												{title}
											</summary>
											<div className="pt-2">
												<Markdown source={readable(body)} />
											</div>
										</details>
									</dd>
								</div>
							);
						}
						const needsDecision = title === "需要你决定";
						const nextStep = title === "下一步";
						return (
							<div
								key={key}
								className={
									needsDecision
										? "rounded-md bg-[#FBF4E5] px-4 py-3"
										: nextStep
											? "border-l-2 border-[#687A68] pl-4"
											: ""
								}
							>
								<dt
									className={
										needsDecision
											? "mb-2 text-[14px] font-semibold text-[#805719]"
											: "mb-2 text-[14px] font-semibold text-[#595F59]"
									}
								>
									{title}
								</dt>
								<dd className="min-w-0 [&_.wmde-markdown]:text-[15px] [&_.wmde-markdown]:leading-[26px] [&_.wmde-markdown>p:last-child]:mb-0">
									<Markdown source={readable(body)} />
								</dd>
							</div>
						);
					})}
				</dl>
			) : !progress.introduction.trim() ? (
				<p className="text-[#595F59]">暂无当前进展。</p>
			) : null}
		</article>
	);
}
