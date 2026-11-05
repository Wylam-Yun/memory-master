import type { ReactNode } from "react";

/** 统一的就地状态小件：错误红字+重试、成功短提示、空态、加载占位。 */

export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function ErrorNote({
	error,
	onRetry,
	className = "",
}: {
	error: unknown;
	onRetry?: (() => void) | undefined;
	className?: string;
}) {
	if (!error) return null;
	return (
		<div
			className={`rounded-lg border border-[#B42318]/30 bg-[#FFF1F0] px-3 py-2 text-[15px] leading-6 text-[#B42318] ${className}`}
			role="alert"
		>
			{errorText(error)}
			{onRetry ? (
				<button type="button" className="ml-3 font-medium underline" onClick={onRetry}>
					重试
				</button>
			) : null}
		</div>
	);
}

export function SuccessNote({ children }: { children: ReactNode }) {
	return (
		<div className="rounded-lg bg-[#EDF8F0] px-3 py-2 text-[15px] leading-6 text-[#216C45]" role="status">
			{children}
		</div>
	);
}

export function EmptyNote({ children }: { children: ReactNode }) {
	return <p className="text-[15px] leading-6 text-[#555B65]">{children}</p>;
}

export function LoadingNote({ text = "加载中…" }: { text?: string }) {
	return <p className="py-8 text-[15px] leading-6 text-[#555B65]">{text}</p>;
}
