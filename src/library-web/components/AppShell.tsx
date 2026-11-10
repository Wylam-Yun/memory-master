import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useOutletContext, useParams } from "react-router-dom";
import type { LibraryProject } from "../api.ts";
import { isOverviewPage } from "../overview-pages.ts";

const NAV_ITEMS = [
	{ to: ".", label: "概览", end: true },
	{ to: "architecture", label: "项目架构" },
	{ to: "resources", label: "资料" },
	{ to: "history", label: "变更记录" },
] as const;

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
	`block rounded-lg px-3 py-2 text-[15px] font-medium leading-6 ${
		isActive ? "bg-[#EEF2FF] text-[#3B57D0]" : "text-[#202124] hover:bg-[#EEF2FF]/60"
	}`;

/** 页头：页面标题（28px，窄屏24）+ 右侧当前页主操作位。 */
export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
	return (
		<div className="mb-6 flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2">
			<h1 className="text-[24px] font-semibold leading-8 text-[#202124] min-[640px]:text-[28px] min-[640px]:leading-9">
				{title}
			</h1>
			{actions ? <div className="flex flex-wrap items-center gap-3">{actions}</div> : null}
		</div>
	);
}

/** 可增高正文编辑框：随输入撑高（最少 4 行），编辑时不截断长文本。 */
export function GrowingTextarea({
	value,
	onChange,
	placeholder,
	"aria-label": ariaLabel,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	"aria-label"?: string;
}) {
	const ref = useRef<HTMLTextAreaElement | null>(null);
	useEffect(() => {
		const el = ref.current;
		if (el) {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		}
	}, [value]);
	return (
		<textarea
			ref={ref}
			className="w-full resize-none overflow-hidden rounded-lg border border-[#8A9099]/50 bg-white px-3 py-2 text-[16px] leading-7 text-[#202124] focus:border-[#3B57D0] focus:outline-none"
			style={{ minHeight: "7.5rem" }}
			value={value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}

/** 轻量下拉：按钮 + 浮层，点外或 Esc 关闭。children 收 close 用于点击后收起。 */
function Dropdown({
	label,
	className = "",
	menuClassName = "",
	children,
}: {
	label: ReactNode;
	className?: string;
	menuClassName?: string;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const close = () => setOpen(false);
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setOpen(false);
			}
		};
		document.addEventListener("keydown", onKeyDown, true);
		return () => document.removeEventListener("keydown", onKeyDown, true);
	}, [open]);
	return (
		<div className={`relative ${className}`}>
			<button
				type="button"
				className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#8A9099]/40 bg-white px-3 py-2 text-left text-[15px] font-medium leading-6 text-[#202124]"
				aria-expanded={open}
				aria-haspopup="menu"
				onClick={() => setOpen((o) => !o)}
			>
				<span className="min-w-0 truncate">{label}</span>
				<span aria-hidden="true">▾</span>
			</button>
			{open ? (
				<>
					<button
						type="button"
						aria-label="关闭菜单"
						tabIndex={-1}
						className="fixed inset-0 z-20 cursor-default"
						onClick={() => setOpen(false)}
					/>
					<div
						className={`absolute z-30 mt-1 rounded-xl border border-[#E5E7EB] bg-white py-1 shadow-lg ${menuClassName}`}
					>
						{children(close)}
					</div>
				</>
			) : null}
		</div>
	);
}

function ProjectNav({ onNavigate }: { onNavigate?: () => void }) {
	const { id = "" } = useParams();
	const { pathname } = useLocation();
	const overviewActive = isOverviewPage(id, pathname);
	return (
		<nav className="flex flex-col gap-0.5" aria-label="项目导航">
			{NAV_ITEMS.map((item) =>
				item.to === "." ? (
					<Link
						key={item.label}
						to="."
						className={navLinkClass({ isActive: overviewActive })}
						aria-current={overviewActive ? "page" : undefined}
						onClick={onNavigate}
					>
						概览
					</Link>
				) : (
					<NavLink key={item.label} to={item.to} className={navLinkClass} onClick={onNavigate}>
						{item.label}
					</NavLink>
				),
			)}
		</nav>
	);
}

/**
 * 项目外壳：≥960px 常驻侧栏（项目切换器 + 项目入口 + 所有项目/项目设置），窄屏收
 * 为顶栏「项目导航 ▾」菜单。项目经 Outlet context 传给各页面。
 */
export default function AppShell({ projects }: { projects: LibraryProject[] }) {
	const { id } = useParams();
	const navigate = useNavigate();
	const project = projects.find((p) => p.id === id);

	if (!project) {
		return (
			<div className="flex min-h-screen flex-col items-center justify-center bg-[#FAFAF8] px-4 text-[#202124]">
				<p className="text-[20px] font-semibold leading-7">项目不存在</p>
				<Link to="/" className="mt-4 text-[15px] font-medium text-[#3B57D0]">
					← 返回所有项目
				</Link>
			</div>
		);
	}

	const switcher = (
		<Dropdown label={project.name} menuClassName="left-0 right-0 max-h-80 overflow-y-auto">
			{(close) => (
				<>
					{projects.map((p) => (
						<button
							key={p.id}
							type="button"
							className={`block w-full px-3 py-2 text-left text-[15px] leading-6 ${
								p.id === project.id ? "bg-[#EEF2FF] font-medium text-[#3B57D0]" : "text-[#202124] hover:bg-[#EEF2FF]/60"
							}`}
							onClick={() => {
								close();
								navigate(`/projects/${p.id}`);
							}}
						>
							{p.name}
						</button>
					))}
					<Link
						to="/"
						className="block border-t border-[#E5E7EB] px-3 py-2 text-[15px] leading-6 text-[#202124] hover:bg-[#EEF2FF]/60"
						onClick={close}
					>
						所有项目
					</Link>
				</>
			)}
		</Dropdown>
	);

	return (
		<div className="min-h-screen bg-[#FAFAF8] text-[#202124]">
			<a
				href="#main-content"
				className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-[#3B57D0] focus:shadow"
			>
				跳到正文
			</a>
			<div className="flex">
				{/* ≥960px 常驻侧栏 */}
				<aside className="sticky top-0 hidden h-screen w-[200px] shrink-0 flex-col overflow-y-auto border-r border-[#E5E7EB] bg-white px-3 py-4 min-[960px]:flex min-[1200px]:w-[224px]">
					<Link to="/" className="px-2 text-[16px] font-semibold leading-7 text-[#202124]">
						Memory Master
					</Link>
					<div className="mt-4 px-1">{switcher}</div>
					<div className="mt-4">
						<ProjectNav />
					</div>
					<div className="mt-auto flex flex-col gap-0.5 border-t border-[#E5E7EB] pt-3">
						<Link to="/" className={navLinkClass({ isActive: false })}>
							所有项目
						</Link>
						<NavLink to="settings" className={navLinkClass}>
							项目设置
						</NavLink>
					</div>
				</aside>

				<div className="min-w-0 flex-1">
					{/* <960px 顶栏：当前项目 + 项目导航菜单 */}
					<header className="flex items-center justify-between gap-3 border-b border-[#E5E7EB] bg-white px-4 py-3 min-[960px]:hidden">
						<span className="min-w-0 truncate text-[16px] font-medium leading-7">{project.name}</span>
						<Dropdown label="项目导航" className="w-40 shrink-0" menuClassName="right-0 w-44">
							{(close) => (
								<>
									<ProjectNav onNavigate={close} />
									<Link
										to="/"
										className="mt-1 block border-t border-[#E5E7EB] px-3 py-2 text-[15px] leading-6 text-[#202124] hover:bg-[#EEF2FF]/60"
										onClick={close}
									>
										所有项目
									</Link>
									<Link
										to="settings"
										className="block px-3 py-2 text-[15px] leading-6 text-[#202124] hover:bg-[#EEF2FF]/60"
										onClick={close}
									>
										项目设置
									</Link>
								</>
							)}
						</Dropdown>
					</header>

					<main
						id="main-content"
						className="px-4 py-6 min-[640px]:px-6 min-[960px]:px-8 min-[960px]:py-8 min-[1200px]:px-10"
					>
						<div className="max-w-[1160px]">
							<Outlet context={{ project }} />
						</div>
					</main>
				</div>
			</div>
		</div>
	);
}

export function useProject(): LibraryProject {
	return useOutletContext<{ project: LibraryProject }>().project;
}
