import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, type ProjectOverview } from "../api.ts";
import { GrowingTextarea, PageHeader, useProject } from "../components/AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "../components/drafts.ts";
import { Goals, StageProgress, dateLabel } from "../components/GoalProgress.tsx";
import Markdown from "../components/Markdown.tsx";
import { ErrorNote, LoadingNote, SuccessNote } from "../components/StatusMessage.tsx";

/** 阅读顺序：简介 → 当前进展 → 目标 → 功能与用法。 */
const SECTIONS = [
	{ key: "description", label: "简介" },
	{ key: "current", label: "当前进展" },
	{ key: "goal", label: "目标" },
	{ key: "features", label: "功能与用法" },
] as const;

type FieldKey = (typeof SECTIONS)[number]["key"];
type Fields = Record<FieldKey, string>;

const DRAFT_WHICH = "overview";

function fieldsOf(o: ProjectOverview): Fields {
	return { description: o.description, current: o.current, goal: o.goal, features: o.features };
}

interface DraftShape {
	fields: Fields;
	baseVersion: string;
}

function readDraft(projectId: string): DraftShape | null {
	const raw = getDraft(projectId, DRAFT_WHICH);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as DraftShape;
		if (parsed && typeof parsed.baseVersion === "string" && parsed.fields) return parsed;
	} catch {}
	return null;
}

export default function OverviewPage() {
	const project = useProject();
	// 切换项目时整页重置，草稿按项目 ID 隔离（React 不会为 :id 变化自动卸载页面）。
	return <OverviewInner key={project.id} project={project} />;
}

function OverviewInner({ project }: { project: { id: string } }) {
	const projectId = project.id;
	const [overview, setOverview] = useState<ProjectOverview | null>(null);
	const [editing, setEditing] = useState<DraftShape | null>(() => readDraft(projectId));
	const [saving, setSaving] = useState(false);
	const [savedTick, setSavedTick] = useState(false);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [saveError, setSaveError] = useState<unknown>(null);
	/** 编辑中服务端出现了新版本（focus 重读或 409）——最新快照，供比较面板展示。 */
	const [newer, setNewer] = useState<ProjectOverview | null>(null);
	const [compareOpen, setCompareOpen] = useState(false);
	const editingRef = useRef(editing);
	editingRef.current = editing;

	const load = useCallback(async () => {
		const fresh = await api.getOverview(projectId);
		setOverview(fresh);
		setLoadError(null);
		return fresh;
	}, [projectId]);

	const refreshTracking = useCallback(async () => {
		try {
			await load();
		} catch (error) {
			setLoadError(error);
			throw error;
		}
	}, [load]);

	useEffect(() => {
		load()
			.then((fresh) => {
				// 恢复的草稿基于旧版本 → 提示有新内容，供比较入口使用。
				const edit = editingRef.current;
				if (edit && fresh.version !== edit.baseVersion) setNewer(fresh);
			})
			.catch(setLoadError);
	}, [load]);

	// 窗口重新聚焦时核对版本：读态静默刷新，编辑态只提示有新版本、不碰草稿。
	useEffect(() => {
		const onFocus = () => {
			api
				.getOverview(projectId)
				.then((fresh) => {
					setOverview(fresh);
					const edit = editingRef.current;
					if (edit && fresh.version !== edit.baseVersion) {
						setNewer(fresh);
					}
				})
				.catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [projectId]);

	const startEdit = () => {
		if (!overview) return;
		setSaveError(null);
		setCompareOpen(false);
		const draft = { fields: fieldsOf(overview), baseVersion: overview.version };
		setDraft(projectId, DRAFT_WHICH, JSON.stringify(draft));
		setEditing(draft);
	};

	const changeField = (key: FieldKey, value: string) => {
		setEditing((prev) => {
			if (!prev) return prev;
			const next = { ...prev, fields: { ...prev.fields, [key]: value } };
			setDraft(projectId, DRAFT_WHICH, JSON.stringify(next));
			return next;
		});
	};

	const cancelEdit = () => {
		clearDraft(projectId, DRAFT_WHICH);
		setEditing(null);
		setSaveError(null);
		setNewer(null);
		setCompareOpen(false);
	};

	const applySaved = (fresh: ProjectOverview) => {
		clearDraft(projectId, DRAFT_WHICH);
		setOverview(fresh);
		setEditing(null);
		setNewer(null);
		setCompareOpen(false);
		setSaveError(null);
		setSavedTick(true);
		window.setTimeout(() => setSavedTick(false), 2500);
	};

	const save = async (fields: Fields, baseVersion: string) => {
		setSaving(true);
		setSaveError(null);
		try {
			const { goal: _legacyGoal, ...editable } = fields;
			applySaved(await api.putOverview(projectId, editable, baseVersion));
		} catch (e) {
			if (e instanceof ApiError && e.code === "VERSION_CONFLICT" && e.current) {
				setNewer(e.current as ProjectOverview);
				setCompareOpen(true);
			} else {
				setSaveError(e);
			}
		} finally {
			setSaving(false);
		}
	};

	if (loadError && !overview) {
		return (
			<div className="max-w-[820px]">
				<PageHeader title="概览" />
				<ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} />
			</div>
		);
	}
	if (!overview) {
		return (
			<div className="max-w-[820px]">
				<PageHeader title="概览" />
				<LoadingNote />
			</div>
		);
	}

	const headerActions = editing ? (
		<>
			<button
				type="button"
				className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
				disabled={saving}
				onClick={() => save(editing.fields, editing.baseVersion)}
			>
				{saving ? "保存中…" : "保存"}
			</button>
			<button
				type="button"
				className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium text-[#202124] disabled:opacity-50"
				disabled={saving}
				onClick={cancelEdit}
			>
				取消
			</button>
		</>
	) : (
		<button
			type="button"
			className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium text-[#202124]"
			onClick={startEdit}
		>
			编辑
		</button>
	);

	return (
		<div className="max-w-[820px]">
			<PageHeader title="概览" actions={headerActions} />
			{loadError ? <ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} className="mb-4" /> : null}

			{savedTick && !editing ? <SuccessNote>已保存</SuccessNote> : null}

			{editing ? (
				<>
					{newer ? (
						<div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-[#88550D]/30 bg-[#FFF6E4] px-3 py-2 text-[15px] leading-6 text-[#88550D]">
							<span>内容已更新。</span>
							<button type="button" className="font-medium underline" onClick={() => setCompareOpen(true)}>
								查看最新内容
							</button>
						</div>
					) : null}

					{compareOpen && newer ? (
						<section className="mb-8 rounded-xl border border-[#E5E7EB] bg-white p-4">
							<h2 className="mb-3 text-[16px] font-semibold leading-6">内容已更新</h2>
							<p className="mb-3 text-[14px] leading-[22px] text-[#555B65]">
								另一方已保存了新版本。以下是当前最新内容，你可以用自己的修改覆盖，或放弃本次修改。
							</p>
							<dl className="space-y-3">
								{SECTIONS.filter(({ key }) => key !== "goal").map(({ key, label }) => (
									<div key={key}>
										<dt className="text-[14px] font-medium leading-[22px] text-[#555B65]">{label}</dt>
										<dd className="whitespace-pre-wrap text-[15px] leading-6 text-[#202124]">
											{newer[key]?.trim() ? newer[key] : "未填写"}
										</dd>
									</div>
								))}
							</dl>
							<div className="mt-4 flex flex-wrap gap-3">
								<button
									type="button"
									className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
									disabled={saving}
									onClick={() => save(editing.fields, newer.version)}
								>
									以我的内容覆盖
								</button>
								<button
									type="button"
									className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium text-[#202124] disabled:opacity-50"
									disabled={saving}
									onClick={cancelEdit}
								>
									放弃本次修改
								</button>
								<button
									type="button"
									className="h-10 px-2 text-[15px] font-medium text-[#3B57D0]"
									onClick={() => setCompareOpen(false)}
								>
									继续编辑
								</button>
							</div>
						</section>
					) : null}

					{SECTIONS.filter(({ key }) => key !== "goal").map(({ key, label }) => (
						<section key={key} className="mb-8">
							<h2 className="mb-3 text-[20px] font-semibold leading-7">{label}</h2>
							<GrowingTextarea value={editing.fields[key]} onChange={(v) => changeField(key, v)} aria-label={label} />
						</section>
					))}

					<ErrorNote error={saveError} className="mb-4" />
					<div className="flex gap-3">
						<button
							type="button"
							className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
							disabled={saving}
							onClick={() => save(editing.fields, editing.baseVersion)}
						>
							{saving ? "保存中…" : "保存"}
						</button>
						<button
							type="button"
							className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium text-[#202124] disabled:opacity-50"
							disabled={saving}
							onClick={cancelEdit}
						>
							取消
						</button>
					</div>
				</>
			) : (
				<>
					{SECTIONS.map(({ key, label }) => {
						if (key === "goal")
							return <Goals key={key} projectId={projectId} overview={overview} onChanged={refreshTracking} />;
						const body = overview[key];
						return (
							<section key={key} className="mb-8">
								<div className="mb-3 flex flex-wrap items-baseline gap-3">
									<h2 className="text-[20px] font-semibold leading-7">{label}</h2>
									{key === "current" && overview.currentUpdatedAt ? (
										<span className="text-[14px] text-[#555B65]">更新于 {dateLabel(overview.currentUpdatedAt)}</span>
									) : null}
								</div>
								{body.trim() ? (
									<div className="text-[16px] leading-7">
										<Markdown source={body} />
									</div>
								) : (
									<p className="text-[15px] leading-6 text-[#555B65]">
										未填写
										<button type="button" className="ml-2 font-medium text-[#3B57D0]" onClick={startEdit}>
											编辑
										</button>
									</p>
								)}
								{key === "current" ? (
									<StageProgress projectId={projectId} overview={overview} onChanged={refreshTracking} />
								) : null}
							</section>
						);
					})}
					<Link to={`/projects/${projectId}/architecture`} className="text-[15px] font-medium leading-6 text-[#3B57D0]">
						查看项目架构 →
					</Link>
				</>
			)}
		</div>
	);
}
