import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, type LibraryProject, type ProjectMeta, type Task } from "../api.ts";
import { PageHeader, useProject } from "../components/AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "../components/drafts.ts";
import { EmptyNote, ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import { useImeGuard } from "../useImeGuard.ts";
import { isDoneStatus, isP0Task } from "../utils.ts";

const SEL_WHICH = "sel:task";

export default function TasksPage() {
	const project = useProject();
	const [params] = useSearchParams();
	const requestedId = params.get("task");
	return <TasksInner key={JSON.stringify([project.id, requestedId])} project={project} requestedId={requestedId} />;
}

function TasksInner({ project, requestedId }: { project: LibraryProject; requestedId: string | null }) {
	const projectId = project.id;
	const [meta, setMeta] = useState<ProjectMeta | null>(null);
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [expandedId, setExpandedId] = useState<string | null>(
		() => requestedId || getDraft(projectId, SEL_WHICH) || null,
	);
	const [rowErrors, setRowErrors] = useState<Record<string, { text: string; retryStatus: string }>>({});
	const [newTitle, setNewTitle] = useState("");
	const [adding, setAdding] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [addError, setAddError] = useState<unknown>(null);
	const ime = useImeGuard();

	const load = useCallback(async () => {
		const [m, ts] = await Promise.all([api.getProject(projectId), api.listTasks(projectId)]);
		setMeta(m);
		setTasks(ts);
		setLoadError(null);
	}, [projectId]);

	useEffect(() => {
		load().catch(setLoadError);
	}, [load]);

	const linkedId =
		meta && tasks?.some((task) => task.id === requestedId && isP0Task(task, meta.p0)) ? requestedId : null;
	useEffect(() => {
		if (!linkedId) return;
		const row = document.getElementById(`task-row-${linkedId}`);
		row?.scrollIntoView?.({ block: "nearest" });
		row?.focus({ preventScroll: true });
	}, [linkedId]);

	const toggleExpanded = (task: Task) => {
		if (!task.description?.trim()) return;
		setExpandedId((prev) => {
			const next = prev === task.id ? null : task.id;
			if (next) setDraft(projectId, SEL_WHICH, next);
			else clearDraft(projectId, SEL_WHICH);
			return next;
		});
	};

	/** 乐观更新状态；失败回滚该行并在该任务处给出重试。 */
	const setStatus = async (task: Task, status: string) => {
		const previous = task;
		setRowErrors((errs) => {
			const next = { ...errs };
			delete next[task.id];
			return next;
		});
		setTasks((list) => (list ?? []).map((t) => (t.id === task.id ? { ...t, status } : t)));
		try {
			const updated = await api.updateTask(projectId, task.id, { status }, task.version ?? "");
			setTasks((list) => (list ?? []).map((t) => (t.id === task.id ? updated : t)));
		} catch (e) {
			setTasks((list) => (list ?? []).map((t) => (t.id === task.id ? previous : t)));
			// 冲突时刷新列表，重试会带上最新版本，否则必然再次失败。
			if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
				setRowErrors((errs) => ({
					...errs,
					[task.id]: { text: "任务刚被更新，已刷新最新内容。", retryStatus: status },
				}));
				load().catch(() => {});
			} else {
				setRowErrors((errs) => ({
					...errs,
					[task.id]: { text: `保存失败，${e instanceof Error ? e.message : String(e)}`, retryStatus: status },
				}));
			}
		}
	};

	const addTask = async () => {
		const title = newTitle.trim();
		if (!title) return;
		setAdding(true);
		setAddError(null);
		try {
			await api.createTask(projectId, title);
			setNewTitle("");
			setAddOpen(false);
			await load();
		} catch (e) {
			setAddError(e);
		} finally {
			setAdding(false);
		}
	};

	const headerActions = (
		<button
			type="button"
			className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white"
			onClick={() => {
				setAddOpen(true);
				window.setTimeout(() => document.getElementById("new-task-input")?.focus(), 0);
			}}
		>
			＋ 添加任务
		</button>
	);

	if (loadError && !tasks) {
		return (
			<div>
				<PageHeader title="任务" actions={headerActions} />
				<ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} />
			</div>
		);
	}
	if (!tasks || !meta) {
		return (
			<div>
				<PageHeader title="任务" actions={headerActions} />
				<LoadingNote />
			</div>
		);
	}

	const p0Tasks = tasks.filter((t) => isP0Task(t, meta.p0));
	const open = p0Tasks.filter((t) => !isDoneStatus(t.status, meta.doneStatus));
	const done = p0Tasks.filter((t) => isDoneStatus(t.status, meta.doneStatus));

	const row = (t: Task) => {
		const done_ = isDoneStatus(t.status, meta.doneStatus);
		const hasDesc = Boolean(t.description?.trim());
		const expanded = expandedId === t.id && hasDesc;
		return (
			<li
				key={t.id}
				id={`task-row-${t.id}`}
				tabIndex={linkedId === t.id ? -1 : undefined}
				className={`min-h-14 border-b border-[#E5E7EB] py-2 last:border-b-0 ${linkedId === t.id ? "rounded-lg bg-[#EEF2FF] px-3" : ""}`}
			>
				<div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1">
					<input
						type="checkbox"
						className="h-5 w-5 accent-[#3B57D0]"
						checked={done_}
						disabled={meta.doneStatus === null}
						aria-label={`完成「${t.title}」`}
						onChange={(e) => {
							if (e.target.checked && meta.doneStatus !== null) void setStatus(t, meta.doneStatus);
						}}
					/>
					{hasDesc ? (
						<button
							type="button"
							className="min-w-0 flex-1 text-left text-[16px] font-medium leading-6 text-[#202124]"
							aria-expanded={expanded}
							onClick={() => toggleExpanded(t)}
						>
							{t.title}
						</button>
					) : (
						<span className="min-w-0 flex-1 text-[16px] font-medium leading-6">{t.title}</span>
					)}
					<select
						className="h-10 rounded-lg border border-[#8A9099]/40 bg-white px-2 text-[15px] leading-6 text-[#202124]"
						value={t.status}
						aria-label={`「${t.title}」状态`}
						onChange={(e) => void setStatus(t, e.target.value)}
					>
						{meta.statuses.map((s) => (
							<option key={s} value={s}>
								{s}
							</option>
						))}
						{meta.statuses.includes(t.status) ? null : <option value={t.status}>{t.status}</option>}
					</select>
				</div>
				{expanded ? (
					<p className="whitespace-pre-wrap py-2 pl-8 text-[15px] leading-6 text-[#555B65]">{t.description}</p>
				) : null}
				{rowErrors[t.id] ? (
					<p className="pl-8 text-[14px] leading-[22px] text-[#B42318]" role="alert">
						{rowErrors[t.id]?.text}
						<button
							type="button"
							className="ml-2 font-medium underline"
							onClick={() => {
								const err = rowErrors[t.id];
								if (err) void setStatus(t, err.retryStatus);
							}}
						>
							重试
						</button>
					</p>
				) : null}
			</li>
		);
	};

	return (
		<div>
			<Link to={`/projects/${projectId}`} className="text-[15px] font-medium text-[#3B57D0] hover:underline">
				← 返回概览
			</Link>
			<PageHeader title="任务" actions={headerActions} />
			<p className="mb-4 text-[15px] font-medium leading-6 text-[#555B65]">P0 · 当前重点</p>

			{p0Tasks.length === 0 ? (
				<div className="mb-6">
					<EmptyNote>暂无 P0 任务</EmptyNote>
				</div>
			) : (
				<ul className="mb-6">{open.map(row)}</ul>
			)}

			{done.length > 0 ? (
				<DoneGroup done={done} renderRow={row} initiallyOpen={done.some((task) => task.id === linkedId)} />
			) : null}

			{addOpen || p0Tasks.length === 0 ? (
				<div className="mt-6 max-w-[560px]">
					<div className="flex gap-2">
						<input
							id="new-task-input"
							className="h-10 min-w-0 flex-1 rounded-lg border border-[#8A9099]/50 bg-white px-3 text-[15px] leading-6 text-[#202124] focus:border-[#3B57D0] focus:outline-none"
							placeholder="新任务名称"
							value={newTitle}
							{...ime.compositionProps}
							onChange={(e) => setNewTitle(e.target.value)}
							onKeyDown={(e) => {
								if (ime.inComposition(e)) return;
								if (e.key === "Enter") void addTask();
								if (e.key === "Escape") setAddOpen(false);
							}}
						/>
						<button
							type="button"
							className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
							disabled={!newTitle.trim() || adding}
							onClick={() => void addTask()}
						>
							{adding ? "添加中…" : "添加"}
						</button>
					</div>
					<ErrorNote error={addError} className="mt-2" />
				</div>
			) : null}
		</div>
	);
}

function DoneGroup({
	done,
	renderRow,
	initiallyOpen,
}: {
	done: Task[];
	renderRow: (t: Task) => ReactNode;
	initiallyOpen: boolean;
}) {
	const [open, setOpen] = useState(initiallyOpen);
	return (
		<section className="mt-2">
			<button
				type="button"
				className="flex items-center gap-2 text-[15px] font-medium leading-6 text-[#555B65]"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				已完成（{done.length}）<span aria-hidden="true">{open ? "收起" : "展开"}</span>
			</button>
			{open ? <ul className="mt-2">{done.map(renderRow)}</ul> : null}
		</section>
	);
}
