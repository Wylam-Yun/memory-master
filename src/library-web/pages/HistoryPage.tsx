import { PROJECT_CONTENT_NAMES } from "../../library/project-content.ts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type HistoryEntry, type LibraryProject, type ProjectMeta } from "../api.ts";
import { PageHeader, useProject } from "../components/AppShell.tsx";
import { EmptyNote, ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import { groupHistoryByDay, isDoneStatus } from "../utils.ts";

const FIELD_LABELS: Record<string, string> = {
	title: "标题",
	status: "状态",
	description: PROJECT_CONTENT_NAMES.description,
	goal: PROJECT_CONTENT_NAMES.goal,
	agreements: PROJECT_CONTENT_NAMES.agreements,
	criticalPaths: PROJECT_CONTENT_NAMES.criticalPaths,
	current: PROJECT_CONTENT_NAMES.current,
	features: PROJECT_CONTENT_NAMES.features,
	name: "名称",
	task: "关联任务",
	answer: "回答",
	answered_by: "回答人",
	size: "大小",
	priority: "优先级",
	content: "内容",
	completedAt: "完成日期",
	adjustedAt: "调整日期",
	summary: "成果说明",
	progress: "阶段成果",
	replacement: "替代目标",
	requiresConfirmation: "完成需确认",
	updatedAt: "更新时间",
	createdAt: "记录时间",
	id: "记录ID",
	key: "记录标识",
	goalId: "关联目标",
	replacementId: "替代目标",
};

function actorLabel(actor: HistoryEntry["actor"]): string {
	if (actor.type === "user") return "用户";
	return actor.client === "claude-code" ? "Claude Code" : actor.client === "codex" ? "Codex" : actor.client;
}

function targetLabel(entry: HistoryEntry): string {
	if (entry.target.type === "project") return "项目";
	if (entry.target.type === "goal") return "目标";
	if (entry.target.type === "progress") return "阶段进展";
	if (entry.target.type === "overview") return "概览";
	if (entry.target.type === "architecture") return "项目架构";
	if (entry.target.type === "question") return `事项 ${entry.target.id ?? ""}`.trimEnd();
	if (entry.target.type === "resource") return `资料 ${entry.target.id ?? ""}`.trimEnd();
	return "任务";
}

const RANGES = [
	{ key: "all", label: "全部" },
	{ key: "today", label: "今天" },
	{ key: "7d", label: "近7天" },
	{ key: "30d", label: "近30天" },
] as const;

function sinceFor(range: (typeof RANGES)[number]["key"]): string | undefined {
	const now = new Date();
	if (range === "today") {
		return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
	}
	if (range === "7d") return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
	if (range === "30d") return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
	return undefined;
}

function hhmm(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PAGE = 30;

export default function HistoryPage() {
	const project = useProject();
	return <HistoryInner key={project.id} project={project} />;
}

function HistoryInner({ project }: { project: LibraryProject }) {
	const projectId = project.id;
	const [history, setEntries] = useState<HistoryEntry[] | null>(null);
	const [params, setParams] = useSearchParams();
	const progressOnly = params.get("field") === "current";
	const entries = useMemo(
		() =>
			progressOnly
				? (history?.flatMap((entry) =>
						entry.changes.current ? [{ ...entry, changes: { current: entry.changes.current } }] : [],
					) ?? null)
				: history,
		[history, progressOnly],
	);
	const [meta, setMeta] = useState<ProjectMeta | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [range, setRange] = useState<(typeof RANGES)[number]["key"]>("all");
	const [shown, setShown] = useState(PAGE);
	const [openIds, setOpenIds] = useState<Set<HistoryEntry>>(new Set());

	const load = useCallback(async () => {
		setEntries(await api.history(projectId, { since: sinceFor(range) }));
		setError(null);
	}, [projectId, range]);

	useEffect(() => {
		setShown(PAGE);
		setOpenIds(new Set());
	}, [progressOnly, range]);
	useEffect(() => {
		load().catch(setError);
	}, [load]);

	// doneStatus 仅用于把「状态→完成」的更新读作「完成」；meta 取不到时退回通用「更新」。
	useEffect(() => {
		api
			.getProject(projectId)
			.then(setMeta)
			.catch(() => {});
	}, [projectId]);

	const summary = (e: HistoryEntry): string => {
		const fields = Object.keys(e.changes).map((f) => FIELD_LABELS[f] ?? f);
		let verb = e.action === "delete" ? "删除" : e.action === "create" ? "创建" : "更新";
		// 唯一变化是状态→完成状态时，读作「完成」（蓝图摘要语义）。
		if (
			e.action === "update" &&
			e.target.type === "task" &&
			Object.keys(e.changes).length === 1 &&
			e.changes.status &&
			isDoneStatus(e.changes.status.to ?? "", meta?.doneStatus ?? null)
		) {
			verb = "完成";
		}
		const title = e.target.title ? `「${e.target.title}」` : "";
		const fieldList = fields.length > 0 ? ` · ${fields.join("、")}` : "";
		return `${verb}${targetLabel(e)}${title}${fieldList}`;
	};

	const headerActions = (
		<label className="flex items-center gap-2 text-[15px] leading-6 text-[#595F59]">
			时间范围
			<select
				className="h-10 rounded-lg border border-[#A8AEA4]/40 bg-white px-2 text-[15px] text-[#242724]"
				value={range}
				onChange={(e) => setRange(e.target.value as (typeof RANGES)[number]["key"])}
			>
				{RANGES.map((r) => (
					<option key={r.key} value={r.key}>
						{r.label}
					</option>
				))}
			</select>
		</label>
	);

	return (
		<div className="@container max-w-[1040px]">
			<PageHeader title="变更记录" />
			<div className="mb-6 flex flex-wrap items-center gap-x-6 gap-y-3">
				{headerActions}
				<label className="flex items-center gap-2 text-[15px] text-[#595F59]">
					记录范围
					<select
						className="h-10 rounded-lg border border-[#A8AEA4]/40 bg-white px-2"
						value={progressOnly ? "current" : "all"}
						onChange={(event) => setParams(event.target.value === "current" ? { field: "current" } : {})}
					>
						<option value="all">全部记录</option>
						<option value="current">历次进展</option>
					</select>
				</label>
			</div>
			{error && !entries ? (
				<ErrorNote error={error} onRetry={() => load().catch(setError)} />
			) : !entries ? (
				<LoadingNote />
			) : entries.length === 0 ? (
				<EmptyNote>暂无变更</EmptyNote>
			) : (
				<>
					{/* entries arrive oldest→newest; the newest `shown` are what the page shows first. */}
					{groupHistoryByDay(entries.slice(Math.max(0, entries.length - shown))).map((group) => (
						<section key={group.key} className="mb-8">
							<h2 className="mb-2 text-[15px] font-medium leading-6 text-[#595F59]">{group.label}</h2>
							<ul>
								{group.entries.map((e, i) => {
									const open = openIds.has(e);
									return (
										<li key={`${group.key}-${i}`} className="border-b border-[#DDDFD9] last:border-b-0">
											<button
												type="button"
												className="grid min-h-14 w-full grid-cols-[48px_minmax(0,1fr)_16px] items-baseline gap-x-3 gap-y-1 py-3 text-left @min-[680px]:grid-cols-[56px_112px_minmax(0,1fr)_16px]"
												aria-expanded={open}
												onClick={() =>
													setOpenIds((prev) => {
														const next = new Set(prev);
														if (next.has(e)) next.delete(e);
														else next.add(e);
														return next;
													})
												}
											>
												<span className="w-12 shrink-0 font-mono text-[14px] leading-[22px] text-[#595F59]">
													{hhmm(e.ts)}
												</span>
												<span className="shrink-0 text-[15px] font-medium leading-6 text-[#242724]">
													{actorLabel(e.actor)}
												</span>
												<span className="col-span-2 min-w-0 break-words text-[15px] leading-6 text-[#242724] @min-[680px]:col-span-1">
													{summary(e)}
												</span>
												<span
													className="col-start-3 row-start-1 text-[#595F59] @min-[680px]:col-start-4"
													aria-hidden="true"
												>
													{open ? "▾" : "▸"}
												</span>
											</button>
											{open ? (
												<div className="pb-5 @min-[680px]:pl-[68px]">
													{Object.entries(e.changes).map(([field, c]) => (
														<div key={field} className="mb-4">
															<p className="mb-1 text-[14px] font-medium leading-[22px] text-[#595F59]">
																字段：{FIELD_LABELS[field] ?? field}
															</p>
															<div className="grid gap-3 @min-[760px]:grid-cols-2">
																<div>
																	<p className="mb-1 text-[13px] leading-5 text-[#595F59]">修改前</p>
																	<pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-white px-3 py-2 text-[14px] leading-[22px] text-[#242724]">
																		{c.from ?? "—"}
																	</pre>
																</div>
																<div>
																	<p className="mb-1 text-[13px] leading-5 text-[#595F59]">修改后</p>
																	<pre className="whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-white px-3 py-2 text-[14px] leading-[22px] text-[#242724]">
																		{c.to ?? "—"}
																	</pre>
																</div>
															</div>
														</div>
													))}
													{Object.keys(e.changes).length === 0 ? (
														<p className="text-[14px] leading-[22px] text-[#595F59]">无字段级变化</p>
													) : null}
												</div>
											) : null}
										</li>
									);
								})}
							</ul>
						</section>
					))}
					{entries.length > shown ? (
						<button
							type="button"
							className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724]"
							onClick={() => setShown((s) => s + PAGE)}
						>
							显示更多
						</button>
					) : null}
				</>
			)}
		</div>
	);
}
