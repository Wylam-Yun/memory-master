import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, type LibraryProject } from "./api.ts";
import AppShell from "./components/AppShell.tsx";
import { ErrorNote } from "./components/StatusMessage.tsx";
import ArchitecturePage from "./pages/ArchitecturePage.tsx";
import HistoryPage from "./pages/HistoryPage.tsx";
import OverviewPage from "./pages/OverviewPage.tsx";
import { OVERVIEW_PAGES } from "./overview-pages.ts";
import ProjectsPage from "./pages/ProjectsPage.tsx";
import ResourcesPage from "./pages/ResourcesPage.tsx";
import ResourceViewPage from "./pages/ResourceViewPage.tsx";
import SettingsPage from "./pages/SettingsPage.tsx";
import TasksPage from "./pages/TasksPage.tsx";

/** First-run screen: choose (or accept the default) memory library location. */
function SetupPage({ defaultRoot, onDone }: { defaultRoot: string; onDone: () => void }) {
	const [root, setRoot] = useState(defaultRoot);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const submit = async () => {
		setBusy(true);
		setError(null);
		try {
			await api.setLibrary(root);
			onDone();
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="min-h-screen bg-[#FAFAF8] text-[#202124]">
			<header className="px-4 py-3 text-[16px] font-semibold leading-7 min-[640px]:px-6">Memory Master</header>
			<main className="mx-auto max-w-[560px] px-4 pb-16 pt-16 min-[640px]:px-6">
				<h1 className="text-[24px] font-semibold leading-8 min-[640px]:text-[28px] min-[640px]:leading-9">
					选择项目记忆的保存位置
				</h1>
				<label className="mt-8 block">
					<span className="sr-only">保存位置</span>
					<input
						ref={inputRef}
						className="h-10 w-full rounded-lg border border-[#8A9099]/50 bg-white px-3 font-mono text-[13px] leading-5 focus:border-[#3B57D0] focus:outline-none"
						value={root}
						onChange={(e) => setRoot(e.target.value)}
					/>
				</label>
				<ErrorNote error={error} className="mt-2" />
				<div className="mt-4 flex items-center gap-4">
					<button
						type="button"
						className="h-10 rounded-lg bg-[#3B57D0] px-4 text-[15px] font-medium text-white disabled:opacity-50"
						disabled={busy || !root.trim()}
						onClick={() => void submit()}
					>
						{busy ? "保存中…" : "使用此位置"}
					</button>
					<button
						type="button"
						className="text-[15px] font-medium text-[#3B57D0]"
						onClick={() => inputRef.current?.focus()}
					>
						更改位置
					</button>
				</div>
				<p className="mt-8 text-[15px] leading-6 text-[#555B65]">一个位置保存各项目的独立记录。</p>
			</main>
		</div>
	);
}

export default function App() {
	const [state, setState] = useState<{
		loaded: boolean;
		error: string | null;
		libraryRoot: string | null;
		defaultLibraryRoot: string;
		projects: LibraryProject[];
	}>({ loaded: false, error: null, libraryRoot: null, defaultLibraryRoot: "", projects: [] });

	const load = useCallback(async () => {
		const lib = await api.getLibrary();
		setState({
			loaded: true,
			error: null,
			libraryRoot: lib.libraryRoot,
			defaultLibraryRoot: lib.defaultLibraryRoot,
			projects: lib.projects,
		});
	}, []);
	useEffect(() => {
		load().catch((e) =>
			setState((s) => ({
				...s,
				loaded: true,
				error: e instanceof Error ? e.message : String(e),
			})),
		);
	}, [load]);

	if (!state.loaded) {
		return <div className="min-h-screen bg-[#FAFAF8] p-8 text-[15px] text-[#555B65]">加载中…</div>;
	}
	if (state.error) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-[#FAFAF8] px-4">
				<div className="max-w-[480px]">
					<ErrorNote error={`无法连接 Memory Master 服务：${state.error}`} onRetry={() => load().catch(() => {})} />
				</div>
			</div>
		);
	}
	if (!state.libraryRoot) {
		return <SetupPage defaultRoot={state.defaultLibraryRoot} onDone={load} />;
	}
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<ProjectsPage projects={state.projects} reload={load} />} />
				<Route path="/projects" element={<Navigate to="/" replace />} />
				<Route path="/settings" element={<SettingsPage libraryRoot={state.libraryRoot} reload={load} />} />
				<Route path="/projects/:id" element={<AppShell projects={state.projects} />}>
					{OVERVIEW_PAGES.map((page) =>
						page.path ? (
							<Route key={page.field} path={page.path} element={<OverviewPage field={page.field} />} />
						) : (
							<Route key={page.field} index element={<OverviewPage field={page.field} />} />
						),
					)}
					<Route path="tasks" element={<TasksPage />} />
					<Route path="architecture" element={<ArchitecturePage />} />
					<Route path="resources" element={<ResourcesPage />} />
					<Route path="resources/:name" element={<ResourceViewPage />} />
					<Route path="history" element={<HistoryPage />} />
				</Route>
			</Routes>
		</BrowserRouter>
	);
}
