import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, type ArchitectureRecord, type LibraryProject, type ProjectMeta, type Task } from "../api.ts";
import ArchitectureDocument from "../components/ArchitectureDocument.tsx";
import { GrowingTextarea, PageHeader, useProject } from "../components/AppShell.tsx";
import { clearDraft, getDraft, setDraft } from "../components/drafts.ts";
import Markdown from "../components/Markdown.tsx";
import Modal from "../components/Modal.tsx";
import { EmptyNote, ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";
import { extractMermaidNodeId, isP0Task, parseCompositionTable } from "../utils.ts";

const DRAFT_WHICH = "architecture";

interface DraftShape {
	content: string;
	baseVersion: string;
}

function readDraft(projectId: string): DraftShape | null {
	const raw = getDraft(projectId, DRAFT_WHICH);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as DraftShape;
		if (parsed && typeof parsed.content === "string" && typeof parsed.baseVersion === "string") return parsed;
	} catch {}
	return null;
}

export default function ArchitecturePage() {
	const project = useProject();
	return <ArchitectureInner key={project.id} project={project} />;
}

function ArchitectureInner({ project }: { project: LibraryProject }) {
	const projectId = project.id;
	const [record, setRecord] = useState<ArchitectureRecord | null>(null);
	const [editing, setEditing] = useState<DraftShape | null>(() => readDraft(projectId));
	const [saving, setSaving] = useState(false);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [saveError, setSaveError] = useState<unknown>(null);
	const [newer, setNewer] = useState<ArchitectureRecord | null>(null);
	const [compareOpen, setCompareOpen] = useState(false);
	const [zoomOpen, setZoomOpen] = useState(false);
	const [zoomSvgs, setZoomSvgs] = useState<string[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [meta, setMeta] = useState<ProjectMeta | null>(null);
	const [tasks, setTasks] = useState<Task[] | null>(null);
	const [taskError, setTaskError] = useState<unknown>(null);
	const tasksLoading = useRef(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (highlightTimer.current) clearTimeout(highlightTimer.current);
		},
		[],
	);
	const editingRef = useRef(editing);
	editingRef.current = editing;

	const load = useCallback(async () => {
		const fresh = await api.getArchitecture(projectId);
		setRecord(fresh);
		setLoadError(null);
		return fresh;
	}, [projectId]);

	useEffect(() => {
		load()
			.then((fresh) => {
				// 恢复的草稿基于旧版本 → 提示有新内容，供比较入口使用。
				const edit = editingRef.current;
				if (edit && fresh.version !== edit.baseVersion) setNewer(fresh);
			})
			.catch(setLoadError);
	}, [load]);

	// 关联任务只在需要时拉取（展开带任务列的组成行时）。
	const ensureTasks = useCallback(async () => {
		if (tasks || tasksLoading.current) return;
		tasksLoading.current = true;
		setTaskError(null);
		try {
			const [m, ts] = await Promise.all([api.getProject(projectId), api.listTasks(projectId)]);
			setMeta(m);
			setTasks(ts);
		} catch (error) {
			setTaskError(error);
		} finally {
			tasksLoading.current = false;
		}
	}, [projectId, tasks]);

	// 窗口重新聚焦时核对版本：读态静默刷新，编辑态只提示有新版本、不碰草稿。
	useEffect(() => {
		const onFocus = () => {
			api
				.getArchitecture(projectId)
				.then((fresh) => {
					setRecord(fresh);
					const edit = editingRef.current;
					if (edit && fresh.version !== edit.baseVersion) setNewer(fresh);
				})
				.catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [projectId]);

	const startEdit = () => {
		if (!record) return;
		setSaveError(null);
		setCompareOpen(false);
		const draft = { content: record.content, baseVersion: record.version };
		setDraft(projectId, DRAFT_WHICH, JSON.stringify(draft));
		setEditing(draft);
	};

	const changeContent = (value: string) => {
		setEditing((prev) => {
			if (!prev) return prev;
			const next = { ...prev, content: value };
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

	const applySaved = (fresh: ArchitectureRecord) => {
		clearDraft(projectId, DRAFT_WHICH);
		setRecord(fresh);
		setEditing(null);
		setNewer(null);
		setCompareOpen(false);
		setSaveError(null);
	};

	const save = async (content: string, baseVersion: string) => {
		setSaving(true);
		setSaveError(null);
		try {
			applySaved(await api.putArchitecture(projectId, content, baseVersion));
		} catch (e) {
			if (e instanceof ApiError && e.code === "VERSION_CONFLICT" && e.current) {
				setNewer(e.current as ArchitectureRecord);
				setCompareOpen(true);
			} else {
				setSaveError(e);
			}
		} finally {
			setSaving(false);
		}
	};

	const content = editing ? editing.content : (record?.content ?? "");
	const rows = parseCompositionTable(content);

	// 图节点点击 → best-effort 匹配组成表 ID，命中即选中对应行。
	const onDiagramClick = (e: React.MouseEvent) => {
		const target = e.target as Element | null;
		const node = target?.closest?.("g.node") ?? target?.closest?.("[id^='flowchart-']") ?? target?.closest?.("g[id]");
		const domId = node?.getAttribute("id") ?? "";
		const nodeId = extractMermaidNodeId(domId) ?? domId;
		const row = rows.find((r) => r.id && r.id === nodeId);
		if (row) {
			setSelectedId(row.id);
			if (highlightTimer.current) clearTimeout(highlightTimer.current);
			highlightTimer.current = setTimeout(() => setSelectedId(null), 1800);
			document.getElementById(`comp-${row.id}`)?.scrollIntoView({ block: "nearest" });
		}
	};

	const openZoom = () => {
		const svgs = Array.from(containerRef.current?.querySelectorAll(".mermaid svg") ?? []).map((s) => s.outerHTML);
		setZoomSvgs(svgs);
		setZoomOpen(true);
	};

	if (loadError && !record) {
		return (
			<div>
				<PageHeader title="项目架构" />
				<ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} />
			</div>
		);
	}
	if (!record) {
		return (
			<div>
				<PageHeader title="项目架构" />
				<LoadingNote />
			</div>
		);
	}

	const p0TaskIds = new Set((tasks ?? []).filter((t) => meta && isP0Task(t, meta.p0)).map((t) => t.id));

	const headerActions = editing ? (
		<>
			<button
				type="button"
				className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white disabled:opacity-50"
				disabled={saving}
				onClick={() => save(editing.content, editing.baseVersion)}
			>
				{saving ? "保存中…" : "保存"}
			</button>
			<button
				type="button"
				className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724] disabled:opacity-50"
				disabled={saving}
				onClick={cancelEdit}
			>
				取消
			</button>
		</>
	) : (
		<>
			<button
				type="button"
				className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724]"
				onClick={startEdit}
			>
				编辑
			</button>
			{record.content.trim() ? (
				<button
					type="button"
					className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724]"
					onClick={openZoom}
				>
					放大
				</button>
			) : null}
		</>
	);

	const conflictPanel =
		editing && compareOpen && newer ? (
			<section className="mb-8 rounded-xl border border-[#DDDFD9] bg-white p-4">
				<h2 className="mb-3 text-[16px] font-semibold leading-6">内容已更新</h2>
				<p className="mb-3 text-[14px] leading-[22px] text-[#595F59]">
					另一方已保存了新版本。以下是当前最新内容，你可以用自己的修改覆盖，或放弃本次修改。
				</p>
				<div className="max-h-72 overflow-y-auto rounded-lg bg-[#F7F7F4] p-3">
					<Markdown source={newer.content || "（空）"} />
				</div>
				<div className="mt-4 flex flex-wrap gap-3">
					<button
						type="button"
						className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white disabled:opacity-50"
						disabled={saving}
						onClick={() => save(editing.content, newer.version)}
					>
						以我的内容覆盖
					</button>
					<button
						type="button"
						className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724] disabled:opacity-50"
						disabled={saving}
						onClick={cancelEdit}
					>
						放弃本次修改
					</button>
					<button
						type="button"
						className="h-10 px-2 text-[15px] font-medium text-[#315DAD]"
						onClick={() => setCompareOpen(false)}
					>
						继续编辑
					</button>
				</div>
			</section>
		) : null;

	return (
		<div className="@container">
			<PageHeader title="项目架构" actions={headerActions} />

			{editing ? (
				<>
					{newer ? (
						<div className="mb-6 flex flex-wrap items-center gap-3 rounded-lg border border-[#805719]/30 bg-[#FFF6E4] px-3 py-2 text-[15px] leading-6 text-[#805719]">
							<span>内容已更新。</span>
							<button type="button" className="font-medium underline" onClick={() => setCompareOpen(true)}>
								查看最新内容
							</button>
						</div>
					) : null}
					{conflictPanel}
					<div className="grid items-start gap-8 @min-[1040px]:grid-cols-2">
						<div>
							<GrowingTextarea
								value={editing.content}
								onChange={changeContent}
								aria-label="项目架构 Markdown"
								placeholder="# 项目架构&#10;&#10;```mermaid&#10;flowchart LR&#10;  a[组成甲] --> b[组成乙]&#10;```"
							/>
							<ErrorNote error={saveError} className="my-4" />
						</div>
						<div>
							<h2 className="mb-3 text-[20px] font-semibold leading-7">预览</h2>
							<div ref={containerRef} onClick={onDiagramClick}>
								<ArchitectureDocument
									source={content}
									projectId={projectId}
									selectedId={selectedId}
									tasks={tasks}
									taskError={taskError}
									p0TaskIds={p0TaskIds}
									onShowDetails={() => void ensureTasks()}
								/>
							</div>
						</div>
					</div>
					<div className="mt-6 flex gap-3">
						<button
							type="button"
							className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white disabled:opacity-50"
							disabled={saving}
							onClick={() => save(editing.content, editing.baseVersion)}
						>
							{saving ? "保存中…" : "保存"}
						</button>
						<button
							type="button"
							className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724] disabled:opacity-50"
							disabled={saving}
							onClick={cancelEdit}
						>
							取消
						</button>
					</div>
				</>
			) : !record.content.trim() ? (
				<div className="max-w-[560px]">
					<EmptyNote>尚未整理项目架构</EmptyNote>
					<div className="mt-4 flex items-center gap-3">
						<button
							type="button"
							className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white"
							onClick={startEdit}
						>
							编辑
						</button>
						<span className="text-[15px] leading-6 text-[#595F59]">也可以在聊天里让 Agent 整理</span>
					</div>
				</div>
			) : (
				<div ref={containerRef} onClick={onDiagramClick}>
					<ArchitectureDocument
						source={record.content}
						projectId={projectId}
						selectedId={selectedId}
						tasks={tasks}
						taskError={taskError}
						p0TaskIds={p0TaskIds}
						onShowDetails={() => void ensureTasks()}
					/>
				</div>
			)}

			<Modal open={zoomOpen} onClose={() => setZoomOpen(false)} title="项目架构" widthClass="w-[96vw] max-w-[1200px]">
				<div className="max-h-[80vh] overflow-auto">
					{zoomSvgs.length > 0 ? (
						zoomSvgs.map((svg, i) => (
							// 渲染自本页受控 Mermaid 输出（securityLevel strict）的 SVG 副本。
							<div key={i} dangerouslySetInnerHTML={{ __html: svg }} />
						))
					) : (
						<EmptyNote>没有可放大的图</EmptyNote>
					)}
				</div>
			</Modal>
		</div>
	);
}
