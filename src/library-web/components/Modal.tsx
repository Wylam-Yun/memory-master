import { type ReactNode, useEffect, useRef } from "react";

/**
 * 简单可控弹窗：Esc 关闭、遮罩点击关闭、打开时聚焦第一个控件、关闭后焦点
 * 回到触发元素。短表单（新建项目等）使用，不承载长文编辑。
 */
export default function Modal({
	open,
	onClose,
	title,
	children,
	widthClass = "max-w-[480px]",
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	widthClass?: string;
}) {
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const dialog = ref.current;
		const previouslyFocused = (dialog?.ownerDocument.activeElement ?? document.activeElement) as HTMLElement | null;
		const doc = dialog?.ownerDocument ?? document;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		doc.addEventListener("keydown", onKeyDown, true);
		const timer = window.setTimeout(() => {
			dialog?.querySelector<HTMLElement>("input, textarea, select, button:not([disabled])")?.focus();
		}, 0);
		return () => {
			doc.removeEventListener("keydown", onKeyDown, true);
			window.clearTimeout(timer);
			if (previouslyFocused?.isConnected) previouslyFocused.focus();
		};
	}, [open, onClose]);

	if (!open) return null;
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
			onClick={onClose}
			role="presentation"
		>
			<div
				ref={ref}
				role="dialog"
				aria-modal="true"
				aria-label={title}
				className={`w-full ${widthClass} rounded-xl border border-[#E5E7EB] bg-white p-6 shadow-xl`}
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="mb-4 text-[20px] font-semibold leading-7 text-[#202124]">{title}</h2>
				{children}
			</div>
		</div>
	);
}
