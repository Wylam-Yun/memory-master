import { describe, expect, test } from "bun:test";
import type { HistoryEntry } from "../library-web/api.ts";
import {
	extractMermaidNodeId,
	groupHistoryByDay,
	isDoneStatus,
	isP0Task,
	parseCompositionTable,
} from "../library-web/utils.ts";

/** V1.1 五页前端的纯函数契约：P0 判定、历史按日分组、组成表解析。 */

describe("isP0Task", () => {
	test("未填优先级的旧任务按 P0 展示", () => {
		expect(isP0Task({ priority: undefined }, "p0")).toBe(true);
		expect(isP0Task({ priority: "" }, "p0")).toBe(true);
	});
	test("匹配 p0 值的显示，其余值不显示", () => {
		expect(isP0Task({ priority: "p0" }, "p0")).toBe(true);
		expect(isP0Task({ priority: "p1" }, "p0")).toBe(false);
		expect(isP0Task({ priority: "high" }, "p0")).toBe(false);
		// 手改文件可能留下未归一化的值——显示判定与服务端 normalize 语义一致。
		expect(isP0Task({ priority: "P0" }, "p0")).toBe(true);
		expect(isP0Task({ priority: " p0 " }, "p0")).toBe(true);
	});
});

describe("isDoneStatus", () => {
	test("匹配配置的完成状态（忽略大小写与首尾空白）", () => {
		expect(isDoneStatus("Done", "Done")).toBe(true);
		expect(isDoneStatus("done", "Done")).toBe(true);
		expect(isDoneStatus(" Done ", "Done")).toBe(true);
		expect(isDoneStatus("In Progress", "Done")).toBe(false);
	});
	test("doneStatus 缺失时不算完成", () => {
		expect(isDoneStatus("Done", null)).toBe(false);
	});
});

const entry = (ts: string, title = "t"): HistoryEntry => ({
	ts,
	actor: { type: "user" },
	target: { type: "task", id: "TASK-1", title },
	action: "update",
	changes: {},
	version: "v",
});

describe("groupHistoryByDay", () => {
	// 固定「现在」为 2026-11-05 14:00 本地时间，断言只依赖相对边界。
	const now = new Date(2026, 10, 5, 14, 0, 0);

	test("按本地日分组成 今天/昨天/具体日期，组内与组间均最新在前", () => {
		const groups = groupHistoryByDay(
			[
				entry(new Date(2026, 10, 5, 9, 0).toISOString(), "今天早"),
				entry(new Date(2026, 10, 4, 23, 59).toISOString(), "昨天晚"),
				entry(new Date(2026, 10, 5, 13, 30).toISOString(), "今天午"),
				entry(new Date(2026, 9, 30, 8, 0).toISOString(), "更早"),
			],
			now,
		);
		expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "2026-10-30"]);
		expect(groups[0]?.entries.map((e) => e.target.title)).toEqual(["今天午", "今天早"]);
		expect(groups[1]?.entries).toHaveLength(1);
	});

	test("跨日边界：23:59 归昨天，00:01 归今天", () => {
		const boundaryNow = new Date(2026, 10, 5, 0, 30, 0);
		const groups = groupHistoryByDay(
			[entry(new Date(2026, 10, 4, 23, 59).toISOString()), entry(new Date(2026, 10, 5, 0, 1).toISOString())],
			boundaryNow,
		);
		expect(groups.map((g) => g.label)).toEqual(["今天", "昨天"]);
	});

	test("空输入返回空数组", () => {
		expect(groupHistoryByDay([], now)).toEqual([]);
	});
});

const ARCH_MD = `# 项目架构

说明文字。

\`\`\`mermaid
flowchart LR
  signup[报名] --> venue[场地]
\`\`\`

| 组成 ID | 名称 | 说明 | 来源（可选） | 关联任务 |
| --- | --- | --- | --- | --- |
| signup | 报名安排 | 明确参与者与人数 | 用户确认 | TASK-1, TASK-2 |
| venue | 场地准备 | 确认空间与时间 |  |  |

| 名称 | 说明 |
| --- | --- |
| 第二张表 | 不应出现 |
`;

describe("parseCompositionTable", () => {
	test("解析第一个含「名称」「说明」表头的表，列按表头文字定位", () => {
		const rows = parseCompositionTable(ARCH_MD);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({
			id: "signup",
			name: "报名安排",
			description: "明确参与者与人数",
			source: "用户确认",
			tasks: ["TASK-1", "TASK-2"],
		});
		expect(rows[1]?.source).toBe("");
		expect(rows[1]?.tasks).toEqual([]);
	});

	test("找不到组成表返回空（不渲染交互区）", () => {
		expect(parseCompositionTable("# 只有标题\n\n普通段落。")).toEqual([]);
		expect(parseCompositionTable("| 其他 | 列 |\n| --- | --- |\n| a | b |")).toEqual([]);
	});

	test("缺可选列给空值", () => {
		const rows = parseCompositionTable("| 名称 | 说明 |\n| --- | --- |\n| 甲 | 说明甲 |");
		expect(rows).toEqual([{ id: "", name: "甲", description: "说明甲", source: "", tasks: [] }]);
	});

	test("围栏代码块里的表不参与解析", () => {
		const md = "```\n| 名称 | 说明 |\n| --- | --- |\n| 假 | 表 |\n```\n\n正文";
		expect(parseCompositionTable(md)).toEqual([]);
	});

	test("表体在非表格行处结束", () => {
		const md = "| 名称 | 说明 |\n| --- | --- |\n| 甲 | 一 |\n\n| 乙 | 二 |\n";
		// 第二行 |乙| 紧跟空行后的行仍算表体延续？——空行截断表格。
		expect(parseCompositionTable(md)).toEqual([{ id: "", name: "甲", description: "一", source: "", tasks: [] }]);
	});
});

describe("extractMermaidNodeId", () => {
	test("剥掉 flowchart- 前缀与序号后缀", () => {
		expect(extractMermaidNodeId("flowchart-signup-0")).toBe("signup");
		expect(extractMermaidNodeId("flowchart-my_node-12")).toBe("my_node");
	});
	test("不匹配返回 null", () => {
		expect(extractMermaidNodeId("some-other-id")).toBeNull();
	});
});
