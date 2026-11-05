/**
 * 项目内编辑草稿与选中态的会话级存取。键为 `${projectId}:${which}`——概览、
 * 项目架构的未保存修改在页面间切换时保留，选中态（sel:task / sel:node）让
 * 返回页面时恢复展开的任务说明或结构节点。只活在内存里，不写 localStorage。
 */
const drafts = new Map<string, string>();

function key(projectId: string, which: string): string {
	return `${projectId}:${which}`;
}

export function getDraft(projectId: string, which: string): string | undefined {
	return drafts.get(key(projectId, which));
}

export function setDraft(projectId: string, which: string, value: string): void {
	drafts.set(key(projectId, which), value);
}

export function clearDraft(projectId: string, which: string): void {
	drafts.delete(key(projectId, which));
}
