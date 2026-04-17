import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";

const STATUS_KEY = "gruvbox-ui";
const WIDGET_KEY = "gruvbox-ui";

const THINKING_COLORS = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
} as const;

type StatusMode = "idle" | "working" | "done";

function getProjectName(cwd: string): string {
	return basename(cwd) || cwd;
}

export default function gruvboxUi(pi: ExtensionAPI) {
	let turnCount = 0;

	const setTitle = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(`pi · ${getProjectName(ctx.cwd)} · gruvbox`);
	};

	const setWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const project = getProjectName(ctx.cwd);
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) =>
				new Text(
					theme.fg("accent", "◆ gruvbox-starship") +
						theme.fg("muted", " · ") +
						theme.fg("toolOutput", project) +
						theme.fg("muted", " · ") +
						theme.fg("dim", "subagent widgets tuned"),
					0,
					0,
				),
			{ placement: "belowEditor" },
		);
	};

	const setStatus = (ctx: ExtensionContext, mode: StatusMode) => {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		const model = ctx.model?.id ?? "no-model";
		const thinking = pi.getThinkingLevel();
		const thinkingColor = THINKING_COLORS[thinking];
		const badge =
			mode === "working"
				? theme.fg("warning", "●")
				: mode === "done"
					? theme.fg("success", "✓")
					: theme.fg("accent", "◆");
		const phase =
			mode === "working"
				? theme.fg("warning", `turn ${turnCount}`)
				: mode === "done"
					? theme.fg("success", `turn ${turnCount} done`)
					: theme.fg("dim", "idle");
		const parts = [
			badge,
			theme.fg("accent", getProjectName(ctx.cwd)),
			theme.fg("toolOutput", model),
			theme.fg(thinkingColor, `think:${thinking}`),
			phase,
		];
		ctx.ui.setStatus(STATUS_KEY, parts.join(theme.fg("muted", " · ")));
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setTitle(ctx);
		setWidget(ctx);
		ctx.ui.setWorkingMessage();
		setStatus(ctx, "idle");
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage("gruvbox focus…");
		setStatus(ctx, "working");
	});

	pi.on("turn_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		turnCount++;
		setStatus(ctx, "working");
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setStatus(ctx, "done");
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingMessage();
		setStatus(ctx, "idle");
	});

	pi.on("model_select", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		setStatus(ctx, ctx.isIdle() ? "idle" : "working");
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWidget(WIDGET_KEY, undefined);
		ctx.ui.setWorkingMessage();
	});
}
