import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ProjectAgentAccess } from "../api.ts";
import { PageHeader, useProject } from "../components/AppShell.tsx";
import PermissionSwitch from "../components/PermissionSwitch.tsx";
import { ErrorNote, LoadingNote } from "../components/StatusMessage.tsx";

export default function ProjectSettingsPage() {
	const project = useProject();
	return <AgentAccess key={project.id} projectId={project.id} name={project.name} />;
}

function AgentAccess({ projectId, name }: { projectId: string; name: string }) {
	const [clients, setClients] = useState<ProjectAgentAccess[] | null>(null);
	const [error, setError] = useState<unknown>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState("");
	const [retry, setRetry] = useState(0);

	useEffect(() => {
		let active = true;
		api.listProjectAgentAccess(projectId).then(
			(result) => {
				if (active) setClients(result);
			},
			(reason) => {
				if (active) setError(reason);
			},
		);
		return () => {
			active = false;
		};
	}, [projectId, retry]);

	async function save(
		client: ProjectAgentAccess,
		patch: { allowConnection?: boolean | null; allowWrite?: boolean | null },
	) {
		setBusy(client.id);
		setError(null);
		setNotice("");
		try {
			const updated = await api.setProjectAgentAccess(projectId, client.id, patch);
			setClients((list) => list?.map((c) => (c.id === updated.id ? updated : c)) ?? null);
			setNotice(updated.label + " 的项目权限已保存");
		} catch (reason) {
			setError(reason);
		} finally {
			setBusy(null);
		}
	}

	return (
		<>
			<PageHeader title="项目设置" />
			<section aria-label="Agent 权限" className="max-w-[900px]">
				<h2 className="mb-1 text-[20px] font-semibold leading-7">Agent 权限</h2>
				<p className="mb-4 text-[15px] leading-6 text-[#555B65]">
					为「{name}」设置例外。未单独调整的权限跟随
					<Link to="/settings" className="text-[#3B57D0] underline">
						全局设置
					</Link>
					。 允许连接即可读取；打开「允许修改」后，Agent 才能更新这个项目。
				</p>
				<ErrorNote
					error={error}
					className="mb-4"
					onRetry={
						clients
							? undefined
							: () => {
									setError(null);
									setRetry((n) => n + 1);
								}
					}
				/>
				<p role="status" className="mb-2 text-[14px] leading-6 text-[#216C45] empty:hidden">
					{notice}
				</p>
				{clients ? (
					<ul className="divide-y divide-[#E5E7EB]">
						{clients.map((client) => {
							const { override } = client;
							const hasOverride = override.allowConnection !== undefined || override.allowWrite !== undefined;
							const status = !client.globallyEnabled
								? "全局连接已关闭"
								: !client.canRead
									? "此项目未开放"
									: client.canWrite
										? "可以读取和修改"
										: "只读";
							return (
								<li key={client.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 py-4">
									<div>
										<p className="text-[16px] font-medium">{client.label}</p>
										<p className="text-[14px] leading-6 text-[#555B65]">{status}</p>
									</div>
									<div className="flex flex-wrap items-start gap-x-6 gap-y-3">
										<div>
											<div className="flex items-center gap-2 text-[15px]">
												<span>允许连接</span>
												<PermissionSwitch
													checked={client.canRead}
													disabled={busy !== null || !client.globallyEnabled}
													label={client.label + " 允许连接"}
													onChange={(next) => void save(client, { allowConnection: next })}
												/>
											</div>
											<p className="text-[13px] leading-6 text-[#555B65]">
												{override.allowConnection === undefined ? "继承全局" : "单独设置"}
											</p>
										</div>
										<div>
											<div className="flex items-center gap-2 text-[15px]">
												<span>允许修改</span>
												<PermissionSwitch
													checked={client.canWrite}
													disabled={busy !== null || !client.canRead}
													label={client.label + " 允许修改"}
													onChange={(next) => void save(client, { allowWrite: next })}
												/>
											</div>
											<p className="text-[13px] leading-6 text-[#555B65]">
												{override.allowWrite === undefined ? "继承全局" : "单独设置"}
											</p>
										</div>
										{hasOverride ? (
											<button
												type="button"
												disabled={busy !== null}
												aria-label={client.label + " 恢复继承"}
												onClick={() => void save(client, { allowConnection: null, allowWrite: null })}
												className="min-h-7 text-[14px] font-medium text-[#3B57D0] hover:underline disabled:opacity-50"
											>
												恢复继承
											</button>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				) : error ? null : (
					<LoadingNote />
				)}
			</section>
		</>
	);
}
