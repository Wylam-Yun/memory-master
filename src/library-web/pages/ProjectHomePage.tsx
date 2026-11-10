import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Progress } from "../../library/tracking.ts";
import { api, type ProjectOverview, type Task } from "../api.ts";
import { useProject } from "../components/AppShell.tsx";
import { dateLabel, Goals, StageProgress } from "../components/GoalProgress.tsx";
import Markdown from "../components/Markdown.tsx";
import { CurrentContent } from "../components/OverviewContent.tsx";
import { ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import { featurePreview, introductionSubtitle, progressSections } from "../overview-content.ts";
import { overviewPagePath } from "../overview-pages.ts";
import { isDoneStatus, isP0Task } from "../utils.ts";

const linkStyle = "text-[15px] font-medium text-[#3B57D0] hover:underline";
const headingStyle = "text-[20px] font-semibold leading-7";

export default function ProjectHomePage() {
	const project = useProject();
	return <ProjectHome key={project.id} projectId={project.id} name={project.name} />;
}

function ProjectHome({ projectId, name }: { projectId: string; name: string }) {
	const [overview, setOverview] = useState<ProjectOverview | null>(null);
	const [error, setError] = useState<unknown>(null);
	const load = useCallback(async () => {
		try {
			setOverview(await api.getOverview(projectId));
			setError(null);
		} catch (e) {
			setError(e);
		}
	}, [projectId]);
	useEffect(() => {
		void load();
		const refresh = () => void load();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [load]);

	const description = overview?.description ?? "";
	const subtitle = useMemo(() => introductionSubtitle(description), [description]);
	const current = overview?.current ?? "";
	const progress = useMemo(() => progressSections(current), [current]);
	const completed = progress.sections
		.filter(({ title }) => title === "已完成")
		.map(({ body }) => body)
		.join("\n\n");
	const path = (section: string) => overviewPagePath(projectId, section);

	return (
		<div className="max-w-[1040px] space-y-7">
			<header>
				<h1 className="break-words text-[28px] font-semibold leading-9">{name}</h1>
				{subtitle ? <p className="mt-1 break-words text-[14px] leading-6 text-[#555B65]">{subtitle}</p> : null}
				<Link className={linkStyle} to={path("intro")}>
					完整简介
				</Link>
			</header>
			<ErrorNote error={error} onRetry={() => void load()} />
			{!overview ? (
				error ? null : (
					<LoadingNote />
				)
			) : (
				<>
					<section className="min-w-0 border-l-2 border-[#3B57D0] bg-[#EEF2FF] p-4" aria-labelledby="latest-progress">
						<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-2">
							<h2 id="latest-progress" className={headingStyle}>
								最新进展
							</h2>
							<div className="flex flex-wrap gap-x-4 gap-y-1">
								<Link className={linkStyle} to={path("progress")}>
									进展与目标
								</Link>
								<Link className={linkStyle} to={path("history?field=current")}>
									历次进展
								</Link>
							</div>
						</div>
						<CurrentContent source={current} summary />
					</section>
					<div className="grid gap-7 min-[720px]:grid-cols-2">
						<Goals projectId={projectId} overview={overview} onChanged={load} summary />
						<CurrentTasks projectId={projectId} />
					</div>
					<FeatureSection source={overview.features} href={path("features")} />
					<div className="border-t border-[#E5E7EB] pt-2">
						<Disclosure label="最近完成">
							{completed ? (
								<Markdown source={[completed, progress.definitions].filter(Boolean).join("\n\n")} />
							) : (
								<LatestStage key={overview.version} projectId={projectId} />
							)}
						</Disclosure>
						<Disclosure label="关键路径">
							{overview.criticalPaths ? <Markdown source={overview.criticalPaths} /> : <p>暂无关键路径。</p>}
							<Link className={linkStyle} to={path("critical-paths")}>
								打开关键路径
							</Link>
						</Disclosure>
						<Disclosure label="项目约定">
							{overview.agreements ? <Markdown source={overview.agreements} /> : <p>暂无项目约定。</p>}
							<Link className={linkStyle} to={path("agreements")}>
								打开项目约定
							</Link>
						</Disclosure>
						<StageProgress projectId={projectId} overview={overview} onChanged={load} summary />
					</div>
				</>
			)}
		</div>
	);
}

function CurrentTasks({ projectId }: { projectId: string }) {
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const load = useCallback(async () => {
		try {
			const [meta, list] = await Promise.all([api.getProject(projectId), api.listTasks(projectId)]);
			setTasks(list.filter((task) => isP0Task(task, meta.p0) && !isDoneStatus(task.status, meta.doneStatus)));
			setError(null);
		} catch (e) {
			setError(e);
		}
	}, [projectId]);
	useEffect(() => {
		void load();
		const refresh = () => void load();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [load]);
	const path = overviewPagePath(projectId, "tasks");
	return (
		<section className="min-w-0" aria-labelledby="current-tasks">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
				<h2 id="current-tasks" className={headingStyle}>
					当前任务
				</h2>
				<Link className={linkStyle} to={path}>
					查看全部任务
				</Link>
			</div>
			<ErrorNote error={error} onRetry={() => void load()} />
			{!tasks ? (
				error ? null : (
					<LoadingNote />
				)
			) : tasks.length ? (
				<ul className="divide-y divide-[#E5E7EB]">
					{tasks.map((task) => (
						<li key={task.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2">
							<Link className={`min-w-0 break-words ${linkStyle}`} to={`${path}?task=${encodeURIComponent(task.id)}`}>
								{task.title}
							</Link>
							<span className="text-[14px] text-[#555B65]">{task.status}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-[15px] text-[#555B65]">暂无进行中的重点任务。</p>
			)}
		</section>
	);
}

function FeatureSection({ source, href }: { source: string; href: string }) {
	const preview = useMemo(() => featurePreview(source), [source]);
	const withDefinitions = (text: string) => [text, preview?.definitions].filter(Boolean).join("\n\n");
	return (
		<section className="border-t border-[#E5E7EB] pt-4" aria-labelledby="feature-overview">
			<div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
				<h2 id="feature-overview" className={headingStyle}>
					功能与用法
				</h2>
				<Link className={linkStyle} to={href}>
					完整功能与用法
				</Link>
			</div>
			{preview ? (
				<>
					<h3 className="mb-2 font-medium">{preview.title}</h3>
					{preview.purpose ? <Markdown source={withDefinitions(preview.purpose)} /> : null}
					{preview.steps ? (
						<Disclosure label="查看使用步骤">
							<Markdown source={withDefinitions(preview.steps)} />
						</Disclosure>
					) : null}
					{preview.older ? (
						<Disclosure label="较早的功能与用法">
							<Markdown source={withDefinitions(preview.older)} />
						</Disclosure>
					) : null}
				</>
			) : null}
		</section>
	);
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
	const [open, setOpen] = useState(false);
	return (
		<details onToggle={(event) => setOpen(event.currentTarget.open)}>
			<summary className="w-fit cursor-pointer py-2 text-[16px] font-medium">{label}</summary>
			{open ? <div className="space-y-3 pb-3">{children}</div> : null}
		</details>
	);
}

function LatestStage({ projectId }: { projectId: string }) {
	const [record, setRecord] = useState<Progress | null | undefined>(undefined);
	const [error, setError] = useState<unknown>(null);
	const load = useCallback(async () => {
		try {
			const page = await api.listProgress(projectId, 0, 1);
			setRecord(page.items[0] ?? null);
			setError(null);
		} catch (e) {
			setError(e);
		}
	}, [projectId]);
	useEffect(() => void load(), [load]);
	if (error) return <ErrorNote error={error} onRetry={() => void load()} />;
	if (record === undefined) return <LoadingNote />;
	if (!record) return <p>暂无完成记录。</p>;
	return (
		<div className="space-y-2">
			<p className="font-medium">{record.title}</p>
			<p className="text-[14px] text-[#555B65]">完成于 {dateLabel(record.completedAt)}</p>
			<Markdown source={record.summary} />
		</div>
	);
}
