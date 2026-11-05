import { PROJECT_CONTENT_NAMES } from "../../library/project-content.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink } from "react-router-dom";
import { ApiError, api, type ProjectOverview } from "../api.ts";
import { GrowingTextarea, useProject } from "../components/AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "../components/drafts.ts";
import { Goals, StageProgress, dateLabel } from "../components/GoalProgress.tsx";
import Markdown from "../components/Markdown.tsx";
import OverviewContent from "../components/OverviewContent.tsx";
import { ErrorNote, LoadingNote, SuccessNote } from "../components/StatusMessage.tsx";
import { OVERVIEW_PAGES, type OverviewField, overviewPagePath } from "../overview-pages.ts";

interface Draft {
	value: string;
	baseVersion: string;
}
const fieldLabel = (field: OverviewField) => PROJECT_CONTENT_NAMES[field];
const draftKey = (field: OverviewField) => `overview:${field}`;

/** Split an older multi-field draft once, keeping every saved edit and its original version. */
function readDraft(projectId: string, field: OverviewField): Draft | null {
	const legacy = getDraft(projectId, "overview");
	if (legacy) {
		try {
			const old = JSON.parse(legacy);
			if (typeof old.baseVersion === "string" && old.fields) {
				for (const page of OVERVIEW_PAGES) {
					if (typeof old.fields[page.field] === "string" && !getDraft(projectId, draftKey(page.field))) {
						setDraft(
							projectId,
							draftKey(page.field),
							JSON.stringify({ value: old.fields[page.field], baseVersion: old.baseVersion }),
						);
					}
				}
				clearDraft(projectId, "overview");
			}
		} catch {}
	}
	try {
		const parsed = JSON.parse(getDraft(projectId, draftKey(field)) ?? "null");
		return parsed && typeof parsed.value === "string" && typeof parsed.baseVersion === "string" ? parsed : null;
	} catch {
		return null;
	}
}

export default function OverviewPage({ field = "description" }: { field?: OverviewField }) {
	const project = useProject();
	return <OverviewInner key={`${project.id}:${field}`} projectId={project.id} field={field} />;
}

function OverviewInner({ projectId, field }: { projectId: string; field: OverviewField }) {
	const [overview, setOverview] = useState<ProjectOverview | null>(null);
	const [editing, setEditing] = useState<Draft | null>(() => readDraft(projectId, field));
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [saveError, setSaveError] = useState<unknown>(null);
	const [newer, setNewer] = useState<ProjectOverview | null>(null);
	const [compareOpen, setCompareOpen] = useState(false);
	const editingRef = useRef(editing);
	editingRef.current = editing;
	const page = OVERVIEW_PAGES.find((p) => p.field === field)!;
	const label = fieldLabel(field);

	const load = useCallback(async () => {
		const fresh = await api.getOverview(projectId);
		setOverview(fresh);
		setLoadError(null);
		return fresh;
	}, [projectId]);

	const refreshTracking = useCallback(async () => {
		await load();
	}, [load]);

	useEffect(() => {
		let active = true;
		const refresh = () =>
			api
				.getOverview(projectId)
				.then((fresh) => {
					if (!active) return;
					setOverview(fresh);
					setLoadError(null);
					if (editingRef.current && fresh.version !== editingRef.current.baseVersion) setNewer(fresh);
				})
				.catch((error) => {
					if (active) setLoadError(error);
				});
		void refresh();
		window.addEventListener("focus", refresh);
		return () => {
			active = false;
			window.removeEventListener("focus", refresh);
		};
	}, [projectId]);

	const updateDraft = (next: Draft) => {
		setEditing(next);
		setDraft(projectId, draftKey(field), JSON.stringify(next));
	};
	const cancelEdit = () => {
		clearDraft(projectId, draftKey(field));
		setEditing(null);
		setSaveError(null);
		setNewer(null);
		setCompareOpen(false);
	};
	const startEdit = () => {
		if (!overview) return;
		setSaveError(null);
		setSaved(false);
		updateDraft({ value: overview[field] ?? "", baseVersion: overview.version });
	};
	const save = async (baseVersion: string) => {
		if (!editing) return;
		setSaving(true);
		setSaveError(null);
		try {
			// A page owns one field. Retrying never overwrites another page's newer content.
			const fresh = await api.putOverview(projectId, { [field]: editing.value }, baseVersion);
			cancelEdit();
			setOverview(fresh);
			setSaved(true);
		} catch (error) {
			if (error instanceof ApiError && error.code === "VERSION_CONFLICT" && error.current) {
				setNewer(error.current as ProjectOverview);
				setCompareOpen(true);
			} else setSaveError(error);
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="max-w-[820px]">
			<h1 className="sr-only">{page.label}</h1>
			<header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-[#E5E7EB]">
				<nav aria-label="概览页面" className="-mb-px flex min-w-0 flex-1 flex-wrap gap-x-6 gap-y-1">
					{OVERVIEW_PAGES.map((item) => (
						<NavLink
							key={item.field}
							to={overviewPagePath(projectId, item.path)}
							end
							className={({ isActive }) =>
								`min-h-11 border-b-2 px-1 py-3 text-[15px] font-medium leading-6 ${isActive ? "border-[#3B57D0] text-[#3B57D0]" : "border-transparent text-[#555B65] hover:text-[#202124]"}`
							}
						>
							{item.label}
						</NavLink>
					))}
				</nav>
				<div className="flex shrink-0 items-center gap-2 py-2">
					{overview ? (
						editing ? (
							<>
								<button
									type="button"
									className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
									disabled={saving}
									onClick={() => save(editing.baseVersion)}
								>
									{saving ? "保存中…" : "保存"}
								</button>
								<button
									type="button"
									className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium disabled:opacity-50"
									disabled={saving}
									onClick={cancelEdit}
								>
									取消
								</button>
							</>
						) : (
							<button
								type="button"
								className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium"
								onClick={startEdit}
							>
								编辑
							</button>
						)
					) : undefined}
				</div>
			</header>
			{loadError ? <ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} className="mb-4" /> : null}
			{!overview ? (
				<LoadingNote />
			) : editing ? (
				<>
					{newer ? (
						<div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg bg-[#FFF6E4] px-3 py-2 text-[15px] leading-6 text-[#88550D]">
							<span>内容已更新。</span>
							<button type="button" className="font-medium underline" onClick={() => setCompareOpen(true)}>
								查看最新内容
							</button>
						</div>
					) : null}
					{compareOpen && newer ? (
						<section className="mb-6 space-y-4 rounded-xl border border-[#E5E7EB] bg-white p-4">
							<h2 className="text-[18px] font-semibold">最新的{label}</h2>
							<div className="text-[16px] leading-7">
								<Markdown source={newer[field] ?? ""} />
							</div>
							<p className="text-[15px] leading-6">你的输入保留在下方。核对后可覆盖本页内容，其他页面保持原样。</p>
							<div className="flex flex-wrap gap-3">
								<button
									type="button"
									className="min-h-10 rounded-lg bg-[#3B57D0] px-4 py-2 text-[15px] font-medium text-white disabled:opacity-50"
									disabled={saving}
									onClick={() => save(newer.version)}
								>
									以我的内容覆盖
								</button>
								<button
									type="button"
									className="min-h-10 px-2 text-[15px] font-medium text-[#3B57D0]"
									onClick={() => setCompareOpen(false)}
								>
									继续编辑
								</button>
								<button
									type="button"
									className="min-h-10 px-2 text-[15px] font-medium"
									disabled={saving}
									onClick={cancelEdit}
								>
									放弃本次修改
								</button>
							</div>
						</section>
					) : null}
					<GrowingTextarea
						value={editing.value}
						onChange={(value) => updateDraft({ ...editing, value })}
						aria-label={label}
					/>
					<ErrorNote error={saveError} className="mt-4" />
				</>
			) : (
				<>
					{saved ? <SuccessNote>已保存</SuccessNote> : null}
					{field === "current" ? (
						<section className="mb-10">
							<div className="mb-4 flex flex-wrap items-baseline gap-3">
								<h2 className="text-[20px] font-semibold leading-7">{PROJECT_CONTENT_NAMES.current}</h2>
								{overview.currentUpdatedAt ? (
									<span className="text-[14px] text-[#555B65]">更新于 {dateLabel(overview.currentUpdatedAt)}</span>
								) : null}
							</div>
							<OverviewContent field="current" source={overview.current} />
						</section>
					) : (
						<OverviewContent field={field} source={overview[field] ?? ""} />
					)}
					{field === "current" ? (
						<>
							<Goals projectId={projectId} overview={overview} onChanged={refreshTracking} />
							<div className="mt-10 border-t border-[#E5E7EB] pt-4">
								<StageProgress projectId={projectId} overview={overview} onChanged={refreshTracking} />
							</div>
						</>
					) : null}
				</>
			)}
		</div>
	);
}
