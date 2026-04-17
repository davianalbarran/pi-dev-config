import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type OverlayHandle, type TUI, Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export type MonitorState = "running" | "success" | "error";
export type MonitorLineKind = "heading" | "meta" | "text" | "tool" | "error" | "usage" | "blank";

export interface MonitorLine {
	kind: MonitorLineKind;
	text: string;
}

export interface MonitorPanel {
	id: string;
	label: string;
	status: MonitorState;
	task: string;
	meta?: string;
	usage?: string;
	lines: MonitorLine[];
}

export interface MonitorSnapshot {
	id: string;
	title: string;
	mode: "single" | "parallel" | "chain";
	statusText: string;
	updatedAt: number;
	panels: MonitorPanel[];
}

interface GlimpseWindow {
	send(js: string): void;
	on(event: string, cb: (data?: any) => void): void;
	close(): void;
	show(options?: { title?: string }): void;
	hide(): void;
}

interface GlimpseModule {
	open(
		html: string,
		opts?: {
			title?: string;
			width?: number;
			height?: number;
			frameless?: boolean;
			transparent?: boolean;
			floating?: boolean;
			noDock?: boolean;
		},
	): GlimpseWindow;
}

interface MonitorEntry {
	id: string;
	snapshot: MonitorSnapshot;
	ctx: ExtensionContext;
	native?: NativeWindowController;
	overlay?: OverlayHandle;
	overlayComponent?: FloatingOverlayComponent;
	openedAt: number;
	lastTouchedAt: number;
}

const monitors = new Map<string, MonitorEntry>();
const monitorOrder: string[] = [];
const CLICK_MARKER_PREFIX = "\u001b_pi:subagent:";
const CLICK_MARKER_SUFFIX = "\u0007";
const CLICK_MARKER_RE = /\u001b_pi:subagent:([^\u0007]+)\u0007/g;
const MAX_BODY_LINES = 24;
const MAX_MONITORS = 24;

let globalTui: TUI | null = null;
let removeInputListener: (() => void) | null = null;
let mouseEnabled = false;
let glimpseModule: GlimpseModule | null = null;
let glimpsePromise: Promise<GlimpseModule | null> | null = null;
const activeWidgetIds = new Set<string>();

function makeMarker(id: string): string {
	return `${CLICK_MARKER_PREFIX}${encodeURIComponent(id)}${CLICK_MARKER_SUFFIX}`;
}

export function decorateWidgetLine(id: string, line: string): string {
	return `${makeMarker(id)}${line}`;
}

function parseMarker(line: string): string | undefined {
	const match = CLICK_MARKER_RE.exec(line);
	CLICK_MARKER_RE.lastIndex = 0;
	if (!match) return undefined;
	try {
		return decodeURIComponent(match[1]!);
	} catch {
		return undefined;
	}
}

function pad(line: string, width: number): string {
	const truncated = truncateToWidth(line, Math.max(0, width));
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function fitLeftRight(left: string, right: string, width: number): string {
	if (!right) return pad(left, width);
	const rightFit = truncateToWidth(right, width);
	const rightWidth = visibleWidth(rightFit);
	if (rightWidth >= width) return rightFit;
	const leftFit = truncateToWidth(left, Math.max(0, width - rightWidth - 1));
	const gap = Math.max(1, width - visibleWidth(leftFit) - rightWidth);
	return leftFit + " ".repeat(gap) + rightFit;
}

function getStateColor(state: MonitorState): string {
	switch (state) {
		case "running":
			return "warning";
		case "error":
			return "error";
		default:
			return "success";
	}
}

function getStateLabel(state: MonitorState): string {
	switch (state) {
		case "running":
			return "LIVE";
		case "error":
			return "FAILED";
		default:
			return "DONE";
	}
}

class FloatingOverlayComponent {
	focused = false;
	private selectedIndex = 0;
	private scroll = 0;

	constructor(
		private theme: Theme,
		private getSnapshot: () => MonitorSnapshot,
		private onClose: () => void,
		private requestRender: () => void,
	) {}

	update(): void {
		const snapshot = this.getSnapshot();
		this.requestRender();
		if (snapshot.panels.length === 0) {
			this.selectedIndex = 0;
			this.scroll = 0;
			return;
		}
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, snapshot.panels.length - 1));
		this.scroll = Math.max(0, this.scroll);
	}

	handleInput(data: string): void {
		const snapshot = this.getSnapshot();
		const panelCount = snapshot.panels.length;

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.onClose();
			return;
		}

		if (panelCount > 1 && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
			this.selectedIndex = (this.selectedIndex - 1 + panelCount) % panelCount;
			this.scroll = 0;
			return;
		}
		if (panelCount > 1 && (matchesKey(data, Key.right) || matchesKey(data, Key.tab))) {
			this.selectedIndex = (this.selectedIndex + 1) % panelCount;
			this.scroll = 0;
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.scroll = Math.max(0, this.scroll - 1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.scroll += 1;
			return;
		}
		if (matchesKey(data, "pageup")) {
			this.scroll = Math.max(0, this.scroll - 8);
			return;
		}
		if (matchesKey(data, "pagedown")) {
			this.scroll += 8;
			return;
		}
		if (matchesKey(data, Key.home) || data === "g") {
			this.scroll = 0;
			return;
		}
	}

	render(width: number): string[] {
		const snapshot = this.getSnapshot();
		const innerWidth = Math.max(12, width - 2);
		const selected = snapshot.panels[Math.max(0, Math.min(this.selectedIndex, snapshot.panels.length - 1))];
		const lines: string[] = [];
		const border = (s: string) => this.theme.fg("border", s);
		const borderAccent = (s: string) => this.theme.fg("borderAccent", s);
		const row = (content: string) => border("│") + pad(content, innerWidth) + border("│");
		const emptyRow = () => row("");

		lines.push(borderAccent(`╭${"─".repeat(innerWidth)}╮`));
		lines.push(
			row(
				fitLeftRight(
					`${this.theme.fg("accent", "◆ subagent monitor")} ${this.theme.fg("muted", snapshot.title)}`,
					this.theme.fg(getStateColor(selected?.status ?? "running") as any, getStateLabel(selected?.status ?? "running")),
					innerWidth,
				),
			),
		);
		lines.push(row(this.theme.fg("dim", `${snapshot.mode} · ${snapshot.statusText}`)));

		if (snapshot.panels.length > 1) {
			lines.push(row(this.theme.fg("dim", "─".repeat(Math.max(0, innerWidth)))));
			const tabs = snapshot.panels
				.map((panel, index) => {
					const label = ` ${panel.label} `;
					if (index === this.selectedIndex) {
						return this.theme.bg("selectedBg", this.theme.fg("text", label));
					}
					return this.theme.fg(panel.status === "error" ? "error" : panel.status === "running" ? "warning" : "muted", label);
				})
				.join(this.theme.fg("muted", " · "));
			lines.push(row(tabs));
		}

		lines.push(emptyRow());

		if (!selected) {
			lines.push(row(this.theme.fg("muted", "No subagent output yet.")));
		} else {
			lines.push(row(this.theme.fg("accent", "> Task")));
			for (const chunk of wrapTextWithAnsi(this.theme.fg("text", selected.task), Math.max(8, innerWidth - 2))) {
				lines.push(row(` ${chunk}`));
			}
			if (selected.meta) lines.push(row(this.theme.fg("dim", selected.meta)));
			lines.push(emptyRow());
			lines.push(row(this.theme.fg("accent", "> Stream")));

			const bodyLines: string[] = [];
			for (const line of selected.lines) {
				if (line.kind === "blank") {
					bodyLines.push("");
					continue;
				}
				const styled = styleLine(this.theme, line);
				const wrapped = wrapTextWithAnsi(styled, Math.max(8, innerWidth - 2));
				if (wrapped.length === 0) bodyLines.push("");
				else bodyLines.push(...wrapped);
			}
			const maxScroll = Math.max(0, bodyLines.length - MAX_BODY_LINES);
			this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
			const visible = bodyLines.slice(this.scroll, this.scroll + MAX_BODY_LINES);
			for (const line of visible) {
				lines.push(row(` ${line}`));
			}
			for (let i = visible.length; i < MAX_BODY_LINES; i++) lines.push(row(""));
			if (selected.usage) {
				lines.push(emptyRow());
				lines.push(row(this.theme.fg("dim", selected.usage)));
			}
		}

		lines.push(row(this.theme.fg("dim", "Esc close · ←/→ switch · ↑/↓ scroll")));
		lines.push(borderAccent(`╰${"─".repeat(innerWidth)}╯`));
		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

function styleLine(theme: Theme, line: MonitorLine): string {
	switch (line.kind) {
		case "heading":
			return theme.fg("accent", line.text);
		case "meta":
			return theme.fg("dim", line.text);
		case "tool":
			return theme.fg("warning", line.text);
		case "error":
			return theme.fg("error", line.text);
		case "usage":
			return theme.fg("dim", line.text);
		case "blank":
			return "";
		default:
			return theme.fg("text", line.text);
	}
}

class NativeWindowController {
	private win: GlimpseWindow | null = null;
	private lastSentJson = "";

	async open(snapshot: MonitorSnapshot): Promise<boolean> {
		const mod = await loadGlimpse();
		if (!mod) return false;
		if (!this.win) {
			this.win = mod.open(buildNativeHtml(), {
				title: snapshot.title,
				width: 1120,
				height: 760,
				floating: true,
				noDock: true,
			});
			this.win.on("message", (data?: any) => {
				if (data && typeof data === "object" && data.action === "__close") this.close();
			});
			this.win.on("closed", () => {
				this.win = null;
				this.lastSentJson = "";
			});
		}
		this.win.show({ title: snapshot.title });
		this.update(snapshot);
		return true;
	}

	update(snapshot: MonitorSnapshot): void {
		if (!this.win) return;
		const json = JSON.stringify(snapshot);
		if (json === this.lastSentJson) return;
		this.lastSentJson = json;
		this.win.send(`window.__subagentUpdate(${json.replace(/</g, "\\u003c")});`);
	}

	close(): void {
		if (!this.win) return;
		try {
			this.win.close();
		} catch {
			// ignore
		}
		this.win = null;
		this.lastSentJson = "";
	}

	isOpen(): boolean {
		return this.win !== null;
	}
}

function buildNativeHtml(): string {
	return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
:root {
	--bg0-hard: #1d2021;
	--bg0: #282828;
	--bg1: #3c3836;
	--bg2: #504945;
	--bg3: #665c54;
	--fg0: #fbf1c7;
	--fg1: #ebdbb2;
	--muted: #928374;
	--accent: #d65d0e;
	--warning: #fabd2f;
	--success: #b8bb26;
	--error: #fb4934;
	--blue: #83a598;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg0-hard); color: var(--fg0); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
body { padding: 14px; }
.shell {
	height: 100%;
	display: grid;
	grid-template-rows: auto auto 1fr auto;
	background: linear-gradient(180deg, rgba(60,56,54,.98), rgba(29,32,33,.98));
	border: 1px solid var(--bg3);
	border-radius: 16px;
	box-shadow: 0 18px 60px rgba(0,0,0,.45);
	overflow: hidden;
}
.header, .footer {
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 14px 18px;
	background: rgba(29,32,33,.92);
	border-bottom: 1px solid rgba(124,111,100,.45);
}
.footer {
	justify-content: space-between;
	border-bottom: 0;
	border-top: 1px solid rgba(124,111,100,.45);
	color: var(--muted);
	font-size: 12px;
}
.title { color: var(--accent); font-weight: 700; }
.subtitle { color: var(--muted); }
.badge {
	margin-left: auto;
	padding: 5px 10px;
	border-radius: 999px;
	font-size: 12px;
	font-weight: 700;
	letter-spacing: .04em;
	background: rgba(215,153,33,.14);
	border: 1px solid rgba(215,153,33,.32);
	color: var(--warning);
}
.badge.success { color: var(--success); border-color: rgba(184,187,38,.32); background: rgba(184,187,38,.12); }
.badge.error { color: var(--error); border-color: rgba(251,73,52,.32); background: rgba(251,73,52,.12); }
.tabs {
	display: flex;
	gap: 8px;
	padding: 12px 18px 0;
	background: rgba(29,32,33,.72);
	border-bottom: 1px solid rgba(124,111,100,.25);
	flex-wrap: wrap;
}
.tab {
	padding: 8px 11px;
	border-radius: 10px 10px 0 0;
	background: rgba(60,56,54,.72);
	border: 1px solid transparent;
	border-bottom: 0;
	color: var(--muted);
	cursor: pointer;
	user-select: none;
}
.tab.active {
	background: rgba(80,73,69,.95);
	color: var(--fg0);
	border-color: rgba(124,111,100,.55);
}
.tab.running { color: var(--warning); }
.tab.success { color: var(--success); }
.tab.error { color: var(--error); }
.body {
	display: grid;
	grid-template-rows: auto auto 1fr auto;
	gap: 14px;
	padding: 18px;
	min-height: 0;
}
.section-label { color: var(--accent); font-weight: 700; margin-bottom: 6px; }
.block {
	background: rgba(29,32,33,.78);
	border: 1px solid rgba(124,111,100,.38);
	border-radius: 12px;
	padding: 14px 16px;
}
.meta { color: var(--muted); font-size: 12px; margin-top: 8px; }
.stream {
	overflow: auto;
	white-space: pre-wrap;
	word-break: break-word;
	line-height: 1.45;
	background: rgba(0,0,0,.2);
}
.line { display: block; }
.line.heading { color: var(--accent); font-weight: 700; }
.line.meta, .line.usage { color: var(--muted); }
.line.tool { color: var(--warning); }
.line.error { color: var(--error); }
.close {
	margin-left: 8px;
	padding: 6px 10px;
	border-radius: 8px;
	border: 1px solid rgba(251,73,52,.32);
	background: rgba(251,73,52,.12);
	color: var(--error);
	cursor: pointer;
}
</style>
</head>
<body>
<div class="shell">
	<div class="header">
		<div class="title" id="title">subagent monitor</div>
		<div class="subtitle" id="subtitle">waiting…</div>
		<div class="badge" id="badge">LIVE</div>
		<button class="close" id="close">Close</button>
	</div>
	<div class="tabs" id="tabs"></div>
	<div class="body">
		<div class="block">
			<div class="section-label">Task</div>
			<div id="task"></div>
			<div class="meta" id="meta"></div>
		</div>
		<div class="section-label">Stream</div>
		<div class="block stream" id="stream"></div>
		<div class="meta" id="usage"></div>
	</div>
	<div class="footer">
		<div>Gruvbox Starship · live subagent stream</div>
		<div>click tabs to switch · Close to dismiss</div>
	</div>
</div>
<script>
const titleEl = document.getElementById('title');
const subtitleEl = document.getElementById('subtitle');
const badgeEl = document.getElementById('badge');
const tabsEl = document.getElementById('tabs');
const taskEl = document.getElementById('task');
const metaEl = document.getElementById('meta');
const streamEl = document.getElementById('stream');
const usageEl = document.getElementById('usage');
const closeEl = document.getElementById('close');
let state = null;
let selectedPanelId = null;
function badgeClass(status) {
	return status === 'error' ? 'badge error' : status === 'success' ? 'badge success' : 'badge';
}
function pickPanel(snapshot) {
	if (!snapshot || !snapshot.panels || snapshot.panels.length === 0) return null;
	if (selectedPanelId) {
		const match = snapshot.panels.find((panel) => panel.id === selectedPanelId);
		if (match) return match;
	}
	return snapshot.panels.find((panel) => panel.status === 'running') || snapshot.panels[snapshot.panels.length - 1];
}
function render(snapshot) {
	state = snapshot;
	const panel = pickPanel(snapshot);
	selectedPanelId = panel ? panel.id : null;
	titleEl.textContent = snapshot.title;
	subtitleEl.textContent = snapshot.mode + ' · ' + snapshot.statusText;
	badgeEl.className = badgeClass(panel ? panel.status : 'running');
	badgeEl.textContent = panel ? (panel.status === 'running' ? 'LIVE' : panel.status === 'error' ? 'FAILED' : 'DONE') : 'LIVE';
	tabsEl.innerHTML = '';
	for (const panelItem of snapshot.panels) {
		const el = document.createElement('button');
		el.className = 'tab ' + panelItem.status + (panel && panelItem.id === panel.id ? ' active' : '');
		el.textContent = panelItem.label;
		el.addEventListener('click', () => {
			selectedPanelId = panelItem.id;
			render(state);
		});
		tabsEl.appendChild(el);
	}
	if (!panel) {
		taskEl.textContent = 'No subagent output yet.';
		metaEl.textContent = '';
		streamEl.textContent = '';
		usageEl.textContent = '';
		return;
	}
	taskEl.textContent = panel.task || '(no task)';
	metaEl.textContent = panel.meta || '';
	usageEl.textContent = panel.usage || '';
	streamEl.innerHTML = '';
	for (const line of panel.lines) {
		const div = document.createElement('div');
		div.className = 'line ' + line.kind;
		div.textContent = line.text;
		streamEl.appendChild(div);
	}
	streamEl.scrollTop = streamEl.scrollHeight;
}
window.__subagentUpdate = render;
closeEl.addEventListener('click', () => {
	if (window.glimpse) window.glimpse.send({ action: '__close' });
});
</script>
</body>
</html>`;
}

async function loadGlimpse(): Promise<GlimpseModule | null> {
	if (glimpseModule) return glimpseModule;
	if (!glimpsePromise) {
		glimpsePromise = (async () => {
			try {
				glimpseModule = (await import("glimpseui")) as GlimpseModule;
				return glimpseModule;
			} catch {
				glimpsePromise = null;
				return null;
			}
		})();
	}
	return glimpsePromise;
}

function enableMouse(tui: TUI): void {
	if (mouseEnabled) return;
	mouseEnabled = true;
	tui.terminal.write("\u001b[?1000h\u001b[?1006h");
}

function disableMouse(tui: TUI): void {
	if (!mouseEnabled) return;
	mouseEnabled = false;
	tui.terminal.write("\u001b[?1000l\u001b[?1006l");
}

function parseMouse(data: string): { row: number; col: number } | undefined {
	const match = data.match(/^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/);
	if (!match) return undefined;
	const button = parseInt(match[1]!, 10);
	const col = parseInt(match[2]!, 10);
	const row = parseInt(match[3]!, 10);
	const kind = match[4]!;
	if (kind !== "M") return undefined;
	if ((button & 64) !== 0) return undefined;
	if ((button & 3) !== 0) return undefined;
	return { row, col };
}

function installInputListener(tui: TUI): void {
	if (globalTui === tui && removeInputListener) return;
	if (removeInputListener) {
		removeInputListener();
		removeInputListener = null;
	}
	globalTui = tui;
	removeInputListener = tui.addInputListener((data) => {
		const mouse = parseMouse(data);
		if (!mouse) return undefined;
		const lines = tui.render(tui.terminal.columns);
		const visible = lines.slice(-tui.terminal.rows);
		const rowIndex = mouse.row - 1;
		for (let offset = 0; offset <= 2; offset++) {
			const candidateIndex = rowIndex - offset;
			if (candidateIndex < 0 || candidateIndex >= visible.length) continue;
			const id = parseMarker(visible[candidateIndex] ?? "");
			if (!id || !activeWidgetIds.has(id)) continue;
			if (rowIndex <= candidateIndex + 2) {
				const entry = monitors.get(id);
				if (!entry) continue;
				void openFloatingMonitor(entry.ctx, id);
				return { consume: true };
			}
		}
		return undefined;
	});
	enableMouse(tui);
}

function maybeDisableInputListener(): void {
	if (!globalTui) return;
	if (activeWidgetIds.size > 0) return;
	disableMouse(globalTui);
	removeInputListener?.();
	removeInputListener = null;
	globalTui = null;
}

function trimMonitors(): void {
	while (monitorOrder.length > MAX_MONITORS) {
		const oldest = monitorOrder.shift();
		if (!oldest) break;
		const entry = monitors.get(oldest);
		if (!entry) continue;
		entry.native?.close();
		entry.overlay?.hide();
		activeWidgetIds.delete(oldest);
		monitors.delete(oldest);
	}
}

export function bindFloatingMonitorWidget(tui: TUI, id: string): void {
	activeWidgetIds.add(id);
	installInputListener(tui);
}

export function unbindFloatingMonitorWidget(id: string): void {
	activeWidgetIds.delete(id);
	maybeDisableInputListener();
}

export function upsertFloatingMonitor(ctx: ExtensionContext, snapshot: MonitorSnapshot): void {
	const existing = monitors.get(snapshot.id);
	if (existing) {
		existing.snapshot = snapshot;
		existing.ctx = ctx;
		existing.lastTouchedAt = Date.now();
		existing.overlayComponent?.update();
		existing.native?.update(snapshot);
		return;
	}
	const entry: MonitorEntry = {
		id: snapshot.id,
		snapshot,
		ctx,
		native: new NativeWindowController(),
		openedAt: Date.now(),
		lastTouchedAt: Date.now(),
	};
	monitors.set(snapshot.id, entry);
	monitorOrder.push(snapshot.id);
	trimMonitors();
}

export async function openFloatingMonitor(ctx: ExtensionContext, id: string): Promise<boolean> {
	const entry = monitors.get(id);
	if (!entry) return false;
	entry.ctx = ctx;
	entry.lastTouchedAt = Date.now();

	if (await entry.native?.open(entry.snapshot)) {
		return true;
	}

	if (!ctx.hasUI) return false;
	if (entry.overlay) {
		entry.overlay.setHidden(false);
		entry.overlay.focus();
		return true;
	}

	void ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const component = new FloatingOverlayComponent(
				theme,
				() => monitors.get(id)?.snapshot ?? entry.snapshot,
				() => done(undefined),
				() => tui.requestRender(),
			);
			component.update();
			entry.overlayComponent = component;
			return component;
		},
		{
			overlay: true,
			overlayOptions: { width: "86%", maxHeight: "82%", anchor: "center" },
			onHandle: (handle) => {
				entry.overlay = handle;
			},
		},
	).finally(() => {
		const current = monitors.get(id);
		if (!current) return;
		current.overlay = undefined;
		current.overlayComponent = undefined;
	});

	return true;
}

export function closeFloatingMonitor(id: string): void {
	const entry = monitors.get(id);
	if (!entry) return;
	entry.native?.close();
	entry.overlay?.hide();
	entry.overlay = undefined;
	entry.overlayComponent = undefined;
}

export function removeFloatingMonitor(id: string): void {
	closeFloatingMonitor(id);
	monitors.delete(id);
	const index = monitorOrder.indexOf(id);
	if (index >= 0) monitorOrder.splice(index, 1);
	maybeDisableInputListener();
}

export function getLatestFloatingMonitorId(): string | undefined {
	for (let i = monitorOrder.length - 1; i >= 0; i--) {
		const id = monitorOrder[i];
		if (monitors.has(id)) return id;
	}
	return undefined;
}

export function hasFloatingMonitor(id: string): boolean {
	return monitors.has(id);
}

export function shutdownFloatingMonitors(): void {
	for (const entry of monitors.values()) {
		entry.native?.close();
		entry.overlay?.hide();
	}
	monitors.clear();
	monitorOrder.length = 0;
	activeWidgetIds.clear();
	maybeDisableInputListener();
}
