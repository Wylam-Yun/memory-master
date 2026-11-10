import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { Progress } from "../../library/tracking.ts";
import { api, type ProjectOverview, type Task } from "../api.ts";
import { useProject } from "../components/AppShell.tsx";
import { dateLabel, Goals, StageProgress } from "../components/GoalProgress.tsx";
import Markdown from "../components/Markdown.tsx";
import OverviewContent, { CurrentContent } from "../components/OverviewContent.tsx";
import OverviewFieldEditor from "../components/OverviewFieldEditor.tsx";
import { ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import { featurePreview, introductionSubtitle, progressSections } from "../overview-content.ts";
import { type OverviewField, overviewPagePath } from "../overview-pages.ts";
import { isDoneStatus, isP0Task } from "../utils.ts";

const linkStyle = "text-[15px] font-medium text-[#3B57D0] hover:underline";
const headingStyle = "text-[20px] font-semibold leading-7";

export default function ProjectHomePage({ section }: { section?: OverviewField }) {
	const project = useProject();
	const { hash } = useLocation();
	const active = section ?? (hash.startsWith("#mm-feature-") ? "features" : undefined);
	return (
		<ProjectHome key={`${project.id}:${section ?? ""}`} projectId={project.id} name={project.name} section={active} />
	);
}

function ProjectHome({ projectId, name, section }: { projectId: string; name: string; section?: OverviewField }) {
	const [overview, setOverview] = useState<ProjectOverview | null>(null);
	const [error, setError] = useState<unknown>(null);
	const latestRead = useRef(0);
	const applyOverview = useCallback((fresh: ProjectOverview) => {
		latestRead.current++;
		setOverview(fresh);
		setError(null);
	}, []);
	const load = useCallback(async () => {
		const read = ++latestRead.current;
		try {
			const fresh = await api.getOverview(projectId);
			if (read === latestRead.current) applyOverview(fresh);
		} catch (e) {
			if (read === latestRead.current) setError(e);
		}
	}, [projectId, applyOverview]);
	useEffect(() => {
		void load();
		const refresh = () => void load();
		window.addEventListener("focus", refresh);
		return () => {
			latestRead.current++;
			window.removeEventListener("focus", refresh);
		};
	}, [load]);
	const loaded = overview !== null;
	useEffect(() => {
		if (!loaded || !section || (section === "features" && window.location.hash.startsWith("#mm-feature-"))) return;
		const target = document.getElementById(`overview-${section}`);
		target?.scrollIntoView?.({ block: "start" });
	}, [loaded, section]);

	const description = overview?.description ?? "";
	const subtitle = useMemo(() => introductionSubtitle(description), [description]);
	const current = overview?.current ?? "";
	const progress = useMemo(() => progressSections(current), [current]);
	const completed = progress.sections
		.filter(({ title }) => title === "已完成")
		.map(({ body }) => body)
		.join("\n\n");
	const path = (location: string) => overviewPagePath(projectId, location);

	return (
		<div className="max-w-[1000px] space-y-6 min-[720px]:space-y-8">
			<header id="overview-description" className="scroll-mt-4">
				<h1 className="break-words text-[28px] font-semibold leading-9">{name}</h1>
				{subtitle ? (
					<p className="mt-1 line-clamp-3 break-words text-[14px] leading-6 text-[#555B65]">{subtitle}</p>
				) : null}
				{overview ? (
					<Disclosure label="完整简介" initiallyOpen={section === "description"} quiet>
						<OverviewFieldEditor
							projectId={projectId}
							field="description"
							overview={overview}
							onSaved={applyOverview}
							editLabel="编辑简介"
							source={<OverviewContent field="description" source={description} />}
						>
							{(actions, content) => (
								<>
									<div className="mb-3">{actions}</div>
									{content}
								</>
							)}
						</OverviewFieldEditor>
					</Disclosure>
				) : null}
			</header>
			<ErrorNote error={error} onRetry={() => void load()} />
			{!overview ? (
				error ? null : (
					<LoadingNote />
				)
			) : (
				<>
					<section
						id="overview-current"
						className="min-w-0 scroll-mt-4 rounded-xl border border-[#DDE3EF] bg-white p-4 min-[720px]:px-6 min-[720px]:py-5"
						aria-labelledby="latest-progress"
					>
						<OverviewFieldEditor
							projectId={projectId}
							field="current"
							overview={overview}
							onSaved={applyOverview}
							editLabel="编辑进展"
							source={<CurrentContent source={current} />}
						>
							{(actions, content) => (
								<>
									<div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
										<h2 id="latest-progress" className="text-[22px] font-semibold leading-8">
											最新进展
										</h2>
										{actions}
									</div>
									{content}
								</>
							)}
						</OverviewFieldEditor>
						<div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#555B65]">
							{overview.currentUpdatedAt ? <span>更新于 {dateLabel(overview.currentUpdatedAt)}</span> : null}
							<Link className="hover:text-[#3B57D0] hover:underline" to={path("history?field=current")}>
								历次进展
							</Link>
						</div>
					</section>
					<div className="grid gap-6 min-[720px]:grid-cols-2 min-[720px]:gap-8">
						<Goals projectId={projectId} overview={overview} onChanged={load} />
						<CurrentTasks projectId={projectId} />
					</div>
					<FeatureSection
						projectId={projectId}
						overview={overview}
						onSaved={applyOverview}
						initiallyOpen={section === "features"}
					/>
					<div className="divide-y divide-[#E5E7EB] border-y border-[#E5E7EB]">
						<Disclosure label="最近完成">
							{completed ? (
								<Markdown source={[completed, progress.definitions].filter(Boolean).join("\n\n")} />
							) : (
								<LatestStage key={overview.version} projectId={projectId} />
							)}
						</Disclosure>
						{(["criticalPaths", "agreements"] as const).map((field) => {
							const label = field === "criticalPaths" ? "关键路径" : "项目约定";
							return (
								<div id={`overview-${field}`} className="scroll-mt-4" key={field}>
									<Disclosure label={label} initiallyOpen={section === field}>
										<OverviewFieldEditor
											projectId={projectId}
											field={field}
											overview={overview}
											onSaved={applyOverview}
											editLabel={`编辑${label}`}
											source={<OverviewContent field={field} source={overview[field] ?? ""} />}
										>
											{(actions, content) => (
												<>
													<div className="mb-3">{actions}</div>
													{content}
												</>
											)}
										</OverviewFieldEditor>
									</Disclosure>
								</div>
							);
						})}
						<StageProgress projectId={projectId} overview={overview} onChanged={load} />
					</div>
				</>
			)}
		</div>
	);
}

function CurrentTasks({ projectId }: { projectId: string }) {
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const active = useRef(false);
	const load = useCallback(async () => {
		try {
			const [meta, list] = await Promise.all([api.getProject(projectId), api.listTasks(projectId)]);
			if (!active.current) return;
			setTasks(list.filter((task) => isP0Task(task, meta.p0) && !isDoneStatus(task.status, meta.doneStatus)));
			setError(null);
		} catch (e) {
			if (active.current) setError(e);
		}
	}, [projectId]);
	useEffect(() => {
		active.current = true;
		void load();
		const refresh = () => void load();
		window.addEventListener("focus", refresh);
		return () => {
			active.current = false;
			window.removeEventListener("focus", refresh);
		};
	}, [load]);
	const path = overviewPagePath(projectId, "tasks");
	return (
		<section className="min-w-0" aria-labelledby="current-tasks">
			<div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-x-4 gap-y-2">
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

function FeatureSection({
	projectId,
	overview,
	onSaved,
	initiallyOpen,
}: {
	projectId: string;
	overview: ProjectOverview;
	onSaved: (overview: ProjectOverview) => void;
	initiallyOpen: boolean;
}) {
	const source = overview.features;
	const preview = useMemo(() => featurePreview(source), [source]);
	const withDefinitions = (text: string) => [text, preview?.definitions].filter(Boolean).join("\n\n");
	const [full, setFull] = useState(initiallyOpen);
	const reading = (
		<>
			{!full && preview ? (
				<>
					<h3 className="mb-1 font-medium">{preview.title}</h3>
					{preview.purpose ? <Markdown source={withDefinitions(preview.purpose)} /> : null}
					{preview.steps ? (
						<Disclosure label="查看使用步骤" quiet>
							<Markdown source={withDefinitions(preview.steps)} />
						</Disclosure>
					) : null}
					{preview.older ? (
						<Disclosure label="较早的功能与用法" quiet>
							<Markdown source={withDefinitions(preview.older)} />
						</Disclosure>
					) : null}
				</>
			) : null}
			<Disclosure label="完整功能与用法" initiallyOpen={full} onOpenChange={setFull} quiet>
				<OverviewContent field="features" source={source} />
			</Disclosure>
		</>
	);
	return (
		<section
			id="overview-features"
			className="scroll-mt-4 border-t border-[#E5E7EB] pt-4"
			aria-labelledby="feature-overview"
		>
			<OverviewFieldEditor
				projectId={projectId}
				field="features"
				overview={overview}
				onSaved={onSaved}
				editLabel="编辑用法"
				source={reading}
			>
				{(actions, content) => (
					<>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
							<h2 id="feature-overview" className={headingStyle}>
								功能与用法
							</h2>
							{actions}
						</div>
						{content}
					</>
				)}
			</OverviewFieldEditor>
		</section>
	);
}

function Disclosure({
	label,
	children,
	initiallyOpen = false,
	quiet = false,
	onOpenChange,
}: {
	label: string;
	children: ReactNode;
	initiallyOpen?: boolean;
	quiet?: boolean;
	onOpenChange?: (open: boolean) => void;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<details
			open={open}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				setOpen(next);
				onOpenChange?.(next);
			}}
		>
			<summary
				className={
					quiet
						? "w-fit cursor-pointer py-1 text-[14px] text-[#555B65] hover:text-[#3B57D0]"
						: "w-fit cursor-pointer py-2.5 text-[15px] font-medium"
				}
			>
				{label}
			</summary>
			{open ? <div className="space-y-2 pb-3">{children}</div> : null}
		</details>
	);
}

function LatestStage({ projectId }: { projectId: string }) {
	const [record, setRecord] = useState<Progress | null | undefined>(undefined);
	const [error, setError] = useState<unknown>(null);
	const active = useRef(false);
	const load = useCallback(async () => {
		try {
			const page = await api.listProgress(projectId, 0, 1);
			if (!active.current) return;
			setRecord(page.items[0] ?? null);
			setError(null);
		} catch (e) {
			if (active.current) setError(e);
		}
	}, [projectId]);
	useEffect(() => {
		active.current = true;
		void load();
		return () => {
			active.current = false;
		};
	}, [load]);
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
