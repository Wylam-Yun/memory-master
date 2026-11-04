import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../markdown/frontmatter.ts";
import type { Actor } from "./history.ts";

/**
 * 待决定事项 (pending questions): judgment calls an agent raises in the project
 * when it needs the user to decide. Each is a markdown record in
 * `memaster/questions/` — frontmatter carries state, the body carries detail.
 * Answers arrive either via the web page (actor=user) or recorded by an agent
 * after the user answers in its dialog. Same version/history rules as tasks.
 */

export const QUESTION_DIR = "questions";

export type QuestionStatus = "Open" | "Answered";

export interface ProjectQuestion {
	id: string;
	title: string;
	status: QuestionStatus;
	/** Optional linked task ID. */
	task?: string;
	askedBy: string;
	askedAt: string;
	answer?: string;
	answeredBy?: string;
	answeredAt?: string;
	/** Free-form question detail (markdown body). */
	detail?: string;
	filePath?: string;
}

export function questionsDir(projectDir: string): string {
	return join(projectDir, "memaster", QUESTION_DIR);
}

function slugify(title: string): string {
	const slug = title
		.trim()
		.replace(/[\\/:*?"<>|\s]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50);
	return slug || "question";
}

function render(q: ProjectQuestion): string {
	const fm: Record<string, string> = {
		id: q.id,
		title: q.title.replace(/"/g, '\\"'),
		status: q.status,
		...(q.task ? { task: q.task } : {}),
		asked_by: q.askedBy,
		asked_date: q.askedAt,
		...(q.answer !== undefined ? { answer: q.answer.replace(/"/g, '\\"') } : {}),
		...(q.answeredBy ? { answered_by: q.answeredBy } : {}),
		...(q.answeredAt ? { answered_date: q.answeredAt } : {}),
	};
	const yaml = Object.entries(fm)
		.map(([k, v]) => `${k}: "${v}"`)
		.join("\n");
	return `---\n${yaml}\n---\n\n${q.detail?.trim() ?? ""}\n`;
}

function parseQuestion(content: string, filePath: string): ProjectQuestion | null {
	try {
		const { data, content: body } = parseFrontmatter(content);
		if (typeof data.id !== "string" || typeof data.title !== "string") return null;
		const status = data.status === "Answered" ? "Answered" : "Open";
		return {
			id: data.id,
			title: data.title,
			status,
			...(typeof data.task === "string" ? { task: data.task } : {}),
			askedBy: typeof data.asked_by === "string" ? data.asked_by : "unknown",
			askedAt: typeof data.asked_date === "string" ? data.asked_date : "",
			...(typeof data.answer === "string" ? { answer: data.answer } : {}),
			...(typeof data.answered_by === "string" ? { answeredBy: data.answered_by } : {}),
			...(typeof data.answered_date === "string" ? { answeredAt: data.answered_date } : {}),
			...(body.trim() ? { detail: body.trim() } : {}),
			filePath,
		};
	} catch {
		return null;
	}
}

/** Next QUESTION-N — called inside the project write lock, so allocation is serialized. */
export async function nextQuestionId(projectDir: string): Promise<string> {
	const dir = questionsDir(projectDir);
	let max = 0;
	try {
		for (const file of await readdir(dir)) {
			const m = /^question-(\d+)/i.exec(file);
			if (m?.[1]) max = Math.max(max, Number.parseInt(m[1], 10));
		}
	} catch {}
	return `QUESTION-${max + 1}`;
}

export async function createQuestion(
	projectDir: string,
	input: { title: string; task?: string; detail?: string },
	askedBy: string,
): Promise<ProjectQuestion> {
	const id = await nextQuestionId(projectDir);
	const question: ProjectQuestion = {
		id,
		title: input.title,
		status: "Open",
		...(input.task ? { task: input.task } : {}),
		askedBy,
		askedAt: new Date().toISOString(),
		...(input.detail ? { detail: input.detail } : {}),
	};
	const dir = questionsDir(projectDir);
	await mkdir(dir, { recursive: true });
	const filePath = join(dir, `${id.toLowerCase()} - ${slugify(input.title)}.md`);
	await Bun.write(filePath, render(question));
	return { ...question, filePath };
}

export async function listQuestions(projectDir: string, status?: QuestionStatus): Promise<ProjectQuestion[]> {
	const dir = questionsDir(projectDir);
	const out: ProjectQuestion[] = [];
	try {
		for (const file of await readdir(dir)) {
			if (!file.endsWith(".md")) continue;
			const filePath = join(dir, file);
			const q = parseQuestion(await Bun.file(filePath).text(), filePath);
			if (q && (!status || q.status === status)) out.push(q);
		}
	} catch {}
	return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

export async function getQuestion(projectDir: string, id: string): Promise<ProjectQuestion | null> {
	const normalized = id.toLowerCase();
	const all = await listQuestions(projectDir);
	return all.find((q) => q.id.toLowerCase() === normalized) ?? null;
}

/** Persist an answered state onto an existing question (same file, same name). */
export async function answerQuestion(
	question: ProjectQuestion,
	answer: string,
	answeredBy: Actor,
): Promise<ProjectQuestion> {
	const next: ProjectQuestion = {
		...question,
		status: "Answered",
		answer,
		answeredBy: answeredBy.type === "user" ? "user" : answeredBy.client,
		answeredAt: new Date().toISOString(),
	};
	if (!question.filePath) throw new Error("Question has no file path.");
	await Bun.write(question.filePath, render(next));
	return next;
}
