import { useState } from "react";
import { api, ApiError, type LibraryProject } from "../api.ts";
import Modal from "./Modal.tsx";
import { ErrorNote } from "./StatusMessage.tsx";

export default function DeleteProject({
	project,
	onDeleted,
}: {
	project: LibraryProject;
	onDeleted: () => Promise<void>;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [snapshot, setSnapshot] = useState<(LibraryProject & { version: string }) | null>(null);
	const [error, setError] = useState<unknown>(null);
	const prepare = async () => {
		setOpen(true);
		setSnapshot(null);
		setError(null);
		setBusy(true);
		try {
			setSnapshot(await api.getProjectDeletion(project.id));
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (!snapshot) return;
		setBusy(true);
		setError(null);
		try {
			await api.deleteProject(project.id, snapshot.version);
			setOpen(false);
			await onDeleted();
		} catch (e) {
			setError(
				e instanceof ApiError && e.code === "VERSION_CONFLICT"
					? new Error("项目内容已更新。请取消删除，核对最新内容后再删除。")
					: e,
			);
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<button
				type="button"
				aria-label={`删除项目 ${project.name}`}
				disabled={busy}
				className="shrink-0 rounded-lg px-3 py-2 text-[14px] font-medium text-[#A6312B] hover:bg-[#FFF1F0] disabled:opacity-50"
				onClick={() => void prepare()}
			>
				删除项目
			</button>
			<Modal
				open={open}
				onClose={() => {
					if (!busy) setOpen(false);
				}}
				title="删除项目"
			>
				<p className="break-words text-[15px] leading-6 text-[#242724]">
					确定删除「{snapshot?.name ?? project.name}」吗？
				</p>
				<p className="mt-2 text-[14px] leading-6 text-[#595F59]">
					项目及其概览、任务、架构、资料和变更记录会移入记忆库的 .trash 回收目录，并从所有项目中移除。
				</p>
				{snapshot?.workingDir ? (
					<p className="mt-2 break-all text-[14px] leading-6 text-[#595F59]">
						关联的本地文件夹会保留在 {snapshot.workingDir}。
					</p>
				) : null}
				<p className="mt-2 text-[14px] leading-6 text-[#595F59]">
					需要恢复时，可将 .trash 中该项目的完整文件夹移回记忆库顶层。
				</p>
				<ErrorNote error={error} className="mt-3" />
				<div className="mt-5 flex justify-end gap-3">
					<button
						type="button"
						disabled={busy}
						className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] text-[#242724]"
						onClick={() => setOpen(false)}
					>
						取消
					</button>
					<button
						type="button"
						disabled={busy || !snapshot}
						className="h-10 rounded-lg bg-[#A6312B] px-4 text-[15px] font-medium text-white disabled:opacity-50"
						onClick={() => void remove()}
					>
						{busy ? "处理中…" : "确认删除"}
					</button>
				</div>
			</Modal>
		</>
	);
}
