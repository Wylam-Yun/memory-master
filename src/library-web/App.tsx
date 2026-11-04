import { useCallback, useEffect, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import {
	ApiError,
	api,
	type ClientSlotInfo,
	hasWebKey,
	type HistoryEntry,
	type LibraryProject,
	setOnUnauthorized,
	setWebKey,
	type Task,
} from "./api.ts";

const STATUSES = ["To Do", "In Progress", "Done"];

function Layout({ children }: { children: React.ReactNode }) {
	return (
		<div className="min-h-screen">
			<header className="border-b bg-white">
				<div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
					<Link to="/" className="font-semibold">
						Memory Master
					</Link>
					<nav className="flex gap-4 text-sm text-gray-600">
						<Link to="/">项目</Link>
						<Link to="/settings">设置</Link>
					</nav>
				</div>
			</header>
			<main className="mx-auto max-w-3xl px-4 py-6">{children}</main>
		</div>
	);
}

function ErrorBox({ error }: { error: unknown }) {
	if (!error) return null;
	return (
		<div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
			{error instanceof Error ? error.message : String(error)}
		</div>
	);
}

/** First-run screen: choose (or accept the default) memory library location. */
function SetupPage({ defaultRoot, onDone }: { defaultRoot: string; onDone: () => void }) {
	const [root, setRoot] = useState(defaultRoot);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);
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
		<Layout>
			<h1 className="mb-2 text-xl font-semibold">选择记忆库位置</h1>
			<p className="mb-4 text-sm text-gray-600">所有项目的记忆数据都会保存在这个目录下，每个项目一个子目录。</p>
			<input
				className="mb-3 w-full rounded border px-3 py-2 font-mono text-sm"
				value={root}
				onChange={(e) => setRoot(e.target.value)}
			/>
			<ErrorBox error={error} />
			<button
				className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
				disabled={busy || !root.trim()}
				onClick={submit}
			>
				{busy ? "保存中…" : "确认记忆库位置"}
			</button>
		</Layout>
	);
}

function ProjectsPage({ projects, reload }: { projects: LibraryProject[]; reload: () => void }) {
	const [name, setName] = useState("");
	const [workingDir, setWorkingDir] = useState("");
	const [error, setError] = useState<unknown>(null);
	const navigate = useNavigate();
	const create = async () => {
		setError(null);
		try {
			const project = await api.createProject(name, workingDir.trim() || undefined);
			setName("");
			setWorkingDir("");
			reload();
			navigate(`/projects/${project.id}`);
		} catch (e) {
			setError(e);
		}
	};
	return (
		<Layout>
			<h1 className="mb-4 text-xl font-semibold">项目</h1>
			{projects.length === 0 ? (
				<p className="mb-4 text-sm text-gray-500">还没有项目。创建第一个项目开始使用。</p>
			) : (
				<ul className="mb-6 divide-y rounded border bg-white">
					{projects.map((p) => (
						<li key={p.id}>
							<Link to={`/projects/${p.id}`} className="block px-4 py-3 hover:bg-gray-50">
								<div className="font-medium">{p.name}</div>
								<div className="text-xs text-gray-500">
									{p.dir}
									{p.workingDir ? ` · 工作目录 ${p.workingDir}` : ""}
								</div>
							</Link>
						</li>
					))}
				</ul>
			)}
			<div className="rounded border bg-white p-4">
				<h2 className="mb-3 text-sm font-semibold">新建项目</h2>
				<input
					className="mb-2 w-full rounded border px-3 py-2 text-sm"
					placeholder="项目名称（如：订单系统）"
					value={name}
					onChange={(e) => setName(e.target.value)}
				/>
				<input
					className="mb-3 w-full rounded border px-3 py-2 font-mono text-sm"
					placeholder="关联工作目录（可选）"
					value={workingDir}
					onChange={(e) => setWorkingDir(e.target.value)}
				/>
				<ErrorBox error={error} />
				<button
					className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
					disabled={!name.trim()}
					onClick={create}
				>
					创建项目
				</button>
			</div>
		</Layout>
	);
}

const FIELD_LABELS: Record<string, string> = {
	title: "标题",
	status: "状态",
	description: "描述",
	goal: "目标",
	current: "当前进展",
	name: "名称",
};

function actorLabel(actor: HistoryEntry["actor"]): string {
	if (actor.type === "user") return "用户";
	return actor.client === "claude-code" ? "Claude Code" : actor.client === "codex" ? "Codex" : actor.client;
}

function targetLabel(entry: HistoryEntry): string {
	if (entry.target.type === "project") return "项目";
	if (entry.target.type === "overview") return "概览";
	return entry.target.id ?? "任务";
}

function HistorySection({ entries }: { entries: HistoryEntry[] }) {
	return (
		<section className="mt-4 rounded border bg-white p-4">
			<h2 className="mb-3 text-sm font-semibold">变更记录</h2>
			{entries.length === 0 ? (
				<p className="text-sm text-gray-400">暂无记录</p>
			) : (
				<ul className="divide-y text-sm">
					{[...entries].reverse().map((e, i) => (
						<li key={i} className="py-2">
							<span className="mr-2 font-mono text-xs text-gray-400">{new Date(e.ts).toLocaleString()}</span>
							<span className="mr-2 font-medium">{actorLabel(e.actor)}</span>
							<span className="mr-2 text-gray-500">
								{e.action === "create" ? "创建" : "更新"}
								{targetLabel(e)}
								{e.target.title ? `「${e.target.title}」` : ""}
							</span>
							<span className="block pl-4 text-xs text-gray-500">
								{Object.entries(e.changes).map(([field, c]) => (
									<span key={field} className="mr-3">
										{FIELD_LABELS[field] ?? field}: {c.from ?? "—"} → {c.to ?? "—"}
									</span>
								))}
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

function ProjectPage({ projects }: { projects: LibraryProject[] }) {
	const { id } = useParams();
	const project = projects.find((p) => p.id === id);
	const [overview, setOverview] = useState({ description: "", goal: "", current: "", version: "" });
	const [tasks, setTasks] = useState<Task[]>([]);
	const [history, setHistory] = useState<HistoryEntry[]>([]);
	const [newTask, setNewTask] = useState("");
	const [error, setError] = useState<unknown>(null);
	const [saved, setSaved] = useState(false);

	const load = useCallback(async () => {
		if (!id) return;
		const [ov, ts, hs] = await Promise.all([api.getOverview(id), api.listTasks(id), api.history(id)]);
		setOverview(ov);
		setTasks(ts);
		setHistory(hs);
	}, [id]);
	useEffect(() => {
		load().catch(setError);
	}, [load]);

	/** A VERSION_CONFLICT means someone else wrote first — show it and reload the latest values. */
	const onError = async (e: unknown) => {
		setError(e);
		if (e instanceof ApiError && e.code === "VERSION_CONFLICT") {
			await load().catch(() => {});
		}
	};

	const saveOverview = async () => {
		setError(null);
		setSaved(false);
		try {
			setOverview(await api.putOverview(id!, overview, overview.version));
			setSaved(true);
			await load();
		} catch (e) {
			await onError(e);
		}
	};
	const addTask = async () => {
		setError(null);
		try {
			await api.createTask(id!, newTask);
			setNewTask("");
			await load();
		} catch (e) {
			await onError(e);
		}
	};
	const advance = async (task: Task) => {
		const idx = STATUSES.indexOf(task.status);
		const next = STATUSES[Math.min(idx + 1, STATUSES.length - 1)];
		setError(null);
		try {
			await api.updateTask(id!, task.id, { status: next }, task.version ?? "");
			await load();
		} catch (e) {
			await onError(e);
		}
	};

	return (
		<Layout>
			<h1 className="mb-1 text-xl font-semibold">{project?.name ?? id}</h1>
			<p className="mb-4 font-mono text-xs text-gray-500">{project?.dir}</p>
			<ErrorBox error={error} />

			<section className="mt-4 rounded border bg-white p-4">
				<div className="mb-3 flex items-center justify-between">
					<h2 className="text-sm font-semibold">项目概览</h2>
					<button className="rounded bg-blue-600 px-3 py-1 text-xs text-white" onClick={saveOverview}>
						{saved ? "已保存 ✓" : "保存概览"}
					</button>
				</div>
				{(
					[
						["description", "这是什么"],
						["goal", "目标"],
						["current", "当前进展"],
					] as const
				).map(([key, label]) => (
					<label key={key} className="mb-3 block text-sm">
						<span className="mb-1 block text-gray-600">{label}</span>
						<textarea
							className="w-full rounded border px-3 py-2 text-sm"
							rows={2}
							value={overview[key]}
							onChange={(e) => setOverview((o) => ({ ...o, [key]: e.target.value }))}
						/>
					</label>
				))}
			</section>

			<section className="mt-4 rounded border bg-white p-4">
				<h2 className="mb-3 text-sm font-semibold">任务</h2>
				<ul className="mb-3 divide-y">
					{tasks.map((t) => (
						<li key={t.id} className="flex items-center justify-between py-2 text-sm">
							<span>
								<span className="mr-2 font-mono text-xs text-gray-400">{t.id}</span>
								{t.title}
							</span>
							<span className="flex items-center gap-2">
								<span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{t.status}</span>
								{t.status !== "Done" && (
									<button className="text-xs text-blue-600" onClick={() => advance(t)}>
										推进 →
									</button>
								)}
							</span>
						</li>
					))}
					{tasks.length === 0 && <li className="py-2 text-sm text-gray-400">暂无任务</li>}
				</ul>
				<div className="flex gap-2">
					<input
						className="flex-1 rounded border px-3 py-1.5 text-sm"
						placeholder="新任务标题"
						value={newTask}
						onChange={(e) => setNewTask(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && newTask.trim() && addTask()}
					/>
					<button
						className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
						disabled={!newTask.trim()}
						onClick={addTask}
					>
						添加
					</button>
				</div>
			</section>

			<HistorySection entries={history} />
		</Layout>
	);
}

function clientConfigJson(client: ClientSlotInfo): string {
	return JSON.stringify(
		{
			mcpServers: {
				"memory-master": {
					command: "memaster",
					args: ["bridge"],
					env: {
						MEMORY_MASTER_URL: window.location.origin,
						MEMORY_MASTER_TOKEN: client.token,
					},
				},
			},
		},
		null,
		2,
	);
}

function SettingsPage({ libraryRoot, reload }: { libraryRoot: string; reload: () => void }) {
	const [root, setRoot] = useState(libraryRoot);
	const [clients, setClients] = useState<ClientSlotInfo[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [notice, setNotice] = useState("");
	useEffect(() => setRoot(libraryRoot), [libraryRoot]);
	useEffect(() => {
		api.listClients().then(setClients).catch(setError);
	}, []);

	const saveRoot = async () => {
		setError(null);
		try {
			await api.setLibrary(root);
			reload();
		} catch (e) {
			setError(e);
		}
	};
	const toggle = async (client: ClientSlotInfo, enabled: boolean) => {
		setError(null);
		setNotice("");
		try {
			const updated = await api.setClient(client.id, enabled);
			setClients((list) => list.map((c) => (c.id === client.id ? updated : c)));
			setNotice(enabled ? `${client.label} 已启用` : `${client.label} 已停用 —— 即刻起其请求全部拒绝`);
		} catch (e) {
			setError(e);
		}
	};

	return (
		<Layout>
			<h1 className="mb-4 text-xl font-semibold">设置</h1>
			<ErrorBox error={error} />
			{notice && <div className="mt-2 rounded bg-green-50 px-3 py-2 text-sm text-green-700">{notice}</div>}

			<section className="mt-4 rounded border bg-white p-4">
				<h2 className="mb-3 text-sm font-semibold">记忆库位置</h2>
				<input
					className="mb-3 w-full rounded border px-3 py-2 font-mono text-sm"
					value={root}
					onChange={(e) => setRoot(e.target.value)}
				/>
				<button
					className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
					disabled={!root.trim() || root === libraryRoot}
					onClick={saveRoot}
				>
					保存
				</button>
			</section>

			<section className="mt-4 rounded border bg-white p-4">
				<h2 className="mb-1 text-sm font-semibold">客户端授权</h2>
				<p className="mb-3 text-xs text-gray-500">
					关闭后对应客户端的读、写、列项目请求即刻全部被拒。凭据用于 `memaster connect` 生成的 MCP 配置。
				</p>
				<ul className="divide-y">
					{clients.map((c) => (
						<li key={c.id} className="py-3">
							<div className="flex items-center justify-between">
								<div>
									<div className="text-sm font-medium">{c.label}</div>
									<div className="font-mono text-xs text-gray-400">{c.token ?? "启用后生成凭据"}</div>
								</div>
								<button
									className={`rounded px-3 py-1 text-sm text-white ${c.enabled ? "bg-gray-500" : "bg-blue-600"}`}
									onClick={() => toggle(c, !c.enabled)}
								>
									{c.enabled ? "停用" : "启用"}
								</button>
							</div>
							{c.enabled && c.token && (
								<div className="mt-2 rounded bg-amber-50 px-3 py-2 text-xs">
									<p className="mb-1 text-amber-800">
										已授权 ≠ 已连接：把下面的配置写入 {c.label} 的 MCP 设置后客户端才能真正接入
										（也可运行 <code>memaster connect {c.id}</code> 获取）。
									</p>
									<pre className="overflow-x-auto rounded bg-white p-2 font-mono text-[11px] leading-relaxed">
										{clientConfigJson(c)}
									</pre>
									<button
										className="mt-1 text-blue-600 underline"
										onClick={() => navigator.clipboard.writeText(clientConfigJson(c))}
									>
										复制配置
									</button>
								</div>
							)}
						</li>
					))}
				</ul>
			</section>
		</Layout>
	);
}

/** Entry gate: the service only authorizes web calls holding the per-start session key. */
function KeyPage({ error, onSubmit }: { error: string | null; onSubmit: (key: string) => void }) {
	const [input, setInput] = useState("");
	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50">
			<div className="w-full max-w-md rounded border bg-white p-6">
				<h1 className="mb-2 text-xl font-semibold">输入访问密钥</h1>
				<p className="mb-4 text-sm text-gray-600">
					启动 <code>memaster serve</code> 的终端里打印了带密钥的访问地址（
					<code>http://127.0.0.1:端口/?k=…</code>）。把完整地址或密钥粘贴到下面。
				</p>
				<input
					className="mb-3 w-full rounded border px-3 py-2 font-mono text-sm"
					placeholder="mm_web_… 或完整 ?k= 地址"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && input.trim() && onSubmit(input)}
				/>
				<ErrorBox error={error} />
				<button
					className="mt-3 rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
					disabled={!input.trim()}
					onClick={() => onSubmit(input)}
				>
					进入
				</button>
			</div>
		</div>
	);
}

export default function App() {
	const [authed, setAuthed] = useState(hasWebKey());
	const [keyError, setKeyError] = useState<string | null>(null);
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
		setOnUnauthorized(() => {
			setAuthed(false);
			setKeyError("密钥已失效——服务重启后会生成新密钥，请从终端输出重新复制访问地址。");
		});
		return () => setOnUnauthorized(null);
	}, []);
	useEffect(() => {
		if (!authed) return;
		load().catch((e) =>
			setState((s) => ({
				...s,
				loaded: true,
				error: e instanceof Error ? e.message : String(e),
			})),
		);
	}, [load, authed]);

	if (!authed) {
		return (
			<KeyPage
				error={keyError}
				onSubmit={(key) => {
					setWebKey(key);
					setKeyError(null);
					setState((s) => ({ ...s, loaded: false }));
					setAuthed(true);
				}}
			/>
		);
	}
	if (!state.loaded) return <div className="p-8 text-sm text-gray-500">加载中…</div>;
	if (state.error) {
		return (
			<div className="p-8 text-sm text-red-600">
				无法连接 Memory Master 服务：{state.error}
				<button className="ml-3 text-blue-600 underline" onClick={() => load().catch(() => {})}>
					重试
				</button>
			</div>
		);
	}
	if (!state.libraryRoot) {
		return (
			<BrowserRouter>
				<SetupPage defaultRoot={state.defaultLibraryRoot} onDone={load} />
			</BrowserRouter>
		);
	}
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/" element={<ProjectsPage projects={state.projects} reload={load} />} />
				<Route path="/projects/:id" element={<ProjectPage projects={state.projects} />} />
				<Route path="/settings" element={<SettingsPage libraryRoot={state.libraryRoot} reload={load} />} />
			</Routes>
		</BrowserRouter>
	);
}
