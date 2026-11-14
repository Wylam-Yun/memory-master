import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type LibraryProject } from "../api.ts";
import Modal from "../components/Modal.tsx";
import DeleteProject from "../components/DeleteProject.tsx";
import { EmptyNote, ErrorNote } from "../components/StatusMessage.tsx";
import { useImeGuard } from "../useImeGuard.ts";

export default function ProjectsPage({ projects, reload }: { projects: LibraryProject[]; reload: () => Promise<void> }) {
	const navigate = useNavigate();
	const [modalOpen, setModalOpen] = useState(false);
	const [name, setName] = useState("");
	const [workingDir, setWorkingDir] = useState("");
	const [dirOpen, setDirOpen] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const [filter, setFilter] = useState("");
	const ime = useImeGuard();

	const closeModal = () => {
		setModalOpen(false);
		setError(null);
	};

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const project = await api.createProject(name.trim(), workingDir.trim() || undefined);
			setModalOpen(false);
			setName("");
			setWorkingDir("");
			setDirOpen(false);
			await reload();
			navigate(`/projects/${project.id}`);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	const shown = filter.trim()
		? projects.filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
		: projects;

	return (
		<div className="min-h-screen bg-[#F7F7F4] text-[#242724]">
			<header className="border-b border-[#DDDFD9] bg-white">
				<div className="mx-auto flex max-w-[1040px] items-center justify-between px-4 py-3 min-[640px]:px-6 min-[960px]:px-8 min-[1200px]:px-10">
					<span className="text-[16px] font-semibold leading-7">Memory Master</span>
					<Link to="/settings" className="text-[15px] font-medium leading-6 text-[#242724] hover:text-[#315DAD]">
						全局设置
					</Link>
				</div>
			</header>
			<main className="mx-auto max-w-[1040px] px-4 py-6 min-[640px]:px-6 min-[960px]:px-8 min-[960px]:py-8 min-[1200px]:px-10">
				<div className="mb-6 flex min-h-[60px] flex-wrap items-center justify-between gap-x-4 gap-y-2">
					<h1 className="text-[26px] font-semibold leading-[34px]">
						所有项目
					</h1>
					<button
						type="button"
						className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white"
						onClick={() => setModalOpen(true)}
					>
						＋ 新建项目
					</button>
				</div>

				{projects.length > 12 ? (
					<input
						className="mb-4 h-10 w-full max-w-[320px] rounded-lg border border-[#A8AEA4]/50 bg-white px-3 text-[15px] leading-6 focus:border-[#315DAD] focus:outline-none"
						placeholder="查找项目"
						aria-label="查找项目"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
					/>
				) : null}

				{projects.length === 0 ? (
					<div>
						<EmptyNote>还没有项目</EmptyNote>
						<button
							type="button"
							className="mt-3 h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white"
							onClick={() => setModalOpen(true)}
						>
							＋ 新建项目
						</button>
					</div>
				) : shown.length === 0 ? (
					<EmptyNote>没有名称匹配的项目</EmptyNote>
				) : (
					<ul>
						{shown.map((p) => (
							<li key={p.id} className="flex items-center gap-3 border-b border-[#DDDFD9] last:border-b-0">
								<Link
									to={`/projects/${p.id}`}
									className="flex min-h-[60px] min-w-0 flex-1 items-center justify-between gap-4 py-3 text-[16px] font-medium leading-6 text-[#242724] hover:bg-white hover:text-[#315DAD]"
								>
									<span className="min-w-0 break-all">{p.name}</span>
									<span className="shrink-0 text-[#595F59]" aria-hidden="true">
										→
									</span>
								</Link>
								<DeleteProject project={p} onDeleted={reload} />
							</li>
						))}
					</ul>
				)}
			</main>

			<Modal open={modalOpen} onClose={closeModal} title="新建项目">
				<form
					{...ime.compositionProps}
					onKeyDown={(e) => {
						if (e.key === "Enter" && ime.inComposition(e)) e.preventDefault();
					}}
					onSubmit={(e) => {
						e.preventDefault();
						void create();
					}}
				>
					<label className="mb-4 block">
						<span className="mb-1 block text-[15px] font-medium leading-6 text-[#242724]">项目名称</span>
						<input
							className="h-10 w-full rounded-lg border border-[#A8AEA4]/50 bg-white px-3 text-[15px] leading-6 focus:border-[#315DAD] focus:outline-none"
							value={name}
							onChange={(e) => setName(e.target.value)}
							required
						/>
					</label>
					<button
						type="button"
						className="mb-2 text-[15px] font-medium leading-6 text-[#315DAD]"
						aria-expanded={dirOpen}
						onClick={() => setDirOpen((o) => !o)}
					>
						关联本地文件夹（可选）{dirOpen ? "收起" : "展开"}
					</button>
					{dirOpen ? (
						<input
							className="mb-2 h-10 w-full rounded-lg border border-[#A8AEA4]/50 bg-white px-3 font-mono text-[13px] leading-5 focus:border-[#315DAD] focus:outline-none"
							placeholder="/绝对/路径（可选）"
							value={workingDir}
							onChange={(e) => setWorkingDir(e.target.value)}
						/>
					) : null}
					<ErrorNote error={error} className="mb-3" />
					<div className="mt-4 flex justify-end gap-3">
						<button
							type="button"
							className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724]"
							onClick={closeModal}
						>
							取消
						</button>
						<button
							type="submit"
							className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white disabled:opacity-50"
							disabled={!name.trim() || busy}
						>
							{busy ? "创建中…" : "创建项目"}
						</button>
					</div>
				</form>
			</Modal>
		</div>
	);
}
