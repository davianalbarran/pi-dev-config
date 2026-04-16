/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { agent: "name", task: "..." }
 *   - Parallel: { tasks: [{ agent: "name", task: "..." }, ...] }
 *   - Chain: { chain: [{ agent: "name", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme, SessionManager, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { type AgentConfig, type AgentScope, type AgentSource, type AgentThinkingLevel, discoverAgents } from "./agents.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const COLLAPSED_ITEM_COUNT = 10;

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	numericId?: number;
}

interface AgentRunOverrides {
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
}

interface ManagedSubagent {
	id: number;
	agent: string;
	task: string;
	sessionFile: string;
	result: SingleResult;
	abortController: AbortController;
	widgetKey: string;
	runToken: number;
	removed: boolean;
}

let nextManagedId = 1;
const managedSubagents = new Map<number, ManagedSubagent>();

interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

const THINKING_COLORS: Record<AgentThinkingLevel, string> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

function getResultState(result: SingleResult): "running" | "success" | "error" {
	if (result.exitCode === -1) return "running";
	if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") return "error";
	return "success";
}

function getShortModelName(model?: string): string | undefined {
	if (!model) return undefined;
	const trimmed = model.trim();
	if (!trimmed) return undefined;
	const parts = trimmed.split("/");
	return parts[parts.length - 1] || trimmed;
}

function getThinkingLabel(thinkingLevel?: AgentThinkingLevel): string | undefined {
	return thinkingLevel ? `think:${thinkingLevel}` : undefined;
}

function formatThinkingLabel(
	thinkingLevel: AgentThinkingLevel | undefined,
	themeFg: (color: any, text: string) => string,
): string | undefined {
	if (!thinkingLevel) return undefined;
	return themeFg(THINKING_COLORS[thinkingLevel], getThinkingLabel(thinkingLevel)!);
}

function formatAgentMetadata(
	result: Pick<SingleResult, "agentSource" | "thinkingLevel">,
	themeFg: (color: any, text: string) => string,
): string {
	const parts = [
		result.agentSource !== "unknown" ? themeFg("muted", result.agentSource) : undefined,
		formatThinkingLabel(result.thinkingLevel, themeFg),
	].filter(Boolean);
	return parts.length > 0 ? ` (${parts.join(themeFg("muted", " · "))})` : "";
}

function createPendingResult(
	agents: AgentConfig[],
	agentName: string,
	task: string,
	step?: number,
	runOverrides?: AgentRunOverrides,
): SingleResult {
	const agent = agents.find((a) => a.name === agentName);
	return {
		agent: agentName,
		agentSource: agent?.source ?? "unknown",
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: runOverrides?.model ?? agent?.model,
		thinkingLevel: runOverrides?.thinkingLevel ?? agent?.thinkingLevel,
		step,
	};
}

function formatWidgetTokenUsage(usage: UsageStats): string {
	const parts = [`↑${formatTokens(usage.input)}`, `↓${formatTokens(usage.output)}`];
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	return parts.join(" ");
}

function normalizePreviewText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function getToolCallCount(messages: Message[]): number {
	let count = 0;
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) {
			if (part.type === "toolCall") count++;
		}
	}
	return count;
}

function getLatestTextPreview(messages: Message[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type !== "text") continue;
			const preview = normalizePreviewText(part.text);
			if (preview) return preview;
		}
	}
	return undefined;
}

function getLatestToolCallPreview(
	messages: Message[],
	themeFg: (color: any, text: string) => string,
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type !== "toolCall") continue;
			return themeFg("muted", "→ ") + formatToolCall(part.name, part.arguments, themeFg);
		}
	}
	return undefined;
}

function padAnsiLine(text: string, width: number): string {
	const truncated = truncateToWidth(text, Math.max(0, width));
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function joinAnsiLeftRight(left: string, right: string, width: number): string {
	if (width <= 0) return "";
	if (!right) return padAnsiLine(left, width);
	const fittedRight = truncateToWidth(right, width);
	const rightWidth = visibleWidth(fittedRight);
	if (rightWidth >= width) return fittedRight;
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = Math.max(1, width - visibleWidth(fittedLeft) - rightWidth);
	return fittedLeft + " ".repeat(gap) + fittedRight;
}

function renderSubagentWidgetCard(result: SingleResult, width: number, theme: any): string[] {
	const innerWidth = Math.max(1, width - 2);
	const state = getResultState(result);
	const icon =
		state === "running"
			? theme.fg("warning", "⏳")
			: state === "error"
				? theme.fg("error", "✗")
				: theme.fg("success", "✓");
	const label = result.numericId ? `Subagent #${result.numericId}` : result.step ? `#${result.step} ${result.agent}` : result.agent;
	const status =
		state === "running"
			? theme.fg("warning", "running")
			: state === "error"
				? theme.fg("error", "failed")
				: theme.fg("success", "done");
	const taskPreview = normalizePreviewText(result.task) || "(no task)";
	const topLeft = `${icon} ${theme.fg("accent", label)}${theme.fg("muted", " — ")}${theme.fg("warning", taskPreview)}`;
	const topRight = `${status} ${theme.fg("dim", formatWidgetTokenUsage(result.usage))}`;

	const metaParts: string[] = [];
	if (result.agentSource !== "unknown") metaParts.push(theme.fg("dim", result.agentSource));
	const thinkingLabel = formatThinkingLabel(result.thinkingLevel, theme.fg.bind(theme));
	if (thinkingLabel) metaParts.push(thinkingLabel);
	const shortModel = getShortModelName(result.model);
	if (shortModel) metaParts.push(theme.fg("dim", shortModel));
	const toolCount = getToolCallCount(result.messages);
	metaParts.push(theme.fg("dim", `${toolCount} tool${toolCount === 1 ? "" : "s"}`));

	let preview: string;
	if (state === "error") {
		const errorPreview =
			normalizePreviewText(result.errorMessage || result.stderr.split("\n").find((line) => line.trim()) || "") || "(failed)";
		preview = theme.fg("error", errorPreview);
	} else {
		const textPreview = getLatestTextPreview(result.messages);
		if (textPreview) preview = theme.fg("toolOutput", textPreview);
		else preview = getLatestToolCallPreview(result.messages, theme.fg.bind(theme)) ?? theme.fg("muted", state === "running" ? "(running...)" : "(no output)");
	}

	const meta = metaParts.join(theme.fg("muted", " · "));
	const body = meta ? `${meta}${theme.fg("muted", " — ")}${preview}` : preview;
	const border = (text: string) => theme.fg("warning", text);

	return [
		border("╭") + joinAnsiLeftRight(topLeft, topRight, innerWidth) + border("╮"),
		border("│") + padAnsiLine(body, innerWidth) + border("│"),
		border(`╰${"─".repeat(innerWidth)}╯`),
	];
}

function setSubagentWidget(ctx: ExtensionContext, widgetKey: string, details: SubagentDetails): void {
	if (!ctx.hasUI) return;

	ctx.ui.setWidget(
		widgetKey,
		(_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const lines: string[] = [];
				for (let i = 0; i < details.results.length; i++) {
					if (i > 0) lines.push("");
					lines.push(...renderSubagentWidgetCard(details.results[i], width, theme));
				}
				return lines;
			},
		}),
		{ placement: "aboveEditor" },
	);
}

function getFinalOutput(messages: Message[]): string {
	let fallback = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (part.type !== "text") continue;
			if (part.text.trim()) return part.text;
			if (!fallback) fallback = part.text;
		}
	}
	return fallback;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

async function runSingleAgent(
	defaultCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	sessionFile?: string,
	numericId?: number,
	runOverrides?: AgentRunOverrides,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			agent: agentName,
			agentSource: "unknown",
			task,
			exitCode: 1,
			messages: [],
			stderr: `Unknown agent: "${agentName}". Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			step,
			numericId,
		};
	}

	const effectiveModel = runOverrides?.model ?? agent.model;
	const effectiveThinkingLevel = runOverrides?.thinkingLevel ?? agent.thinkingLevel;

	const args: string[] = ["--mode", "json", "-p"];
	if (sessionFile) {
		args.push("--session", sessionFile);
	} else {
		args.push("--no-session");
	}
	if (effectiveModel) args.push("--model", effectiveModel);
	if (effectiveThinkingLevel) args.push("--thinking", effectiveThinkingLevel);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		agent: agentName,
		agentSource: agent.source,
		task,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: effectiveModel,
		thinkingLevel: effectiveThinkingLevel,
		step,
		numericId,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens = usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

const TaskItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const ChainItem = Type.Object({
	agent: Type.String({ description: "Name of the agent to invoke" }),
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Name of the agent to invoke (for single mode)" })),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {agent, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			'Default agent scope is "user" (bundled extension agents + ~/.pi/agent/agents).',
			'To enable project-local agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const widgetKey = `subagent:${toolCallId}`;
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.agent && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			const pushPartial = (partial: AgentToolResult<SubagentDetails>) => {
				onUpdate?.(partial);
				if (partial.details) setSubagentWidget(ctx, widgetKey, partial.details);
			};

			try {
				if (modeCount !== 1) {
					const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
					return {
						content: [
							{
								type: "text",
								text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
							},
						],
						details: makeDetails("single")([]),
					};
				}

				if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
					const requestedAgentNames = new Set<string>();
					if (params.chain) for (const step of params.chain) requestedAgentNames.add(step.agent);
					if (params.tasks) for (const t of params.tasks) requestedAgentNames.add(t.agent);
					if (params.agent) requestedAgentNames.add(params.agent);

					const projectAgentsRequested = Array.from(requestedAgentNames)
						.map((name) => agents.find((a) => a.name === name))
						.filter((a): a is AgentConfig => a?.source === "project");

					if (projectAgentsRequested.length > 0) {
						const names = projectAgentsRequested.map((a) => a.name).join(", ");
						const dir = discovery.projectAgentsDir ?? "(unknown)";
						const ok = await ctx.ui.confirm(
							"Run project-local agents?",
							`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
						);
						if (!ok)
							return {
								content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
								details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
							};
					}
				}

				if (params.chain && params.chain.length > 0) {
					const results: SingleResult[] = [];
					let previousOutput = "";

					for (let i = 0; i < params.chain.length; i++) {
						const step = params.chain[i];
						const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
						setSubagentWidget(ctx, widgetKey, makeDetails("chain")([...results, createPendingResult(agents, step.agent, taskWithContext, i + 1)]));

						const chainUpdate: OnUpdateCallback | undefined = (partial) => {
							const currentResult = partial.details?.results[0];
							if (currentResult) {
								pushPartial({
									content: partial.content,
									details: makeDetails("chain")([...results, currentResult]),
								});
							}
						};

						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							step.agent,
							taskWithContext,
							step.cwd,
							i + 1,
							signal,
							chainUpdate,
							makeDetails("chain"),
						);
						results.push(result);
						setSubagentWidget(ctx, widgetKey, makeDetails("chain")([...results]));

						const isError =
							result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
						if (isError) {
							const errorMsg =
								result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
							return {
								content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${step.agent}): ${errorMsg}` }],
								details: makeDetails("chain")(results),
								isError: true,
							};
						}
						previousOutput = getFinalOutput(result.messages);
					}
					return {
						content: [{ type: "text", text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
						details: makeDetails("chain")(results),
					};
				}

				if (params.tasks && params.tasks.length > 0) {
					if (params.tasks.length > MAX_PARALLEL_TASKS)
						return {
							content: [
								{
									type: "text",
									text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
								},
							],
							details: makeDetails("parallel")([]),
						};

					const allResults = params.tasks.map((task) => createPendingResult(agents, task.agent, task.task));
					setSubagentWidget(ctx, widgetKey, makeDetails("parallel")([...allResults]));

					const emitParallelUpdate = () => {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						pushPartial({
							content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
							details: makeDetails("parallel")([...allResults]),
						});
					};

					const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
						const result = await runSingleAgent(
							ctx.cwd,
							agents,
							t.agent,
							t.task,
							t.cwd,
							undefined,
							signal,
							(partial) => {
								if (partial.details?.results[0]) {
									allResults[index] = partial.details.results[0];
									emitParallelUpdate();
								}
							},
							makeDetails("parallel"),
						);
						allResults[index] = result;
						emitParallelUpdate();
						return result;
					});

					const successCount = results.filter((r) => r.exitCode === 0).length;
					const summaries = results.map((r) => {
						const output = getFinalOutput(r.messages);
						const preview = output.slice(0, 100) + (output.length > 100 ? "..." : "");
						return `[${r.agent}] ${getResultState(r) === "success" ? "completed" : "failed"}: ${preview || "(no output)"}`;
					});
					return {
						content: [
							{
								type: "text",
								text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n")}`,
							},
						],
						details: makeDetails("parallel")(results),
					};
				}

				if (params.agent && params.task) {
					setSubagentWidget(ctx, widgetKey, makeDetails("single")([createPendingResult(agents, params.agent, params.task)]));
					const result = await runSingleAgent(
						ctx.cwd,
						agents,
						params.agent,
						params.task,
						params.cwd,
						undefined,
						signal,
						pushPartial,
						makeDetails("single"),
					);
					const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
					if (isError) {
						const errorMsg =
							result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
						return {
							content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
							details: makeDetails("single")([result]),
							isError: true,
						};
					}
					return {
						content: [{ type: "text", text: getFinalOutput(result.messages) || "(no output)" }],
						details: makeDetails("single")([result]),
					};
				}

				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
					details: makeDetails("single")([]),
				};
			} finally {
				if (ctx.hasUI) ctx.ui.setWidget(widgetKey, undefined);
			}
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? "user";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					// Clean up {previous} placeholder for display
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", step.agent) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subagent ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = args.agent || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subagent ")) +
				theme.fg("accent", agentName) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const state = getResultState(r);
				const isRunning = state === "running";
				const isError = state === "error";
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: isError
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${formatAgentMetadata(r, theme.fg.bind(theme))}`;
					if (isRunning) header += ` ${theme.fg("warning", "[running]")}`;
					else if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", isRunning ? "(running...)" : "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${formatAgentMetadata(r, theme.fg.bind(theme))}`;
				if (isRunning) text += ` ${theme.fg("warning", "[running]")}`;
				else if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", isRunning ? "(running...)" : "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const runningCount = details.results.filter((r) => getResultState(r) === "running").length;
				const successCount = details.results.filter((r) => getResultState(r) === "success").length;
				const failCount = details.results.filter((r) => getResultState(r) === "error").length;
				const icon = runningCount > 0
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("error", "✗")
						: theme.fg("success", "✓");
				const status =
					runningCount > 0
						? `${successCount + failCount}/${details.results.length} done, ${runningCount} running`
						: `${successCount}/${details.results.length} steps`;

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", status),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rState = getResultState(r);
						const rIcon =
							rState === "running"
								? theme.fg("warning", "⏳")
								: rState === "success"
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)}${formatAgentMetadata(r, theme.fg.bind(theme))} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text = icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", status);
				for (const r of details.results) {
					const rState = getResultState(r);
					const rIcon =
						rState === "running"
							? theme.fg("warning", "⏳")
							: rState === "success"
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}${formatAgentMetadata(r, theme.fg.bind(theme))} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", getResultState(r) === "running" ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => getResultState(r) === "running").length;
				const successCount = details.results.filter((r) => getResultState(r) === "success").length;
				const failCount = details.results.filter((r) => getResultState(r) === "error").length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rState = getResultState(r);
						const rIcon =
							rState === "running"
								? theme.fg("warning", "⏳")
								: rState === "success"
									? theme.fg("success", "✓")
									: theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)}${formatAgentMetadata(r, theme.fg.bind(theme))} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rState = getResultState(r);
					const rIcon =
						rState === "running"
							? theme.fg("warning", "⏳")
							: rState === "success"
								? theme.fg("success", "✓")
								: theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${formatAgentMetadata(r, theme.fg.bind(theme))} ${rIcon}`;
					if (displayItems.length === 0)
						text += `\n${theme.fg("muted", rState === "running" ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		},
	});

	const notifyCommand = (
		ctx: ExtensionContext,
		message: string,
		type: "info" | "warning" | "error" = "info",
	): void => {
		ctx.ui.notify(message, type);
	};

	const getErrorMessage = (error: unknown): string => {
		if (error instanceof Error && error.message) return error.message;
		if (typeof error === "string" && error.trim()) return error;
		return "Unknown error";
	};

	const isManagedRunCurrent = (managed: ManagedSubagent, runToken: number): boolean => {
		const current = managedSubagents.get(managed.id);
		return current === managed && !managed.removed && managed.runToken === runToken;
	};

	const clearManagedSubagentWidget = (ctx: ExtensionContext, managed: ManagedSubagent): void => {
		if (ctx.hasUI) ctx.ui.setWidget(managed.widgetKey, undefined);
	};

	const createManagedSessionFile = (ctx: ExtensionContext): string => {
		const sessionFile = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir()).getSessionFile();
		if (!sessionFile) throw new Error("Failed to allocate subagent session file");
		return sessionFile;
	};

	const getParentRunOverrides = (ctx: ExtensionContext): AgentRunOverrides => ({
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel: pi.getThinkingLevel() as AgentThinkingLevel,
	});

	const startManagedSubagentRun = (
		ctx: ExtensionContext,
		agents: AgentConfig[],
		projectAgentsDir: string | null,
		managed: ManagedSubagent,
		task: string,
		runOverrides?: AgentRunOverrides,
	): void => {
		const makeDetails = (results: SingleResult[]): SubagentDetails => ({
			mode: "single",
			agentScope: "user",
			projectAgentsDir,
			results,
		});
		const abortController = new AbortController();
		const runToken = managed.runToken + 1;

		managed.runToken = runToken;
		managed.removed = false;
		managed.task = task;
		managed.abortController = abortController;
		managed.result = createPendingResult(agents, managed.agent, task, undefined, runOverrides);
		managed.result.numericId = managed.id;
		setSubagentWidget(ctx, managed.widgetKey, makeDetails([managed.result]));

		void runSingleAgent(
			ctx.cwd,
			agents,
			managed.agent,
			task,
			undefined,
			undefined,
			abortController.signal,
			(partial) => {
				const partialResult = partial.details?.results[0];
				if (!partialResult || !isManagedRunCurrent(managed, runToken)) return;
				managed.result = partialResult;
				setSubagentWidget(ctx, managed.widgetKey, makeDetails([managed.result]));
			},
			makeDetails,
			managed.sessionFile,
			managed.id,
			runOverrides,
		)
			.then((finalResult) => {
				if (!isManagedRunCurrent(managed, runToken)) return;
				managed.result = finalResult;
				setSubagentWidget(ctx, managed.widgetKey, makeDetails([managed.result]));
			})
			.catch((error: unknown) => {
				if (!isManagedRunCurrent(managed, runToken)) return;
				if (abortController.signal.aborted && getErrorMessage(error) === "Subagent was aborted") return;
				notifyCommand(ctx, `Subagent #${managed.id} error: ${getErrorMessage(error)}`, "error");
			});
	};

	pi.registerCommand("sub", {
		description: "Spawn a managed subagent: /sub <prompt> or /sub <agent> <prompt>",
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (!trimmedArgs) {
				notifyCommand(ctx, "Usage: /sub <prompt> or /sub <agent> <prompt>", "error");
				return;
			}

			const discovery = discoverAgents(ctx.cwd, "user");
			const agents = discovery.agents;
			const defaultAgentName = agents.find((agent) => agent.name === "worker")?.name;

			const firstSpace = trimmedArgs.indexOf(" ");
			const firstToken = firstSpace === -1 ? trimmedArgs : trimmedArgs.slice(0, firstSpace);
			const remainder = firstSpace === -1 ? "" : trimmedArgs.slice(firstSpace + 1).trim();
			const explicitAgent = agents.find((agent) => agent.name === firstToken);

			const agentName = explicitAgent && remainder ? explicitAgent.name : defaultAgentName;
			const task = explicitAgent && remainder ? remainder : trimmedArgs;

			if (!agentName) {
				notifyCommand(ctx, "No default `worker` agent found. Use /sub <agent> <prompt>.", "error");
				return;
			}

			if (!task) {
				notifyCommand(ctx, "Usage: /sub <prompt> or /sub <agent> <prompt>", "error");
				return;
			}

			const id = nextManagedId++;
			const parentRunOverrides = getParentRunOverrides(ctx);
			const managed: ManagedSubagent = {
				id,
				agent: agentName,
				task,
				sessionFile: createManagedSessionFile(ctx),
				widgetKey: `managed-subagent-${id}`,
				abortController: new AbortController(),
				result: createPendingResult(agents, agentName, task, undefined, parentRunOverrides),
				runToken: 0,
				removed: false,
			};
			managed.result.numericId = id;
			managedSubagents.set(id, managed);
			startManagedSubagentRun(ctx, agents, discovery.projectAgentsDir, managed, task, parentRunOverrides);

			notifyCommand(ctx, `Started subagent #${id} (${agentName})`);
		},
	});

	pi.registerCommand("subrm", {
		description: "Remove a managed subagent: /subrm <id>",
		handler: async (args, ctx) => {
			const id = parseInt(args.trim().replace(/^#/, ""), 10);
			if (isNaN(id)) {
				notifyCommand(ctx, "Usage: /subrm <id>", "error");
				return;
			}

			const managed = managedSubagents.get(id);
			if (!managed) {
				notifyCommand(ctx, `Subagent #${id} not found`, "error");
				return;
			}

			managed.removed = true;
			managed.abortController.abort();
			managedSubagents.delete(id);
			clearManagedSubagentWidget(ctx, managed);
			notifyCommand(ctx, `Removed subagent #${id}`);
		},
	});

	pi.registerCommand("subcont", {
		description: "Continue a managed subagent: /subcont <id> <new prompt>",
		handler: async (args, ctx) => {
			const match = args.match(/^#?(\d+)\s+(.+)$/);
			if (!match) {
				notifyCommand(ctx, "Usage: /subcont <id> <new prompt>", "error");
				return;
			}

			const id = parseInt(match[1], 10);
			const newTask = match[2];
			const managed = managedSubagents.get(id);
			if (!managed) {
				notifyCommand(ctx, `Subagent #${id} not found`, "error");
				return;
			}

			if (managed.result.exitCode === -1) managed.abortController.abort();

			const discovery = discoverAgents(ctx.cwd, "user");
			startManagedSubagentRun(
				ctx,
				discovery.agents,
				discovery.projectAgentsDir,
				managed,
				newTask,
				getParentRunOverrides(ctx),
			);
			notifyCommand(ctx, `Continued subagent #${id} with new task`);
		},
	});
}
