import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiError, api, type ResourceContent } from "../api.ts";
import { PageHeader, useProject } from "../components/AppShell.tsx";
import DeleteResource from "../components/DeleteResource.tsx";
import Markdown from "../components/Markdown.tsx";
import { LoadingNote } from "../components/StatusMessage.tsx";
import { formatBytes } from "../utils.ts";

/** 预览字节上限：超长文本只显示前一部分，完整文件走下载（防止浏览器冻结）。 */
const PREVIEW_MAX = 512 * 1024;

function download(content: ResourceContent) {
	let blob: Blob;
	if (content.base64 !== undefined) {
		const binary = atob(content.base64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		blob = new Blob([bytes], { type: content.contentType || "application/octet-stream" });
	} else {
		blob = new Blob([content.text ?? ""], { type: "text/plain;charset=utf-8" });
	}
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = content.name;
	a.click();
	URL.revokeObjectURL(url);
}

export default function ResourceViewPage() {
	const project = useProject();
	const navigate = useNavigate();
	const { name = "" } = useParams();
	const [content, setContent] = useState<ResourceContent | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setContent(await api.getResource(project.id, name));
		} catch (e) {
			setContent(null);
			setError(e);
		} finally {
			setLoading(false);
		}
	}, [project.id, name]);

	useEffect(() => {
		void load();
	}, [load]);

	const backLink = `/projects/${project.id}/resources`;

	const headerActions = content ? (
		<div className="flex items-center gap-3">
			<button
				type="button"
				className="h-10 rounded-lg border border-[#8A9099]/40 px-4 text-[15px] font-medium text-[#202124]"
				onClick={() => download(content)}
			>
				下载原件
			</button>
			<DeleteResource projectId={project.id} resource={content} onDeleted={() => navigate(backLink)} />
		</div>
	) : null;

	const notFound = error instanceof ApiError && error.status === 404;

	let body: ReactNode;
	if (loading) {
		body = <LoadingNote />;
	} else if (notFound) {
		body = (
			<div>
				<p className="text-[15px] leading-6 text-[#555B65]">文件不存在</p>
				<Link to={backLink} className="mt-2 inline-block text-[15px] font-medium text-[#3B57D0]">
					← 返回资料
				</Link>
			</div>
		);
	} else if (error) {
		body = (
			<div
				className="rounded-lg border border-[#B42318]/30 bg-[#FFF1F0] px-3 py-2 text-[15px] leading-6 text-[#B42318]"
				role="alert"
			>
				读取失败
				<button type="button" className="ml-3 font-medium underline" onClick={() => void load()}>
					重试
				</button>
			</div>
		);
	} else if (content) {
		if (content.base64 !== undefined) {
			body = (
				<div className="max-w-[560px]">
					<p className="text-[15px] leading-6 text-[#555B65]">
						此格式暂不支持网页预览（{content.contentType} · {formatBytes(content.size)}）
					</p>
					<button
						type="button"
						className="mt-4 h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white"
						onClick={() => download(content)}
					>
						下载原件
					</button>
				</div>
			);
		} else {
			const text = content.text ?? "";
			const truncated = text.length > PREVIEW_MAX;
			const shown = truncated ? text.slice(0, PREVIEW_MAX) : text;
			body = (
				<div className="max-w-[820px]">
					{content.name.toLowerCase().endsWith(".md") ? (
						<div className="text-[16px] leading-7">
							<Markdown source={shown} />
						</div>
					) : (
						<pre className="whitespace-pre-wrap break-all text-[15px] leading-6 text-[#202124]">{shown}</pre>
					)}
					{truncated ? (
						<p className="mt-4 text-[14px] leading-[22px] text-[#555B65]">
							内容过长，仅显示前一部分。完整文件请使用「下载原件」。
						</p>
					) : null}
				</div>
			);
		}
	}

	return (
		<div>
			<p className="mb-2">
				<Link to={backLink} className="text-[15px] font-medium leading-6 text-[#3B57D0]">
					← 返回资料
				</Link>
			</p>
			<PageHeader title={name || "资料"} actions={headerActions} />
			{body}
		</div>
	);
}
