import { type ReactNode, useState } from "react";
import { CRITICAL_PATHS_GUIDANCE, PROJECT_CONTENT_NAMES } from "../../library/project-content.ts";
import { ApiError, api, type ProjectOverview } from "../api.ts";
import { OVERVIEW_PAGES, type OverviewField } from "../overview-pages.ts";
import { GrowingTextarea } from "./AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "./drafts.ts";
import Markdown from "./Markdown.tsx";
import { ErrorNote, SuccessNote } from "./StatusMessage.tsx";

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

export default function OverviewFieldEditor({
	projectId,
	field,
	overview,
	onSaved,
	editLabel,
	source,
	children,
}: {
	projectId: string;
	field: OverviewField;
	overview: ProjectOverview;
	onSaved: (overview: ProjectOverview) => void;
	editLabel: string;
	source: ReactNode;
	children: (actions: ReactNode, content: ReactNode) => ReactNode;
}) {
	const [editing, setEditing] = useState<Draft | null>(() => readDraft(projectId, field));
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<unknown>(null);
	const [conflict, setConflict] = useState<ProjectOverview | null>(null);
	const [compareOpen, setCompareOpen] = useState(false);
	const newer = editing && (conflict ?? (overview.version !== editing.baseVersion ? overview : null));
	const label = fieldLabel(field);

	const updateDraft = (next: Draft) => {
		setEditing(next);
		setDraft(projectId, draftKey(field), JSON.stringify(next));
	};
	const cancelEdit = () => {
		clearDraft(projectId, draftKey(field));
		setEditing(null);
		setSaveError(null);
		setConflict(null);
		setCompareOpen(false);
	};
	const save = async (baseVersion: string) => {
		if (!editing) return;
		setSaving(true);
		setSaveError(null);
		try {
			const fresh = await api.putOverview(projectId, { [field]: editing.value }, baseVersion);
			cancelEdit();
			onSaved(fresh);
			setSaved(true);
		} catch (error) {
			if (error instanceof ApiError && error.code === "VERSION_CONFLICT" && error.current) {
				setConflict(error.current as ProjectOverview);
				setCompareOpen(true);
			} else setSaveError(error);
		} finally {
			setSaving(false);
		}
	};
	const actions = editing ? (
		<div className="flex items-center gap-2">
			<button
				type="button"
				className="min-h-9 rounded-md bg-[#2F3530] px-3 text-[14px] font-medium text-white hover:bg-[#242A25] disabled:opacity-50"
				disabled={saving}
				onClick={() => void save(editing.baseVersion)}
			>
				{saving ? "保存中…" : "保存"}
			</button>
			<button
				type="button"
				className="min-h-9 px-2 text-[14px] text-[#595F59] disabled:opacity-50"
				disabled={saving}
				onClick={cancelEdit}
			>
				取消
			</button>
		</div>
	) : (
		<button
			type="button"
			className="min-h-9 rounded-md px-2 text-[13px] font-medium text-[#595F59] underline-offset-4 hover:text-[#315DAD] hover:underline"
			onClick={() => {
				setSaved(false);
				updateDraft({ value: overview[field] ?? "", baseVersion: overview.version });
			}}
		>
			{editLabel}
		</button>
	);
	return children(
		actions,
		editing ? (
			<div className="mt-3">
				{newer ? (
					<div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg bg-[#FFF6E4] px-3 py-2 text-[15px] leading-6 text-[#805719]">
						<span>内容已更新。</span>
						<button type="button" className="font-medium underline" onClick={() => setCompareOpen(true)}>
							查看最新内容
						</button>
					</div>
				) : null}
				{compareOpen && newer ? (
					<section className="mb-6 space-y-4 rounded-xl border border-[#DDDFD9] bg-white p-4">
						<h2 className="text-[18px] font-semibold">最新的{label}</h2>
						<div className="text-[16px] leading-7">
							<Markdown source={newer[field] ?? ""} />
						</div>
						<p className="text-[15px] leading-6">你的输入保留在下方。核对后可覆盖此栏内容，其他栏目保持原样。</p>
						<div className="flex flex-wrap gap-3">
							<button
								type="button"
								className="min-h-10 rounded-lg bg-[#2F3530] px-4 py-2 text-[15px] font-medium text-white disabled:opacity-50"
								disabled={saving}
								onClick={() => save(newer.version)}
							>
								以我的内容覆盖
							</button>
							<button
								type="button"
								className="min-h-10 px-2 text-[15px] font-medium text-[#315DAD]"
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
				{field === "criticalPaths" ? (
					<p className="mb-3 text-[15px] text-[#595F59]">{CRITICAL_PATHS_GUIDANCE}</p>
				) : null}
				<GrowingTextarea
					value={editing.value}
					onChange={(value) => updateDraft({ ...editing, value })}
					aria-label={label}
				/>
				<ErrorNote error={saveError} className="mt-4" />
			</div>
		) : (
			<>
				{saved ? <SuccessNote>已保存</SuccessNote> : null}
				{source}
			</>
		),
	);
}
