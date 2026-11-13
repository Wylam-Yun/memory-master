import { useState } from "react";
import { api, ApiError } from "../api.ts";
import Modal from "./Modal.tsx";
import { ErrorNote } from "./StatusMessage.tsx";

export default function DeleteResource({
	projectId,
	resource,
	onDeleted,
	disabled = false,
}: {
	projectId: string;
	resource: { name: string; version: string };
	onDeleted: () => Promise<void> | void;
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [version, setVersion] = useState("");
	const [error, setError] = useState<unknown>(null);
	const remove = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.deleteResource(projectId, resource.name, version);
			setOpen(false);
			await onDeleted();
		} catch (e) {
			setError(
				e instanceof ApiError && e.code === "VERSION_CONFLICT"
					? new Error("资料已被替换。请取消删除并刷新页面，核对最新文件后再删除。")
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
				aria-label={`删除 ${resource.name}`}
				disabled={disabled || busy}
				className="shrink-0 rounded-lg px-3 py-2 text-[14px] font-medium text-[#A6312B] hover:bg-[#FFF1F0] disabled:opacity-50"
				onClick={() => {
					setError(null);
					setVersion(resource.version);
					setOpen(true);
				}}
			>
				删除
			</button>
			<Modal
				open={open}
				onClose={() => {
					if (!busy) setOpen(false);
				}}
				title="删除资料"
			>
				<p className="break-all text-[15px] leading-6 text-[#242724]">确定删除「{resource.name}」吗？</p>
				<p className="mt-2 text-[14px] leading-6 text-[#595F59]">
					这会移除记忆库中上传的文件。需要再次使用时可重新上传。
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
						disabled={busy}
						className="h-10 rounded-lg bg-[#A6312B] px-4 text-[15px] font-medium text-white disabled:opacity-50"
						onClick={() => void remove()}
					>
						{busy ? "删除中…" : "确认删除"}
					</button>
				</div>
			</Modal>
		</>
	);
}
