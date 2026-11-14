import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ClientSlotInfo } from "../api.ts";
import PermissionSwitch from "../components/PermissionSwitch.tsx";
import { PageHeader } from "../components/AppShell.tsx";
import { ErrorNote, SuccessNote } from "../components/StatusMessage.tsx";

const CONNECTION_TEXT: Record<ClientSlotInfo["connection"], { text: string; cls: string }> = {
	none: { text: "未配置", cls: "text-[#595F59]" },
	configured: { text: "已配置，等待接入", cls: "text-[#805719]" },
	connected: { text: "已接入", cls: "text-[#216C45]" },
};

export default function SettingsPage({ libraryRoot, reload }: { libraryRoot: string; reload: () => void }) {
	const [root, setRoot] = useState(libraryRoot);
	const [clients, setClients] = useState<ClientSlotInfo[]>([]);
	const [error, setError] = useState<unknown>(null);
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [detailsOpen, setDetailsOpen] = useState(false);
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
		setBusy(client.id);
		try {
			const updated = await api.setClient(client.id, enabled);
			setClients((list) => list.map((c) => (c.id === client.id ? { ...c, ...updated } : c)));
			setNotice(
				enabled
					? `${client.label} 已允许连接。打开 ${client.label} 的新会话即可接入。`
					: `${client.label} 已停用 —— 即刻起其请求全部拒绝`,
			);
			await api
				.listClients()
				.then(setClients)
				.catch(() => {});
		} catch (e) {
			// A failed enable arrives as a 502 body — refresh the slot so its
			// installError/retry state shows.
			setError(e);
			await api
				.listClients()
				.then(setClients)
				.catch(() => {});
		} finally {
			setBusy(null);
		}
	};

	const changeDefaultWrite = async (client: ClientSlotInfo, allowWrite: boolean) => {
		setError(null);
		setNotice("");
		setBusy(client.id);
		try {
			const updated = await api.setClientDefaultWrite(client.id, allowWrite);
			setClients((list) => list.map((c) => (c.id === client.id ? { ...c, allowWrite: updated.allowWrite } : c)));
			setNotice(allowWrite ? `${client.label} 默认可以修改项目` : `${client.label} 默认只能读取项目`);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="min-h-screen bg-[#F7F7F4] text-[#242724]">
			<main className="mx-auto max-w-[960px] px-4 py-6 min-[640px]:px-6 min-[960px]:px-8 min-[960px]:py-8 min-[1200px]:px-10">
				<p className="mb-2">
					<Link to="/" className="text-[15px] font-medium leading-6 text-[#315DAD]">
						← 所有项目
					</Link>
				</p>
				<PageHeader
					title="全局设置"
					actions={
						<button
							type="button"
							className="h-10 rounded-lg border border-[#A8AEA4]/40 px-4 text-[15px] font-medium text-[#242724]"
							disabled={busy !== null}
							onClick={() => api.listClients().then(setClients).catch(setError)}
						>
							刷新状态
						</button>
					}
				/>
				<ErrorNote error={error} className="mb-4" />
				{notice ? (
					<div className="mb-4">
						<SuccessNote>{notice}</SuccessNote>
					</div>
				) : null}

				<section className="mb-10">
					<h2 className="mb-1 text-[20px] font-semibold leading-7">Agent连接</h2>
					<p className="mb-4 max-w-[720px] text-[15px] leading-6 text-[#595F59]">
						允许连接后，Agent
						可以读取对它开放的项目。关闭连接后，所有项目都不再对它开放。项目设置可以单独关闭连接，也可以调整该项目是否允许修改。
					</p>
					<ul>
						{clients.map((c) => {
							const conn = CONNECTION_TEXT[c.connection];
							return (
								<li key={c.id} className="border-b border-[#DDDFD9] py-4 last:border-b-0">
									<div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-5">
										<div className="min-w-0 max-w-[720px]">
											<p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[16px] font-medium leading-6">
												{c.label}
												{c.enabled ? (
													<span className={`text-[14px] font-normal leading-[22px] ${conn.cls}`}>{conn.text}</span>
												) : (
													<span className="text-[14px] font-normal leading-[22px] text-[#595F59]">已停用</span>
												)}
											</p>
											{c.enabled && c.connection === "configured" ? (
												<p className="mt-1 text-[14px] leading-[22px] text-[#595F59]">
													配置文件已写入。打开 {c.label}（新会话）后它会自动接入；若一直停留在此状态，检查该客户端的 MCP
													服务列表里 memory-master 是否报错。
												</p>
											) : null}
											{!c.detected ? (
												<p className="mt-1 text-[14px] leading-[22px] text-[#805719]">
													本机未检测到 {c.label} 的配置目录或程序 —— 安装后再启用。
												</p>
											) : null}
											{c.installError ? (
												<div className="mt-2">
													<ErrorNote error={`自动配置未完成：${c.installError}`} onRetry={() => void toggle(c, true)} />
												</div>
											) : null}
										</div>
										<div className="flex flex-wrap items-center gap-x-6 gap-y-3">
											<div className="flex items-center gap-2 text-[15px]">
												<span>允许连接</span>
												<PermissionSwitch
													checked={c.enabled}
													disabled={busy !== null}
													label={`${c.label} 允许连接`}
													onChange={(next) => void toggle(c, next)}
												/>
											</div>
											<div className="flex items-center gap-2 text-[15px]">
												<span>默认允许修改</span>
												<PermissionSwitch
													checked={c.allowWrite}
													disabled={busy !== null || !c.enabled}
													label={`${c.label} 默认允许修改`}
													onChange={(next) => void changeDefaultWrite(c, next)}
												/>
											</div>
										</div>
									</div>
									{busy === c.id ? <p className="mt-1 text-[14px] leading-[22px] text-[#595F59]">保存中…</p> : null}
								</li>
							);
						})}
					</ul>
				</section>

				<section className="mb-10">
					<h2 className="mb-1 text-[20px] font-semibold leading-7">保存位置</h2>
					<p className="mb-3 max-w-[720px] text-[15px] leading-6 text-[#595F59]">
						这里切换的是查看的记忆库；原目录文件保留，不做后台迁移。
					</p>
					<input
						className="mb-3 h-10 w-full max-w-[720px] rounded-lg border border-[#A8AEA4]/50 bg-white px-3 font-mono text-[13px] leading-5 focus:border-[#315DAD] focus:outline-none"
						aria-label="记忆库位置"
						value={root}
						onChange={(e) => setRoot(e.target.value)}
					/>
					<div>
						<button
							type="button"
							className="h-10 rounded-lg bg-[#2F3530] px-4 text-[15px] font-medium text-white disabled:opacity-50"
							disabled={!root.trim() || root === libraryRoot}
							onClick={() => void saveRoot()}
						>
							更改位置
						</button>
					</div>
				</section>

				<section className="mb-10">
					<button
						type="button"
						className="text-[15px] font-medium leading-6 text-[#315DAD]"
						aria-expanded={detailsOpen}
						onClick={() => setDetailsOpen((o) => !o)}
					>
						技术详情 {detailsOpen ? "收起" : "展开"}
					</button>
					{detailsOpen ? (
						<div className="mt-3 max-w-[820px] rounded-lg border border-[#DDDFD9] bg-white p-4">
							{clients.map((c) => (
								<div key={c.id} className="mb-4 last:mb-0">
									<p className="text-[14px] font-medium leading-[22px]">{c.label}</p>
									<p className="break-all font-mono text-[13px] leading-5 text-[#595F59]">
										凭据：{c.token ?? "启用后生成"}
									</p>
									{c.lastSeenAt ? (
										<p className="font-mono text-[13px] leading-5 text-[#595F59]">
											最近接入：{new Date(c.lastSeenAt).toLocaleString()}
										</p>
									) : null}
									{c.installError ? (
										<p className="mt-1 break-all font-mono text-[13px] leading-5 text-[#A6312B]">{c.installError}</p>
									) : null}
									{c.installed && c.installed.length > 0 ? (
										<p className="mt-1 font-mono text-[13px] leading-5 text-[#595F59]">
											安装位置：{c.installed.join("、")}
										</p>
									) : null}
								</div>
							))}
							{clients.length === 0 ? (
								<p className="text-[14px] leading-[22px] text-[#595F59]">暂无客户端信息</p>
							) : null}
						</div>
					) : null}
				</section>
			</main>
		</div>
	);
}
