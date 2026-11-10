import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type Goal, type Progress, type ProjectOverview } from "../api.ts";
import { useImeGuard } from "../useImeGuard.ts";
import { GrowingTextarea } from "./AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "./drafts.ts";
import Markdown from "./Markdown.tsx";
import { ErrorNote, LoadingNote } from "./StatusMessage.tsx";

const button = "min-h-10 rounded-lg border border-[#8A9099]/40 px-3 py-2 text-[15px] font-medium disabled:opacity-50";
const primary = "min-h-10 rounded-lg bg-[#3B57D0] px-4 py-2 text-[15px] font-medium text-white disabled:opacity-50";
const inputClass = "min-h-10 w-full rounded-lg border border-[#8A9099]/50 bg-white px-3 py-2 text-[16px] leading-6";
type Mode = "create-goal" | "complete" | "adjust" | "record" | "edit-progress";
interface Editor {
	mode: Mode;
	recordId?: string;
	key: string;
	baseVersion: string;
	title: string;
	summary: string;
	date: string;
	originalDate?: string | null;
	unknown: boolean;
	archived: boolean;
	requiresConfirmation: boolean;
	withProgress: boolean;
}
function today() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function dateLabel(value: string | null) {
	if (!value) return "日期未记录";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "日期未记录" : date.toLocaleDateString("zh-CN");
}
function useEditor(projectId: string, which: string) {
	const [editor, setEditor] = useState<Editor | null>(() => {
		try {
			return JSON.parse(getDraft(projectId, which) ?? "null");
		} catch {
			return null;
		}
	});
	const change = (next: Editor | null) => {
		setEditor(next);
		if (next) setDraft(projectId, which, JSON.stringify(next));
		else clearDraft(projectId, which);
	};
	return [editor, change] as const;
}
function freshEditor(mode: Mode, version: string, record?: Goal | Progress): Editor {
	const archived = record && "status" in record ? record.status !== "active" : false;
	const recordedDate =
		record && "status" in record && record.status === "adjusted" ? record.adjustedAt : record?.completedAt;
	const originalDate = record && ("summary" in record || archived) ? recordedDate : undefined;
	const asInput =
		originalDate && /^\d{4}-\d{2}-\d{2}$/.test(originalDate)
			? originalDate
			: originalDate
				? new Date(originalDate).toLocaleDateString("sv-SE")
				: today();
	return {
		mode,
		baseVersion: version,
		recordId: record?.id,
		key: crypto.randomUUID(),
		title: record?.title ?? "",
		summary: record && "summary" in record ? record.summary : "",
		date: asInput,
		originalDate,
		unknown: originalDate === null,
		requiresConfirmation: record && "requiresConfirmation" in record ? record.requiresConfirmation : false,
		withProgress: false,
		archived,
	};
}
function RecordEditor({
	projectId,
	editor,
	onChange,
	onSaved,
}: {
	projectId: string;
	editor: Editor;
	onChange: (e: Editor | null) => void;
	onSaved: () => Promise<void>;
}) {
	const [saving, setSaving] = useState(false),
		[error, setError] = useState<unknown>(null),
		[latest, setLatest] = useState<{
			version: string;
			title?: string;
			summary?: string;
			status?: string;
			current?: string;
		} | null>(null);
	const guard = useImeGuard();
	const change = (update: Partial<Editor>) => onChange({ ...editor, ...update });
	const save = async (baseVersion = editor.baseVersion) => {
		setSaving(true);
		setError(null);
		try {
			const originalDay =
				editor.originalDate && /^\d{4}-\d{2}-\d{2}$/.test(editor.originalDate)
					? editor.originalDate
					: editor.originalDate
						? new Date(editor.originalDate).toLocaleDateString("sv-SE")
						: null;
			const date = editor.unknown
				? null
				: editor.originalDate && editor.date === originalDay
					? editor.originalDate
					: editor.date;
			if (editor.mode === "create-goal")
				await api.createGoal(projectId, {
					baseVersion,
					key: editor.key,
					title: editor.title,
					requiresConfirmation: editor.requiresConfirmation,
				});
			else if (editor.mode === "record")
				await api.recordProgress(projectId, {
					baseVersion,
					key: editor.key,
					title: editor.title,
					summary: editor.summary,
					completedAt: date,
				});
			else if (editor.mode === "edit-progress")
				await api.updateProgress(projectId, editor.recordId!, {
					baseVersion,
					title: editor.title,
					summary: editor.summary,
					completedAt: date,
				});
			else
				await api.updateGoal(projectId, editor.recordId!, {
					baseVersion,
					status: editor.mode === "complete" ? "completed" : "adjusted",
					confirmed: true,
					occurredAt: date,
					...(editor.mode === "adjust" && !editor.archived && editor.title.trim()
						? { replacementTitle: editor.title }
						: {}),
					...(editor.mode === "complete" && editor.withProgress
						? { progress: { key: editor.key, title: editor.title, summary: editor.summary, completedAt: date } }
						: {}),
				});
			// The mutation is committed even if the following refresh fails. Clear its draft first.
			onChange(null);
			await onSaved();
		} catch (e) {
			setError(e);
			if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
				try {
					const data = editor.recordId
						? editor.mode === "edit-progress"
							? await api.getProgress(projectId, editor.recordId)
							: await api.getGoal(projectId, editor.recordId)
						: await api.getOverview(projectId);
					setLatest(data);
				} catch (readError) {
					setError(readError);
				}
			}
		} finally {
			setSaving(false);
		}
	};
	const label = editor.archived
		? "修正目标日期"
		: {
				"create-goal": "添加目标",
				complete: "完成目标",
				adjust: "调整目标",
				record: "记录阶段成果",
				"edit-progress": "修正阶段成果",
			}[editor.mode];
	const isProgress = editor.mode === "record" || editor.mode === "edit-progress";
	return (
		<form
			className="my-5 space-y-4 border-l-2 border-[#3B57D0] pl-4"
			{...guard.compositionProps}
			onKeyDown={(e) => {
				if (e.key === "Enter" && guard.inComposition(e)) e.preventDefault();
			}}
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<h3 className="text-[17px] font-semibold">{label}</h3>
			{!editor.archived && (editor.mode !== "complete" || editor.withProgress) ? (
				<label className="block text-[15px]">
					{isProgress || editor.withProgress
						? "成果标题"
						: editor.mode === "adjust"
							? "新的目标（留空表示不再推进）"
							: "希望达成什么"}
					<input
						className={`${inputClass} mt-2`}
						aria-label={
							isProgress || editor.withProgress ? "成果标题" : editor.mode === "adjust" ? "新的目标" : "目标内容"
						}
						value={editor.title}
						required={editor.mode !== "adjust"}
						onChange={(e) => change({ title: e.target.value })}
					/>
				</label>
			) : (
				<p className="text-[16px] leading-7">{editor.title}</p>
			)}
			{editor.mode === "create-goal" ? (
				<label className="flex items-center gap-2 text-[15px]">
					<input
						type="checkbox"
						checked={editor.requiresConfirmation}
						onChange={(e) => change({ requiresConfirmation: e.target.checked })}
					/>
					完成前需要我确认
				</label>
			) : null}
			{editor.mode === "complete" && !editor.archived ? (
				<label className="flex items-center gap-2 text-[15px]">
					<input
						type="checkbox"
						checked={editor.withProgress}
						onChange={(e) => change({ withProgress: e.target.checked })}
					/>
					同时记录一项关键阶段成果
				</label>
			) : null}
			{isProgress || editor.withProgress ? (
				<label className="block text-[15px]">
					成果说明
					<div className="mt-2">
						<GrowingTextarea
							value={editor.summary}
							onChange={(summary) => change({ summary })}
							aria-label="成果说明"
							placeholder="写清已完成的结果和适用范围，比标题更详细。"
						/>
					</div>
				</label>
			) : null}
			{editor.mode !== "create-goal" ? (
				<div className="flex flex-wrap items-center gap-4 text-[15px]">
					<label>
						{editor.mode === "adjust" ? "调整日期" : "完成日期"}
						<input
							type="date"
							className="ml-2 min-h-10 rounded-lg border border-[#8A9099]/40 px-2"
							value={editor.date}
							max={today()}
							disabled={editor.unknown}
							required={!editor.unknown}
							onChange={(e) => change({ date: e.target.value })}
						/>
					</label>
					<label className="flex items-center gap-2">
						<input type="checkbox" checked={editor.unknown} onChange={(e) => change({ unknown: e.target.checked })} />
						日期不确定
					</label>
				</div>
			) : null}
			<ErrorNote error={error} />
			{latest ? (
				<div className="space-y-2 bg-[#FFF6E4] p-3 text-[15px] leading-6">
					<p>项目已有新修改，你的输入已保留。请核对最新内容后再保存。</p>
					{latest.title ? <p>{latest.title}</p> : null}
					{latest.status ? (
						<p>
							当前状态：
							{
								({ active: "正在推进", completed: "已完成", adjusted: "已调整" } as Record<string, string>)[
									latest.status
								]
							}
						</p>
					) : null}
					{latest.summary ? <p className="whitespace-pre-wrap">{latest.summary}</p> : null}
					{latest.current ? <p className="whitespace-pre-wrap">{latest.current}</p> : null}
					<button type="button" className={button} disabled={saving} onClick={() => void save(latest.version)}>
						核对后按最新版本保存
					</button>
				</div>
			) : null}
			<div className="flex gap-3">
				<button className={primary} disabled={saving || Boolean(latest)} type="submit">
					{saving ? "保存中…" : "保存"}
				</button>
				<button className={button} disabled={saving} type="button" onClick={() => onChange(null)}>
					取消
				</button>
			</div>
		</form>
	);
}
function ProgressResult({
	record,
	version,
	onEdit,
}: {
	record: Progress;
	version: string;
	onEdit?: (r: Progress, version: string) => void;
}) {
	const [open, setOpen] = useState(false);
	return (
		<article>
			<details onToggle={(e) => setOpen(e.currentTarget.open)}>
				<summary className="cursor-pointer py-2 text-[16px] leading-7">
					<span className="font-medium">{record.title}</span>
					<span className="ml-3 text-[14px] text-[#555B65]">完成于 {dateLabel(record.completedAt)}</span>
				</summary>
				{open ? (
					<div className="space-y-3 py-3 text-[16px] leading-7">
						<Markdown source={record.summary} />
						{onEdit ? (
							<button
								type="button"
								className="min-h-10 text-[15px] font-medium text-[#3B57D0]"
								onClick={() => onEdit?.(record, version)}
							>
								修正记录
							</button>
						) : null}
					</div>
				) : null}
			</details>
		</article>
	);
}

function Archive({
	projectId,
	kind,
	count,
	version,
	onEdit,
	onGoalEdit,
	onChanged,
	actions,
}: {
	projectId: string;
	kind: "completed" | "adjusted" | "progress";
	count: number;
	version: string;
	onEdit?: (r: Progress, version: string) => void;
	onGoalEdit?: (r: Goal, version: string) => void;
	onChanged: () => Promise<void>;
	actions?: ReactNode;
}) {
	const [open, setOpen] = useState(false),
		[rows, setRows] = useState<(Goal | Progress)[]>([]),
		[total, setTotal] = useState(count),
		[loading, setLoading] = useState(false),
		[error, setError] = useState<unknown>(null);
	const epoch = useRef(0),
		inFlight = useRef(false);
	const label = kind === "progress" ? "阶段成果" : kind === "completed" ? "已完成目标" : "已调整的目标";
	const load = useCallback(
		async (offset: number, generation = epoch.current) => {
			if (inFlight.current) return;
			inFlight.current = true;
			setLoading(true);
			setError(null);
			try {
				const page =
					kind === "progress"
						? await api.listProgress(projectId, offset)
						: await api.listGoals(projectId, kind, offset);
				if (generation !== epoch.current) return;
				if (page.version !== version) {
					await onChanged();
					return;
				}
				setRows((prev) => (offset === 0 ? page.items : [...prev, ...page.items]));
				setTotal(page.total);
			} catch (e) {
				if (generation === epoch.current) setError(e);
			} finally {
				if (generation === epoch.current) {
					inFlight.current = false;
					setLoading(false);
				}
			}
		},
		[projectId, kind, version, onChanged],
	);
	useEffect(() => {
		epoch.current++;
		inFlight.current = false;
		setRows([]);
		setError(null);
		setLoading(false);
		if (open && count) void load(0);
		return () => {
			epoch.current++;
		};
	}, [open, load, count]);
	if (!count && kind !== "progress") return null;
	return (
		<details className={kind === "progress" ? "" : "my-2"} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary className="w-fit cursor-pointer py-2.5 text-[15px] font-medium">
				{label}（{count}）
			</summary>
			{open ? (
				<div className="space-y-4 pb-4">
					{actions}
					{count === 0 ? <p className="text-[15px] text-[#555B65]">暂无阶段成果。</p> : null}
					{rows.map((r) =>
						"summary" in r ? (
							<ProgressResult key={r.id} record={r} version={version} onEdit={onEdit} />
						) : (
							<article key={r.id} className="space-y-2">
								<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
									<h3 className="text-[16px] font-medium">{r.title}</h3>
									<span className="text-[14px] text-[#555B65]">
										{kind === "adjusted" ? "调整于" : "完成于"}{" "}
										{dateLabel(kind === "adjusted" && "adjustedAt" in r ? r.adjustedAt : r.completedAt)}
									</span>
								</div>
								{onGoalEdit ? (
									<button
										type="button"
										className="text-[15px] font-medium text-[#3B57D0]"
										onClick={() => onGoalEdit?.(r, version)}
									>
										修正日期
									</button>
								) : null}
							</article>
						),
					)}
					{loading ? <LoadingNote /> : null}
					<ErrorNote error={error} onRetry={() => void load(rows.length)} />
					{count > 0 && !loading && !error && rows.length < total ? (
						<button type="button" className={button} onClick={() => void load(rows.length)}>
							显示更多
						</button>
					) : null}
				</div>
			) : null}
		</details>
	);
}
export function Goals({
	projectId,
	overview,
	onChanged,
}: {
	projectId: string;
	overview: ProjectOverview;
	onChanged: () => Promise<void>;
}) {
	const [editor, setEditor] = useEditor(projectId, "dynamic:goals");
	const [managing, setManaging] = useState(Boolean(editor));
	const goals = overview.goals ?? [];
	const counts = overview.archiveCounts ?? { completed: 0, adjusted: 0, progress: 0 };
	const legacy = overview.goal.trim() && !overview.goal.startsWith("待补充") ? overview.goal : "";
	return (
		<section className="min-w-0" aria-labelledby="current-goals">
			<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
				<h2 id="current-goals" className="text-[20px] font-semibold leading-7">
					当前目标
				</h2>
				<button
					type="button"
					aria-expanded={managing}
					className="min-h-9 text-[14px] text-[#555B65] hover:text-[#3B57D0]"
					onClick={() => setManaging((open) => !open)}
				>
					{managing ? "收起管理" : "管理目标"}
				</button>
			</div>
			{goals.length ? (
				<ul className="space-y-2.5">
					{goals.map((g) => (
						<li key={g.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
							<p className="min-w-0 flex-1 text-[15px] leading-6">{g.title}</p>
							{managing ? (
								<>
									<button
										type="button"
										className="text-[15px] font-medium text-[#3B57D0]"
										onClick={() => setEditor(freshEditor("complete", overview.version, g))}
									>
										完成
									</button>
									<button
										type="button"
										className="text-[15px] text-[#555B65]"
										onClick={() => setEditor({ ...freshEditor("adjust", overview.version, g), title: "" })}
									>
										调整
									</button>
								</>
							) : null}
						</li>
					))}
				</ul>
			) : (
				<p className="text-[15px] text-[#555B65]">暂无正在推进的目标</p>
			)}
			{managing ? (
				<div className="mt-3 space-y-3">
					<button
						type="button"
						className={button}
						onClick={() => setEditor(freshEditor("create-goal", overview.version))}
					>
						添加目标
					</button>
					{editor ? (
						<RecordEditor
							key={editor.key}
							projectId={projectId}
							editor={editor}
							onChange={setEditor}
							onSaved={onChanged}
						/>
					) : null}
				</div>
			) : null}
			{legacy || counts.completed + counts.adjusted > 0 ? (
				<details className="mt-2">
					<summary className="w-fit cursor-pointer py-2 text-[14px] text-[#555B65]">历史目标</summary>
					{legacy ? (
						<details className="my-2">
							<summary className="w-fit cursor-pointer py-2 text-[15px] font-medium">原有目标</summary>
							<Markdown source={legacy} />
						</details>
					) : null}
					<Archive
						projectId={projectId}
						kind="completed"
						count={counts.completed}
						version={overview.version}
						onChanged={onChanged}
						onGoalEdit={managing ? (g, v) => setEditor(freshEditor("complete", v, g)) : undefined}
					/>
					<Archive
						projectId={projectId}
						kind="adjusted"
						count={counts.adjusted}
						version={overview.version}
						onChanged={onChanged}
						onGoalEdit={managing ? (g, v) => setEditor(freshEditor("adjust", v, g)) : undefined}
					/>
				</details>
			) : null}
		</section>
	);
}

export function StageProgress({
	projectId,
	overview,
	onChanged,
}: {
	projectId: string;
	overview: ProjectOverview;
	onChanged: () => Promise<void>;
}) {
	const [editor, setEditor] = useEditor(projectId, "dynamic:progress");
	return (
		<Archive
			projectId={projectId}
			kind="progress"
			count={overview.archiveCounts?.progress ?? 0}
			version={overview.version}
			onChanged={onChanged}
			onEdit={(p, v) => setEditor(freshEditor("edit-progress", v, p))}
			actions={
				<>
					<button
						type="button"
						className="min-h-9 text-[15px] font-medium text-[#3B57D0]"
						onClick={() => setEditor(freshEditor("record", overview.version))}
					>
						记录阶段成果
					</button>
					{editor ? (
						<RecordEditor
							key={editor.key}
							projectId={projectId}
							editor={editor}
							onChange={setEditor}
							onSaved={onChanged}
						/>
					) : null}
				</>
			}
		/>
	);
}
