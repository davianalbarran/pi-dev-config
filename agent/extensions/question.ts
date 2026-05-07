import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, Text, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as bridge from "./subagent/question-bridge.ts";

interface QuestionDef {
	id: string;
	label: string;
	question: string;
	options: string[];
	allowCustom: boolean;
}

interface AnswerDef {
	id: string;
	label: string;
	question: string;
	answer: string;
	wasCustom: boolean;
	selectedIndex?: number;
}

interface QuestionToolResult {
	questions: QuestionDef[];
	answers: AnswerDef[];
	cancelled: boolean;
}

const QuestionItemSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question id for result mapping." })),
	label: Type.Optional(Type.String({ description: "Short label shown in multi-question UI." })),
	question: Type.String({ description: "Question to ask user." }),
	options: Type.Array(Type.String(), { description: "Multiple-choice options for question." }),
	allowCustom: Type.Optional(Type.Boolean({ description: "If true, add custom text answer option." })),
});

const QuestionToolParamsSchema = Type.Object({
	question: Type.Optional(Type.String({ description: "Question to ask user for single-question calls. Use with options." })),
	options: Type.Optional(Type.Array(Type.String(), { description: "Multiple-choice options for a single-question call." })),
	allowCustom: Type.Optional(Type.Boolean({ description: "If true, add custom text answer option to a single-question call." })),
	questions: Type.Optional(Type.Array(QuestionItemSchema, { description: "Questions to ask in one combined flow.", minItems: 1 })),
});

function getCustomOptionLabel(options: string[]): string {
	const base = "Custom...";
	if (!options.includes(base)) return base;
	let i = 2;
	while (options.includes(`${base} (${i})`)) i++;
	return `${base} (${i})`;
}

function normalizeParams(params: any): QuestionDef[] {
	const rawQuestions = Array.isArray(params?.questions) && params.questions.length > 0
		? params.questions
		: typeof params?.question === "string"
			? [{ id: "q1", label: "Q1", question: params.question, options: params.options, allowCustom: params.allowCustom }]
			: [];
	const usedIds = new Set<string>();
	return rawQuestions.flatMap((question: any, index: number) => {
		if (!question || typeof question.question !== "string" || !question.question.trim() || !Array.isArray(question.options)) return [];
		const options = question.options.filter((option: unknown): option is string => typeof option === "string" && option.length > 0);
		if (options.length === 0) return [];
		const baseId = (question.id || `q${index + 1}`).trim() || `q${index + 1}`;
		let id = baseId;
		let suffix = 2;
		while (usedIds.has(id)) id = `${baseId}_${suffix++}`;
		usedIds.add(id);
		return [{
			id,
			label: (question.label || `Q${index + 1}`).trim() || `Q${index + 1}`,
			question: question.question.trim(),
			options,
			allowCustom: question.allowCustom === true,
		}];
	});
}

function formatAnswerSummary(questions: QuestionDef[], answers: AnswerDef[]): string {
	if (questions.length === 1 && answers.length === 1) return answers[0]!.answer;
	return answers
		.map((answer) => {
			const question = questions.find((item) => item.id === answer.id);
			const prefix = question ? `${question.label}: ` : "";
			if (answer.wasCustom) return `${prefix}${answer.answer}`;
			if (answer.selectedIndex) return `${prefix}${answer.selectedIndex}. ${answer.answer}`;
			return `${prefix}${answer.answer}`;
		})
		.join("\n");
}

function buildTextResult(details: QuestionToolResult) {
	if (details.cancelled) {
		return {
			content: [{ type: "text" as const, text: "User cancelled." }],
			details,
		};
	}
	return {
		content: [{ type: "text" as const, text: formatAnswerSummary(details.questions, details.answers) || "No answer provided." }],
		details,
	};
}

async function askOne(ctx: any, question: QuestionDef): Promise<AnswerDef | undefined> {
	const customOptionLabel = question.allowCustom ? getCustomOptionLabel(question.options) : undefined;
	const choices = customOptionLabel ? [...question.options, customOptionLabel] : [...question.options];
	const selected = await ctx.ui.select(question.question, choices);
	if (selected === undefined) return undefined;
	if (customOptionLabel && selected === customOptionLabel) {
		const custom = await ctx.ui.input(question.question, "Type custom answer");
		if (custom === undefined) return undefined;
		return {
			id: question.id,
			label: question.label,
			question: question.question,
			answer: custom,
			wasCustom: true,
		};
	}
	return {
		id: question.id,
		label: question.label,
		question: question.question,
		answer: selected,
		wasCustom: false,
		selectedIndex: question.options.indexOf(selected) + 1 || undefined,
	};
}

async function askSequential(ctx: any, questions: QuestionDef[]): Promise<QuestionToolResult> {
	const answers: AnswerDef[] = [];
	for (const question of questions) {
		const answer = await askOne(ctx, question);
		if (!answer) return { questions, answers, cancelled: true };
		answers.push(answer);
	}
	return { questions, answers, cancelled: false };
}

async function askCombined(ctx: any, questions: QuestionDef[]): Promise<QuestionToolResult | undefined> {
	const result = await ctx.ui.custom<QuestionToolResult | undefined>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, AnswerDef>();

		const editorTheme: EditorTheme = {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		};
		const editor = new Editor(tui, editorTheme);

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};

		const currentQuestion = () => questions[currentTab];
		const totalTabs = questions.length + 1;
		const allAnswered = () => questions.every((question) => answers.has(question.id));
		const currentOptions = () => {
			const question = currentQuestion();
			if (!question) return [] as { label: string; isOther?: boolean }[];
			const options = question.options.map((option) => ({ label: option }));
			if (question.allowCustom) options.push({ label: getCustomOptionLabel(question.options), isOther: true });
			return options;
		};
		const advanceAfterAnswer = () => {
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			optionIndex = 0;
			refresh();
		};
		const saveAnswer = (question: QuestionDef, answer: string, wasCustom: boolean, selectedIndex?: number) => {
			answers.set(question.id, {
				id: question.id,
				label: question.label,
				question: question.question,
				answer,
				wasCustom,
				selectedIndex,
			});
		};

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const question = questions.find((item) => item.id === inputQuestionId);
			if (!question) return;
			const trimmed = value.trim();
			if (!trimmed) return;
			saveAnswer(question, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		const handleInput = (data: string) => {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
				currentTab = (currentTab + 1) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}
			if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
				currentTab = (currentTab - 1 + totalTabs) % totalTabs;
				optionIndex = 0;
				refresh();
				return;
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					done({ questions, answers: Array.from(answers.values()), cancelled: false });
					return;
				}
				if (matchesKey(data, Key.escape)) {
					done({ questions, answers: Array.from(answers.values()), cancelled: true });
				}
				return;
			}

			const question = currentQuestion();
			const options = currentOptions();
			if (!question) return;
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(options.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const option = options[optionIndex];
				if (!option) return;
				if (option.isOther) {
					inputMode = true;
					inputQuestionId = question.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(question, option.label, false, question.options.indexOf(option.label) + 1 || undefined);
				advanceAfterAnswer();
				return;
			}
			if (matchesKey(data, Key.escape)) {
				done({ questions, answers: Array.from(answers.values()), cancelled: true });
			}
		};

		const render = (width: number): string[] => {
			if (cachedLines) return cachedLines;
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			const question = currentQuestion();
			const options = currentOptions();

			add(theme.fg("accent", "─".repeat(width)));
			const tabs: string[] = [" "];
			for (let i = 0; i < questions.length; i++) {
				const isActive = i === currentTab;
				const isAnswered = answers.has(questions[i]!.id);
				const text = ` ${isAnswered ? "■" : "□"} ${questions[i]!.label} `;
				tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(isAnswered ? "success" : "muted", text));
			}
			const submitActive = currentTab === questions.length;
			tabs.push(submitActive ? theme.bg("selectedBg", theme.fg("text", " ✓ Submit ")) : theme.fg(allAnswered() ? "success" : "dim", " ✓ Submit "));
			add(tabs.join(" "));
			lines.push("");

			if (inputMode && question) {
				add(theme.fg("text", ` ${question.question}`));
				lines.push("");
				add(theme.fg("muted", " Type custom answer:"));
				for (const line of editor.render(Math.max(10, width - 2))) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter submit · Esc back"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", " Ready to submit"));
				lines.push("");
				for (const item of questions) {
					const answer = answers.get(item.id);
					if (answer) add(`${theme.fg("muted", ` ${item.label}: `)}${theme.fg("text", answer.answer)}`);
					else add(`${theme.fg("muted", ` ${item.label}: `)}${theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(theme.fg(allAnswered() ? "success" : "warning", allAnswered() ? " Press Enter to submit" : " Answer every question before submit"));
			} else if (question) {
				add(theme.fg("text", ` ${question.question}`));
				lines.push("");
				for (let i = 0; i < options.length; i++) {
					const option = options[i]!;
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const text = option.isOther ? `${i + 1}. ${option.label}` : `${i + 1}. ${option.label}`;
					add(prefix + (selected ? theme.fg("accent", text) : theme.fg("text", text)));
				}
			}

			lines.push("");
			add(theme.fg("dim", " Tab/←→ switch · ↑↓ choose · Enter confirm · Esc cancel"));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			return lines;
		};

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	}, { overlay: true });

	return result;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description: "Ask one question or batch multiple questions in one interactive flow.",
		parameters: QuestionToolParamsSchema,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const questions = normalizeParams(params);
			const bridgeFile = process.env[bridge.QUESTION_BRIDGE_ENV];
			if (questions.length === 0) {
				return {
					content: [{ type: "text", text: "Error: No questions provided." }],
					isError: true,
					details: { questions: [], answers: [], cancelled: true } satisfies QuestionToolResult,
				};
			}

			if (bridgeFile) {
				const requestId = `q-${toolCallId}-${Date.now()}`;
				const request: bridge.QuestionRequest = {
					requestId,
					questions: questions.map((question) => ({
						id: question.id,
						label: question.label,
						question: question.question,
						options: question.options,
						allowCustom: question.allowCustom,
					})),
				};
				await bridge.writeBridgeRequest(bridgeFile, request);
				try {
					const response = await bridge.readBridgeResponse(bridgeFile, requestId, 0);
					if (response.error) {
						return {
							content: [{ type: "text", text: `Error: ${response.error}` }],
							isError: true,
							details: { questions, answers: [], cancelled: true } satisfies QuestionToolResult,
						};
					}
					const normalizedAnswers = bridge.normalizeQuestionResponse(request, response);
					const answers: AnswerDef[] = normalizedAnswers
						.map((answer) => {
							const question = questions.find((item) => item.id === answer.id);
							if (!question) return undefined;
							return {
								id: question.id,
								label: question.label,
								question: question.question,
								answer: answer.answer,
								wasCustom: answer.wasCustom === true,
								selectedIndex: answer.selectedIndex,
							};
						})
						.filter(Boolean) as AnswerDef[];
					return buildTextResult({ questions, answers, cancelled: response.cancelled === true });
				} finally {
					await bridge.cleanupBridgeFiles(bridgeFile);
				}
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No UI available to ask question." }],
					isError: true,
					details: { questions, answers: [], cancelled: true } satisfies QuestionToolResult,
				};
			}

			const details = questions.length === 1 ? await askSequential(ctx, questions) : (await askCombined(ctx, questions)) ?? await askSequential(ctx, questions);
			return buildTextResult(details);
		},
		renderCall(args, theme) {
			const questions = normalizeParams(args);
			const count = questions.length;
			const labels = questions.map((question) => question.label).join(", ");
			let text = theme.fg("toolTitle", theme.bold("question "));
			text += theme.fg("muted", `${count} prompt${count === 1 ? "" : "s"}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as QuestionToolResult | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const lines = details.answers.map((answer) => {
				const prefix = `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label)}: `;
				if (answer.wasCustom) return prefix + theme.fg("muted", "(custom) ") + answer.answer;
				if (answer.selectedIndex) return prefix + `${answer.selectedIndex}. ${answer.answer}`;
				return prefix + answer.answer;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
