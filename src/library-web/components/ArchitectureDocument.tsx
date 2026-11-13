import { Link } from "react-router-dom";
import type { Task } from "../api.ts";
import { splitCompositionDocument } from "../utils.ts";
import Markdown from "./Markdown.tsx";
import { ErrorNote } from "./StatusMessage.tsx";

/** The saved composition table is presented once, in place, as readable responsibilities. */
export default function ArchitectureDocument({
	source,
	projectId,
	selectedId,
	tasks,
	p0TaskIds,
	onShowDetails,
	taskError,
}: {
	source: string;
	projectId: string;
	selectedId: string | null;
	tasks: Task[] | null;
	p0TaskIds: Set<string>;
	onShowDetails: () => void;
	taskError: unknown;
}) {
	const { before, rows, after } = splitCompositionDocument(source);
	return (
		<div className="architecture-document min-w-0 break-words text-[16px] leading-7">
			{before.trim() ? <Markdown source={before} /> : null}
			{rows.length > 0 ? (
				<section aria-label="各部分做什么" className="my-8 max-w-[820px]">
					<h2 className="mb-5 text-[18px] font-semibold leading-7 text-[#242724]">各部分做什么</h2>
					<ul className="divide-y divide-[#DDDFD9]">
						{rows.map((row, index) => (
							<li
								key={`${row.id || row.name}-${index}`}
								id={row.id ? `comp-${row.id}` : undefined}
								className={`scroll-mt-6 rounded-lg px-3 py-3 ${row.id && selectedId === row.id ? "bg-[#EDF0EA]" : ""}`}
							>
								<h3 className="mb-1 text-[17px] font-semibold leading-7 text-[#242724]">{row.name}</h3>
								<Markdown source={row.description} />
								{row.source || row.tasks.length > 0 ? (
									<details
										className="mt-2 text-[15px] leading-6"
										onToggle={(event) => {
											if (event.currentTarget.open && row.tasks.length > 0) onShowDetails();
										}}
									>
										<summary className="w-fit cursor-pointer font-medium text-[#315DAD]">补充信息</summary>
										{row.source ? <p className="mt-2">来源：{row.source}</p> : null}
										{row.tasks.length > 0 && taskError ? <ErrorNote error={taskError} onRetry={onShowDetails} /> : null}
										{row.tasks.length > 0 && tasks === null && !taskError ? (
											<p className="mt-2">正在读取关联任务…</p>
										) : null}
										{row.tasks
											.filter((id) => p0TaskIds.has(id))
											.map((id) => (
												<Link key={id} to={`/projects/${projectId}/tasks`} className="mt-2 block text-[#315DAD]">
													关联任务：{tasks?.find((task) => task.id === id)?.title ?? id}
												</Link>
											))}
									</details>
								) : null}
							</li>
						))}
					</ul>
				</section>
			) : null}
			{after.trim() ? <Markdown source={after} /> : null}
		</div>
	);
}
