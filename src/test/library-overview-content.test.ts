import { expect, test } from "bun:test";
import { contentOutline, progressSections } from "../library-web/overview-content.ts";

test("目录只取真正的主要标题，重复标题稳定编号，代码与下级标题不冒充目录", () => {
	const source =
		"前言\n\n## 创建项目\n\n完整说明\n\n### 小步骤\n\n```md\n## 伪标题\n```\n\n## 创建项目\n\n第二项\n\n## Project / 文件\n\n第三项";
	const first = contentOutline(source);
	expect(first.map((x) => x.title)).toEqual(["创建项目", "创建项目", "Project / 文件"]);
	expect(new Set(first.map((x) => x.id)).size).toBe(3);
	expect(contentOutline(source)).toEqual(first);
	expect(first.every((x) => x.line > 0 && !/[\s<>]/.test(x.id))).toBe(true);
});

test("当前进展按实际四段分开，保留前言、未知内容、代码和引用定义", () => {
	const source =
		"必要背景。\n\n## 已完成\n\n已保存[材料][ref]。\n\n## 当前停点\n\n正在确认阅读效果。\n\n```md\n## 下一步\n这是一段示例代码\n```\n\n## 补充背景\n\n用户原有说明。\n\n## 未完成或未验证\n\n另一位Agent尚未实测。\n\n## 下一步\n\n先读材料。\n\n[ref]: https://example.com/material";
	const result = progressSections(source);
	expect(result.introduction).toBe("必要背景。");
	expect(result.sections.map((x) => x.title)).toEqual(["已完成", "当前停点", "未完成或未验证", "下一步"]);
	expect(result.sections[1]?.body).toContain("用户原有说明");
	expect(result.sections[1]?.body).toContain("这是一段示例代码");
	expect(result.sections[0]?.body).toContain("[材料][ref]");
	expect(result.definitions).toContain("[ref]: https://example.com/material");
});

test("旧文不猜状态、不删正文；空标题不生成空分区", () => {
	const old = "资料已准备，仍需用户确认，下一步整理反馈。";
	expect(progressSections(old)).toEqual({ introduction: old, sections: [], definitions: "" });
	const result = progressSections("## 已完成\n\n## 下一步\n\n核对资料入口。");
	expect(result.sections.map((x) => x.title)).toEqual(["下一步"]);
});

test("单个文档总标题保留在正文，目录指向其下真实章节", () => {
	expect(
		contentOutline("# 项目使用说明\n\n## 第一项\n内容\n\n## 第二项\n内容\n\n## 第三项\n内容").map((x) => x.title),
	).toEqual(["第一项", "第二项", "第三项"]);
});
