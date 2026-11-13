import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type LibraryProject, type ResourceInfo } from "../api.ts";
import { PageHeader, useProject } from "../components/AppShell.tsx";
import DeleteResource from "../components/DeleteResource.tsx";
import { EmptyNote, ErrorNote, LoadingNote, errorText } from "../components/StatusMessage.tsx";
import { dayLabel, formatBytes } from "../utils.ts";

const MAX_BYTES = 10 * 1024 * 1024;

type UploadState = { state: "uploading" | "failed"; error?: string; file?: File };

async function fileToBase64(file: File): Promise<string> {
	const bytes = new Uint8Array(await file.arrayBuffer());
	// Chunked conversion — a 10MB file as one char-by-char loop churns strings.
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

export default function ResourcesPage() {
	const project = useProject();
	return <ResourcesInner key={project.id} project={project} />;
}

function ResourcesInner({ project }: { project: LibraryProject }) {
	const projectId = project.id;
	const navigate = useNavigate();
	const [resources, setResources] = useState<ResourceInfo[] | null>(null);
	const [loadError, setLoadError] = useState<unknown>(null);
	const [uploads, setUploads] = useState<Record<string, UploadState>>({});
	/** 同名确认：待上传文件先停在确认条里，用户选替换或取消。 */
	const [pendingDuplicate, setPendingDuplicate] = useState<File | null>(null);
	const [pickError, setPickError] = useState<unknown>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const load = useCallback(async () => {
		setResources(await api.listResources(projectId));
		setLoadError(null);
	}, [projectId]);

	useEffect(() => {
		load().catch(setLoadError);
	}, [load]);

	const upload = async (file: File) => {
		setPendingDuplicate(null);
		setPickError(null);
		setUploads((u) => ({ ...u, [file.name]: { state: "uploading" } }));
		try {
			await api.uploadResource(projectId, file.name, await fileToBase64(file));
			setUploads((u) => {
				const next = { ...u };
				delete next[file.name];
				return next;
			});
			await load();
		} catch (e) {
			setUploads((u) => ({ ...u, [file.name]: { state: "failed", error: errorText(e), file } }));
		}
	};

	const pick = (file: File) => {
		setPickError(null);
		if (file.size > MAX_BYTES) {
			setPickError(new Error(`「${file.name}」超过 10MB 上限`));
			return;
		}
		if ((resources ?? []).some((r) => r.name === file.name)) {
			setPendingDuplicate(file);
			return;
		}
		void upload(file);
	};

	const headerActions = (
		<div className="flex items-center gap-3">
			<span className="text-[14px] leading-[22px] text-[#595F59]">每份最多10MB</span>
			<button
				type="button"
				className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white"
				onClick={() => inputRef.current?.click()}
			>
				上传资料
			</button>
			<input
				ref={inputRef}
				type="file"
				className="hidden"
				aria-hidden="true"
				tabIndex={-1}
				onChange={(e) => {
					const file = e.target.files?.[0];
					if (file) pick(file);
					e.target.value = "";
				}}
			/>
		</div>
	);

	return (
		<div className="@container max-w-[1040px]">
			<PageHeader title="资料" actions={headerActions} />
			<ErrorNote error={pickError} className="mb-4" />

			{pendingDuplicate ? (
				<div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#805719]/30 bg-[#FFF6E4] px-3 py-2 text-[15px] leading-6 text-[#805719]">
					<span>已存在同名文件「{pendingDuplicate.name}」，替换还是取消？</span>
					<button
						type="button"
						className="h-9 rounded-lg bg-[#2F3530] px-3 text-[15px] font-medium text-white"
						onClick={() => void upload(pendingDuplicate)}
					>
						替换
					</button>
					<button
						type="button"
						className="h-9 rounded-lg border border-[#A8AEA4]/40 px-3 text-[15px] font-medium text-[#242724]"
						onClick={() => setPendingDuplicate(null)}
					>
						取消
					</button>
				</div>
			) : null}

			{loadError && !resources ? (
				<ErrorNote error={loadError} onRetry={() => load().catch(setLoadError)} />
			) : !resources ? (
				<LoadingNote />
			) : resources.length === 0 && Object.keys(uploads).length === 0 ? (
				<div>
					<EmptyNote>暂无资料</EmptyNote>
					<button
						type="button"
						className="mt-3 h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white"
						onClick={() => inputRef.current?.click()}
					>
						上传资料
					</button>
				</div>
			) : (
				<ul>
					<li
						aria-hidden="true"
						className="hidden grid-cols-[minmax(0,1fr)_96px_144px_24px] gap-x-4 border-b border-[#DDDFD9] pb-2 pr-[72px] text-[13px] leading-5 text-[#595F59] @min-[680px]:grid"
					>
						<span>文件名</span>
						<span>大小</span>
						<span>更新日期</span>
						<span />
					</li>
					{resources.map((r) => {
						const up = uploads[r.name];
						return (
							<li key={r.name} className="border-b border-[#DDDFD9] last:border-b-0">
								<div className="flex items-center gap-3">
									<button
										type="button"
										className="grid min-h-16 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_24px] items-center gap-x-4 gap-y-1 py-3 text-left hover:bg-white @min-[680px]:grid-cols-[minmax(0,1fr)_96px_144px_24px]"
										onClick={() => navigate(`/projects/${projectId}/resources/${encodeURIComponent(r.name)}`)}
									>
										<span className="min-w-0 [overflow-wrap:anywhere] text-[16px] font-medium leading-6 text-[#242724]">
											{r.name}
										</span>
										<span className="col-start-1 row-start-2 text-[13px] leading-5 text-[#595F59] @min-[680px]:col-start-auto @min-[680px]:row-start-auto">
											{formatBytes(r.size)}
										</span>
										<span className="col-start-1 row-start-3 text-[13px] leading-5 text-[#595F59] @min-[680px]:col-start-auto @min-[680px]:row-start-auto">
											{dayLabel(r.modifiedAt)}
										</span>
										<span
											className="col-start-2 row-start-1 text-right text-[#595F59] @min-[680px]:col-start-4"
											aria-hidden="true"
										>
											→
										</span>
									</button>
									<DeleteResource
										projectId={projectId}
										resource={r}
										disabled={up?.state === "uploading"}
										onDeleted={async () => {
											setResources((items) => items?.filter((item) => item.name !== r.name) ?? []);
											setUploads((items) => {
												const next = { ...items };
												delete next[r.name];
												return next;
											});
											await load().catch(setLoadError);
										}}
									/>
								</div>
								{up ? (
									<p
										className={`pb-2 pl-1 text-[14px] leading-[22px] ${up.state === "failed" ? "text-[#A6312B]" : "text-[#595F59]"}`}
										role={up.state === "failed" ? "alert" : "status"}
									>
										{up.state === "uploading" ? "上传中…" : `上传失败：${up.error ?? ""}`}
										{up.state === "failed" && up.file ? (
											<button
												type="button"
												className="ml-2 font-medium text-[#315DAD] underline"
												onClick={() => {
													if (up.file) void upload(up.file);
												}}
											>
												重试
											</button>
										) : null}
									</p>
								) : null}
							</li>
						);
					})}
					{/* 尚未出现在列表里的新文件上传状态行 */}
					{Object.entries(uploads)
						.filter(([name]) => !resources.some((r) => r.name === name))
						.map(([name, up]) => (
							<li key={`up-${name}`} className="border-b border-[#DDDFD9] py-2 last:border-b-0">
								<span className="block min-h-14 break-all py-2 text-[16px] font-medium leading-6 text-[#242724]">
									{name}
								</span>
								<p
									className={`pb-2 pl-1 text-[14px] leading-[22px] ${up.state === "failed" ? "text-[#A6312B]" : "text-[#595F59]"}`}
									role={up.state === "failed" ? "alert" : "status"}
								>
									{up.state === "uploading" ? "上传中…" : `上传失败：${up.error ?? ""}`}
									{up.state === "failed" && up.file ? (
										<button
											type="button"
											className="ml-2 font-medium text-[#315DAD] underline"
											onClick={() => {
												if (up.file) void upload(up.file);
											}}
										>
											重试
										</button>
									) : null}
								</p>
							</li>
						))}
				</ul>
			)}
		</div>
	);
}
