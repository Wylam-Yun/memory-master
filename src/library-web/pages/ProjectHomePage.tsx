import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { Progress } from "../../library/tracking.ts";
import { api, type ProjectOverview, type Task } from "../api.ts";
import { useProject } from "../components/AppShell.tsx";
import DeleteProject from "../components/DeleteProject.tsx";
import { dateLabel, Goals, StageProgress } from "../components/GoalProgress.tsx";
import Markdown from "../components/Markdown.tsx";
import OverviewContent, { CurrentContent } from "../components/OverviewContent.tsx";
import OverviewFieldEditor from "../components/OverviewFieldEditor.tsx";
import { ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import WorkingDirectory from "../components/WorkingDirectory.tsx";
import { featurePreview, introductionSubtitle, progressSections } from "../overview-content.ts";
import { type OverviewField, overviewPagePath } from "../overview-pages.ts";
import { isDoneStatus, isP0Task } from "../utils.ts";

const linkStyle = "text-[14px] font-medium text-[#315DAD] underline-offset-4 hover:underline";
const headingStyle = "text-[18px] font-semibold leading-7 text-[#242724]";

export default function ProjectHomePage({ section, reload }: { section?: OverviewField; reload: () => Promise<void> }) {
	const project = useProject();
	const navigate = useNavigate();
	const { hash } = useLocation();
	const active = section ?? (hash.startsWith("#mm-feature-") ? "features" : undefined);
	return (
		<ProjectHome key={`${project.id}:${section ?? ""}`} projectId={project.id} name={project.name} section={active}
			deleteAction={<DeleteProject project={project} onDeleted={async () => { navigate("/", { replace: true }); await reload(); }} />}
		/>
	);
}

function ProjectHome({ projectId, name, section, deleteAction }: { projectId: string; name: string; section?: OverviewField; deleteAction: ReactNode }) {
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
		<div className="@container max-w-[1000px] space-y-8 min-[720px]:space-y-10">
			<header id="overview-description" className="scroll-mt-4 border-b border-[#DDDFD9] pb-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="min-w-0 break-words text-[28px] font-semibold leading-9 text-[#242724]">{name}</h1>
					{deleteAction}
				</div>
				{subtitle ? (
					<p className="mt-2 max-w-[760px] break-words text-[15px] leading-6 text-[#595F59]">{subtitle}</p>
				) : null}
				<WorkingDirectory projectId={projectId} />
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
					<div className="grid items-start gap-8 @min-[960px]:grid-cols-[minmax(0,1fr)_288px] @min-[960px]:gap-10">
						<section id="overview-current" className="min-w-0 scroll-mt-4" aria-labelledby="latest-progress">
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
										<div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
											<h2 id="latest-progress" className={headingStyle}>
												最新进展
											</h2>
											{actions}
										</div>
										{content}
										<div className="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[#DDDFD9] pt-3">
											<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-5 text-[#595F59]">
												{overview.currentUpdatedAt ? <span>更新于 {dateLabel(overview.currentUpdatedAt)}</span> : null}
												<Link
													className="underline-offset-4 hover:text-[#315DAD] hover:underline"
													to={path("history?field=current")}
												>
													历次进展
												</Link>
											</div>
										</div>
									</>
								)}
							</OverviewFieldEditor>
						</section>
						<CurrentTasks projectId={projectId} />
					</div>
					<div className="border-t border-[#DDDFD9] pt-6">
						<Goals projectId={projectId} overview={overview} onChanged={load} />
					</div>
					<FeatureSection
						projectId={projectId}
						overview={overview}
						onSaved={applyOverview}
						initiallyOpen={section === "features"}
					/>
					<div className="divide-y divide-[#DDDFD9] border-y border-[#DDDFD9]">
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
		<section
			className="min-w-0 border-t border-[#DDDFD9] pt-6 @min-[960px]:border-l @min-[960px]:border-t-0 @min-[960px]:pl-6 @min-[960px]:pt-0"
			aria-labelledby="current-tasks"
		>
			<div className="mb-4">
				<h2 id="current-tasks" className={headingStyle}>
					当前任务
				</h2>
			</div>
			<ErrorNote error={error} onRetry={() => void load()} />
			{!tasks ? (
				error ? null : (
					<LoadingNote />
				)
			) : tasks.length ? (
				<ul className="divide-y divide-[#DDDFD9]">
					{tasks.map((task) => (
						<li key={task.id} className="py-3 first:pt-0">
							<Link
								className="block break-words text-[15px] font-medium leading-6 text-[#242724] underline-offset-4 hover:text-[#315DAD] hover:underline"
								to={`${path}?task=${encodeURIComponent(task.id)}`}
							>
								{task.title}
							</Link>
							<span className="mt-1 block text-[13px] leading-5 text-[#595F59]">{task.status}</span>
						</li>
					))}
				</ul>
			) : (
				<p className="text-[15px] text-[#595F59]">暂无进行中的重点任务。</p>
			)}
			<Link className={`mt-4 inline-flex min-h-9 items-center ${linkStyle}`} to={path}>
				查看全部任务
			</Link>
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
			className="scroll-mt-4 border-t border-[#DDDFD9] pt-6 [&_.wmde-markdown]:max-w-[760px]"
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
						? "w-fit cursor-pointer py-1 text-[14px] text-[#595F59] hover:text-[#315DAD]"
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
			<p className="text-[14px] text-[#595F59]">完成于 {dateLabel(record.completedAt)}</p>
			<Markdown source={record.summary} />
		</div>
	);
}
