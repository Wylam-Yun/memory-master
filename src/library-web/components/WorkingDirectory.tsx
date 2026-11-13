import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type ProjectMeta } from "../api.ts";
import { useProject } from "./AppShell.tsx";
import Modal from "./Modal.tsx";
import { ErrorNote } from "./StatusMessage.tsx";

export default function WorkingDirectory({ projectId }: { projectId: string }) {
	const associatedDirectory = useProject().workingDir;
	const [project, setProject] = useState<ProjectMeta | null>(null);
	const [editing, setEditing] = useState(false);
	const [directory, setDirectory] = useState("");
	const [baseVersion, setBaseVersion] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		const fresh = await api.getProject(projectId);
		setProject(fresh);
		return fresh;
	}, [projectId]);
	useEffect(() => {
		const refresh = () => {
			void load().catch(setError);
		};
		refresh();
		window.addEventListener("focus", refresh);
		return () => window.removeEventListener("focus", refresh);
	}, [load, associatedDirectory]);
	const edit = async () => {
		setError(null);
		try {
			const fresh = await load();
			setDirectory(fresh.workingDir ?? "");
			setBaseVersion(fresh.version);
			setEditing(true);
		} catch (e) {
			setError(e);
		}
	};
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			const fresh = await api.putProject(projectId, directory.trim() || null, baseVersion);
			setProject(fresh);
			setEditing(false);
		} catch (e) {
			if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
				const latest = e.current as ProjectMeta;
				setProject(latest);
				setError(
					new Error(
						`关联已被修改，当前路径为 ${latest.workingDir ?? "尚未关联"}。你的输入已保留。请重新读取关联后核对并保存。`,
					),
				);
			} else setError(e);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] leading-6 text-[#595F59]">
			<p className="min-w-0 [overflow-wrap:anywhere]">
				本地文件夹 · <span className="font-mono">{project?.workingDir ?? "尚未关联"}</span>
			</p>
			<button
				type="button"
				className="shrink-0 font-medium text-[#595F59] underline-offset-4 hover:text-[#315DAD] hover:underline"
				onClick={() => void edit()}
			>
				{project?.workingDir ? "修改关联" : "关联本地文件夹"}
			</button>
			{!editing ? <ErrorNote error={error} /> : null}
			<Modal
				open={editing}
				onClose={() => {
					if (!busy) setEditing(false);
				}}
				title="关联本地文件夹"
			>
				<label className="block text-[15px] leading-6">
					本地文件夹绝对路径
					<input
						aria-label="本地文件夹绝对路径"
						className="mt-2 h-10 w-full rounded-lg border px-3"
						value={directory}
						onChange={(e) => setDirectory(e.target.value)}
						placeholder="/Users/你的用户名/项目目录"
					/>
				</label>
				<p className="mt-2 text-[14px] leading-6 text-[#595F59]">
					填写已有文件夹的完整路径，Agent 打开项目后可读取此位置。清空路径并保存可解除关联。
				</p>
				<ErrorNote error={error} />
				<div className="mt-4 flex flex-wrap justify-end gap-3">
					{error ? (
						<button type="button" className="text-[#315DAD]" disabled={busy} onClick={() => void edit()}>
							重新读取关联
						</button>
					) : null}
					<button type="button" disabled={busy} onClick={() => setEditing(false)}>
						取消
					</button>
					<button
						type="button"
						className="rounded-lg bg-[#2F3530] px-4 py-2 text-white disabled:opacity-50"
						disabled={busy || !baseVersion}
						onClick={() => void save()}
					>
						{busy ? "保存中…" : "保存关联"}
					</button>
				</div>
			</Modal>
		</div>
	);
}
