import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assembleAgentSession } from "../src/agent-session.js";
import { COMPLETED_TICKET_CLEANUP_RETENTION_DAYS, DEFAULT_PROFILE_ID, KANBAN_LANES, LANE, LANES, ROLE_DEFAULTS, ROLE_TOOLS } from "../src/constants.js";
import { getIssueDiffs } from "../src/diffs.js";
import {
	PLAN_END,
	PLAN_REPORT_END,
	PLAN_REPORT_START,
	PLAN_START,
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
	buildFinalReviewerPrompt,
	buildMergerPrompt,
	buildSpecWriterPrompt,
	parseFinalReviewerOutput,
	parseMergerOutput,
	parsePlannerOutput,
} from "../src/prompts.js";
import { RpcAgentRunner } from "../src/rpc-runner.js";
import { createOrchestratorRuntime, parseOrchestratorEnv } from "../src/runtime.js";
import { OrchestratorScheduler } from "../src/scheduler.js";
import { renderQrSvg } from "../src/qr.js";
import {
	OrchestratorServer,
	directoryPickerCommandsForPlatform,
	directoryPickerUnavailableMessage,
	isAuthorized,
	normalizePickedDirectory,
	selectLanIpv4Address,
} from "../src/server.js";
import { IssueStore } from "../src/store.js";
import { renderDashboardHtml } from "../src/ui.js";
import { branchNameForIssue, commitIssueWorktree, ensureIssueWorkspace } from "../src/workspace.js";
import {
	approvePlan,
	approveReview,
	canRequestResume,
	isDependencyResolved,
	normalizeMetadata,
	requestPlanChanges,
	requestReviewChanges,
	resumeBlockedReason,
} from "../src/workflow.js";

const execFileAsync = promisify(execFile);

async function tempDir() {
	return fsp.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-"));
}

async function git(args, cwd) {
	return execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
}

function dashboardNotificationTestSource(html) {
	const laneDeclaration = html.match(/const LANE = .*?;\n/)?.[0];
	assert.ok(laneDeclaration, "dashboard script declares LANE");
	const start = html.indexOf("const HUMAN_INTERVENTION_LANES = new Set");
	const end = html.indexOf("function resetSpecWriterState()", start);
	assert.ok(start !== -1, "dashboard script declares notification state");
	assert.ok(end > start, "dashboard script keeps notification helpers before spec writer helpers");
	return laneDeclaration + html.slice(start, end);
}

function dashboardDraftTestSource(html) {
	const start = html.indexOf("let state = { issues: [], lanes: {} };");
	const end = html.indexOf("function populateLaneFilter()", start);
	assert.ok(start !== -1, "dashboard script declares mutable state");
	assert.ok(end > start, "dashboard script exposes load before DOM event bindings");
	return html.slice(start, end);
}

function dashboardCleanupTestSource(html) {
	return `${dashboardDraftTestSource(html)}\nglobalThis.__dashboardCleanup = { cleanCompletedTickets, updateCleanCompletedButton, get loading() { return cleanupCompletedLoading; } };\n`;
}

function dashboardDraftVmContext() {
	const elements = new Map();
	function classList() {
		const classes = new Set();
		return {
			add: (...names) => names.forEach((name) => classes.add(name)),
			remove: (...names) => names.forEach((name) => classes.delete(name)),
			contains: (name) => classes.has(name),
		};
	}
	const persistentElementIds = new Set(["detail", "status", "clean-completed"]);
	class FakeElement {
		constructor(id) {
			this.id = id;
			this.value = "";
			this.hidden = false;
			this.disabled = false;
			this.dataset = {};
			this.style = {};
			this.classList = classList();
			this.listeners = new Map();
			this.onclick = null;
			this._innerHTML = "";
		}
		set innerHTML(value) {
			this._innerHTML = String(value);
			if (this.id === "detail") replaceDetailElements(this._innerHTML);
		}
		get innerHTML() {
			return this._innerHTML;
		}
		addEventListener(type, handler) {
			const handlers = this.listeners.get(type) || [];
			handlers.push(handler);
			this.listeners.set(type, handlers);
		}
		dispatchEvent(event) {
			for (const handler of this.listeners.get(event.type) || []) {
				handler({ ...event, target: this, currentTarget: this });
			}
		}
		getBoundingClientRect() {
			return { width: 520 };
		}
		setAttribute(name, value) {
			this[name] = value;
		}
	}
	function replaceDetailElements(html) {
		for (const id of Array.from(elements.keys())) {
			if (!persistentElementIds.has(id)) elements.delete(id);
		}
		for (const match of html.matchAll(/\sid=(['"])(.*?)\1/g)) {
			elements.set(match[2], new FakeElement(match[2]));
		}
	}
	const detail = new FakeElement("detail");
	elements.set("detail", detail);
	elements.set("status", new FakeElement("status"));
	elements.set("clean-completed", new FakeElement("clean-completed"));
	const document = {
		body: { classList: classList() },
		documentElement: { clientWidth: 1200 },
		getElementById(id) {
			return elements.get(id) || null;
		},
		querySelector() {
			return null;
		},
		querySelectorAll() {
			return [];
		},
	};
	return {
		DEFAULT_PROFILE_ID,
		LANE,
		ROLE_DEFAULTS,
		THINKING_LEVELS: ["low", "medium", "high", "xhigh"],
		document,
		window: { innerWidth: 1200, matchMedia: () => ({ matches: false }) },
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		alert(message) {
			throw new Error(message);
		},
	};
}

function notificationVmContext({ permission, requestPermission, supported = true } = {}) {
	const button = { hidden: true, disabled: true };
	const notifications = [];
	let permissionState = permission ?? "default";
	let permissionRequests = 0;
	function MockNotification(title, options) {
		notifications.push({ title, options });
	}
	Object.defineProperty(MockNotification, "permission", {
		get: () => permissionState,
		set: (value) => { permissionState = value; },
	});
	MockNotification.requestPermission = async () => {
		permissionRequests += 1;
		const nextPermission = requestPermission ? await requestPermission(permissionState) : permissionState;
		if (nextPermission) permissionState = nextPermission;
		return permissionState;
	};
	const context = {
		DEFAULT_PROFILE_ID: "default",
		button,
		notifications,
		get permissionRequests() { return permissionRequests; },
		get permissionState() { return permissionState; },
		document: {
			getElementById(id) {
				return id === "enable-notifications" ? button : null;
			},
		},
		shortId(value) {
			const text = String(value || "");
			return text.length <= 32 ? text : text.slice(0, 14) + "..." + text.slice(-10);
		},
		compactPath(value) {
			return String(value || "");
		},
	};
	if (supported) {
		context.Notification = MockNotification;
		context.window = { Notification: MockNotification };
	} else {
		context.window = {};
	}
	return context;
}

function dashboardResumeTestSource(html) {
	const laneDeclaration = html.match(/const LANE = .*?;\n/)?.[0];
	assert.ok(laneDeclaration, "dashboard script declares LANE");
	const resumeHelpersStart = html.indexOf("function issueById(id)");
	const resumeHelpersEnd = html.indexOf("function issueState(issue)", resumeHelpersStart);
	const postResumeStart = html.indexOf("async function postResumeIssue(id)");
	const escapeStart = html.indexOf("function escapeHtml(value)", postResumeStart);
	const escapeEnd = html.indexOf("function renderInlineMarkdown(value)", escapeStart);
	assert.ok(resumeHelpersStart !== -1 && resumeHelpersEnd > resumeHelpersStart, "dashboard script declares resume helpers");
	assert.ok(postResumeStart !== -1 && escapeStart > postResumeStart && escapeEnd > escapeStart, "dashboard script declares resume action helpers");
	return [
		laneDeclaration,
		"let state = { issues: [], lanes: {} };\n",
		"const pendingResumeIssueIds = new Set();\n",
		html.slice(resumeHelpersStart, resumeHelpersEnd),
		html.slice(postResumeStart, escapeEnd),
		`\nglobalThis.__dashboardResume = {\n\tsetState(next) { state = next; },\n\tresumeEligibility,\n\tresumeDisabledReason,\n\trenderResumeAction,\n\tpostResumeIssue,\n\tisPending(id) { return pendingResumeIssueIds.has(id); },\n};\n`,
	].join("");
}

function dashboardAgentSessionTestSource(html) {
	const agentStart = html.indexOf("function agentSessionKey(issueId, runId)");
	const agentEnd = html.indexOf("function renderDetail()", agentStart);
	const timelineStart = html.indexOf("function renderTimeline(issue)");
	const timelineEnd = html.indexOf("function bindDetailActions(issue)", timelineStart);
	const eventStart = html.indexOf("function handleEventStreamMessage(message)");
	const eventEnd = html.indexOf("function updateCleanCompletedButton()", eventStart);
	const escapeStart = html.indexOf("function escapeHtml(value)");
	const escapeEnd = html.indexOf("function renderMarkdown(input)", escapeStart);
	assert.ok(agentStart !== -1 && agentEnd > agentStart, "dashboard script declares agent session helpers");
	assert.ok(timelineStart !== -1 && timelineEnd > timelineStart, "dashboard script declares timeline renderer");
	assert.ok(eventStart !== -1 && eventEnd > eventStart, "dashboard script declares event stream handler");
	assert.ok(escapeStart !== -1 && escapeEnd > escapeStart, "dashboard script declares markdown helpers");
	return [
		"const agentSessions = new Map();\nlet selectedTimelineRunId = null;\nlet selectedTimelineSessionMissing = false;\nlet selectedId = null;\nlet detailTab = 'agent';\nlet renderDetailCalls = 0;\nlet loadCalls = 0;\n",
		"function formatDate(value) { return value || 'unknown'; }\nfunction renderDetail() { renderDetailCalls += 1; }\nasync function load() { loadCalls += 1; }\n",
		html.slice(agentStart, agentEnd),
		html.slice(timelineStart, timelineEnd),
		html.slice(eventStart, eventEnd),
		html.slice(escapeStart, escapeEnd),
		`\nglobalThis.__dashboardAgentSession = {\n\tagentSessionKey,\n\tassembleAgentSessionForUi,\n\tloadAgentSession,\n\tcachedAgentSession,\n\trenderAgentSession,\n\trenderTimeline,\n\thandleEventStreamMessage,\n\tsetPayload(issueId, runId, payload) { agentSessions.set(agentSessionKey(issueId, runId), payload); },\n\tselectTimelineRun(runId) { selectedTimelineRunId = runId; selectedTimelineSessionMissing = false; },\n\tmarkTimelineMissing() { selectedTimelineSessionMissing = true; },\n\tsetSelected(issueId, tab = 'agent', runId = null) { selectedId = issueId; detailTab = tab; selectedTimelineRunId = runId; },\n\tget renderDetailCalls() { return renderDetailCalls; },\n\tget loadCalls() { return loadCalls; },\n};\n`,
	].join("");
}

test("token authorization accepts query, header, and bearer token", () => {
	assert.equal(isAuthorized("/?token=abc", {}, "abc"), true);
	assert.equal(isAuthorized("/", { "x-orchestrator-token": "abc" }, "abc"), true);
	assert.equal(isAuthorized("/", { authorization: "Bearer abc" }, "abc"), true);
	assert.equal(isAuthorized("/?token=wrong", {}, "abc"), false);
});

test("orchestrator env config defaults to localhost", () => {
	assert.deepEqual(parseOrchestratorEnv({}), { host: "127.0.0.1" });
});

test("orchestrator env config supports LAN binding shorthand", () => {
	assert.equal(parseOrchestratorEnv({ PI_ORCHESTRATOR_BIND_LAN: "true" }).host, "0.0.0.0");
	assert.equal(parseOrchestratorEnv({ PI_ORCHESTRATOR_BIND_LAN: "yes" }).host, "0.0.0.0");
	assert.equal(parseOrchestratorEnv({ PI_ORCHESTRATOR_BIND_LAN: "1" }).host, "0.0.0.0");
});

test("orchestrator env config host overrides LAN binding", () => {
	assert.equal(
		parseOrchestratorEnv({ PI_ORCHESTRATOR_BIND_LAN: "true", PI_ORCHESTRATOR_HOST: "192.168.1.50" }).host,
		"192.168.1.50",
	);
});

test("agent session assembler builds streamed assistant messages", () => {
	const session = assembleAgentSession([
		{ type: "message_start", messageId: "m1", at: "2026-05-12T00:00:00.000Z" },
		{ type: "message_update", messageId: "m1", delta: "Hello" },
		{ type: "message_update", messageId: "m1", assistantMessageEvent: { delta: " world" } },
	]);
	assert.equal(session.messages.length, 1);
	assert.equal(session.messages[0].content, "Hello world");
	assert.equal(session.messages[0].status, "streaming");
	assert.equal(session.incomplete, true);
});

test("agent session assembler finalizes from message_end message content", () => {
	const session = assembleAgentSession([
		{ type: "message_update", delta: "draft" },
		{ type: "message_end", message: { id: "final", role: "assistant", content: [{ type: "text", text: "final answer" }] } },
	]);
	assert.equal(session.messages.length, 1);
	assert.equal(session.messages[0].content, "final answer");
	assert.equal(session.messages[0].status, "complete");
});

test("agent session assembler handles Pi text_delta and text_end without duplicating snapshots", () => {
	const session = assembleAgentSession([
		{ type: "message_start", message: { id: "m-pi", role: "assistant", content: [] } },
		{
			type: "message_update",
			message: { id: "m-pi", role: "assistant", content: [{ type: "text", text: "Hel" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel", partial: { role: "assistant", content: [{ type: "text", text: "Hel" }] } },
		},
		{
			type: "message_update",
			message: { id: "m-pi", role: "assistant", content: [{ type: "text", text: "Hello" }] },
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo", partial: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
		},
		{
			type: "message_update",
			message: { id: "m-pi", role: "assistant", content: [{ type: "text", text: "Hello" }] },
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello", partial: { role: "assistant", content: [{ type: "text", text: "Hello" }] } },
		},
	]);
	assert.equal(session.messages.length, 1);
	assert.equal(session.messages[0].content, "Hello");
	assert.deepEqual(session.messages[0].eventTypes, ["message_start", "message_update", "message_update", "message_update"]);
});

test("agent session assembler tracks Pi RPC tool execution lifecycle aliases", () => {
	const session = assembleAgentSession([
		{ type: "tool_execution_start", toolExecutionId: "t1", toolName: "bash", input: { command: "echo hi" } },
		{ type: "tool_execution_update", toolExecutionId: "t1", partialResult: { content: [{ type: "text", text: "hi" }], isError: false } },
		{ type: "tool_execution_end", toolExecutionId: "t1", result: { content: [{ type: "text", text: "done" }], isError: false } },
	]);
	assert.equal(session.tools.length, 1);
	assert.equal(session.tools[0].id, "t1");
	assert.equal(session.tools[0].name, "bash");
	assert.match(session.tools[0].input, /echo hi/);
	assert.deepEqual(session.tools[0].updates, [{ at: null, text: "hi" }]);
	assert.equal(session.tools[0].output, "done");
	assert.equal(session.tools[0].status, "complete");
});

test("agent session assembler marks Pi RPC isError tool results as errors", () => {
	const session = assembleAgentSession([
		{ type: "tool_execution_start", toolExecutionId: "t2", toolName: "read" },
		{ type: "tool_execution_update", toolExecutionId: "t2", partialResult: { content: [{ type: "text", text: "permission denied" }], isError: true } },
		{ type: "tool_execution_end", toolExecutionId: "t2", result: { content: [{ type: "text", text: "permission denied" }], isError: true } },
	]);
	assert.equal(session.tools.length, 1);
	assert.equal(session.tools[0].updates[0].text, "permission denied");
	assert.equal(session.tools[0].output, "permission denied");
	assert.equal(session.tools[0].status, "error");
	assert.match(session.tools[0].error, /Tool returned an error/);
});

test("agent session assembler handles malformed and interrupted streams", () => {
	const session = assembleAgentSession([
		null,
		{ type: "message_update", text: "partial" },
		{ type: "tool_call_end", name: "read", error: "missing file" },
	]);
	assert.equal(session.ignoredCount, 1);
	assert.equal(session.messages[0].content, "partial");
	assert.equal(session.messages[0].incomplete, true);
	assert.equal(session.tools[0].status, "error");
	assert.equal(session.incomplete, true);
});

test("agent session assembler keeps independent run histories distinguishable", () => {
	const first = assembleAgentSession([{ type: "message_end", message: { content: [{ type: "text", text: "run one" }] } }]);
	const second = assembleAgentSession([{ type: "message_end", message: { content: [{ type: "text", text: "run two" }] } }]);
	assert.equal(first.messages[0].content, "run one");
	assert.equal(second.messages[0].content, "run two");
});

test("orchestrator env config parses a valid port", () => {
	assert.deepEqual(parseOrchestratorEnv({ PI_ORCHESTRATOR_PORT: "8123" }), { host: "127.0.0.1", port: 8123 });
});

test("orchestrator constants distinguish valid lanes from Kanban lanes", () => {
	assert.equal(LANE.BACKLOG, "Backlog");
	assert.equal(LANES.includes(LANE.BACKLOG), true);
	assert.equal(KANBAN_LANES.includes(LANE.BACKLOG), false);
	assert.deepEqual(KANBAN_LANES, [
		LANE.CREATED,
		LANE.PLANNING,
		LANE.PLAN_REVIEW,
		LANE.IN_PROGRESS,
		LANE.IN_REVIEW,
		LANE.COMPLETED,
	]);
});

test("spec writer role has read-only tool and default model config", () => {
	assert.equal(ROLE_TOOLS["spec-writer"], "read,grep,find,ls");
	assert.deepEqual(ROLE_DEFAULTS["spec-writer"], {
		model: ROLE_DEFAULTS.planner.model,
		thinking: "medium",
	});
});

test("LAN address selection returns first external IPv4 address", () => {
	assert.equal(
		selectLanIpv4Address({
			lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
			utun: [{ address: "fd00::1", family: "IPv6", internal: false }],
			en0: [{ address: "192.168.1.23", family: "IPv4", internal: false }],
			en1: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
		}),
		"192.168.1.23",
	);
	assert.equal(selectLanIpv4Address({ en0: [{ address: "10.0.0.5", family: 4, internal: false }] }), "10.0.0.5");
});

test("directory picker command selection supports desktop platforms", () => {
	const macos = directoryPickerCommandsForPlatform("darwin");
	assert.equal(macos.length, 1);
	assert.equal(macos[0].command, "osascript");
	assert.match(macos[0].args.join(" "), /choose folder/);

	const windows = directoryPickerCommandsForPlatform("win32");
	assert.equal(windows.length, 1);
	assert.equal(windows[0].command, "powershell.exe");
	assert.ok(windows[0].args.includes("-STA"));
	assert.match(windows[0].args.join(" "), /FolderBrowserDialog/);
	assert.deepEqual(windows[0].cancelExitCodes, [1223]);

	const linux = directoryPickerCommandsForPlatform("linux");
	assert.deepEqual(linux.map((command) => command.command), ["zenity", "kdialog"]);
	assert.deepEqual(linux[0].args.slice(0, 2), ["--file-selection", "--directory"]);
	assert.deepEqual(linux[1].args.slice(0, 2), ["--getexistingdirectory", "."]);
	assert.deepEqual(linux.map((command) => command.cancelExitCodes), [[1], [1]]);

	assert.deepEqual(directoryPickerCommandsForPlatform("freebsd"), []);
});

test("directory picker normalization trims output and preserves filesystem roots", () => {
	assert.equal(normalizePickedDirectory("/tmp/project/\n"), "/tmp/project");
	assert.equal(normalizePickedDirectory("/"), "/");
	assert.equal(normalizePickedDirectory("C:\\Users\\me\\"), "C:\\Users\\me");
	assert.equal(normalizePickedDirectory("C:\\"), "C:\\");
	assert.equal(normalizePickedDirectory("\\\\server\\share\\"), "\\\\server\\share\\");
	assert.equal(normalizePickedDirectory("\\\\server\\share\\project\\"), "\\\\server\\share\\project");
	assert.throws(() => normalizePickedDirectory("  \n"), /Directory selection cancelled\./);
});

test("directory picker unavailable messages are clear", () => {
	assert.match(directoryPickerUnavailableMessage("linux"), /No supported Linux directory picker was found \(tried zenity or kdialog\)/);
	assert.match(directoryPickerUnavailableMessage("openbsd"), /Native directory picking is not supported on openbsd/);
});

test("server module imports without a qrcode package dependency", async () => {
	const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const root = await tempDir();
	const tempExtensionRoot = path.join(root, "orchestrator");
	await fsp.cp(path.join(extensionRoot, "src"), path.join(tempExtensionRoot, "src"), { recursive: true });
	await fsp.copyFile(path.join(extensionRoot, "package.json"), path.join(tempExtensionRoot, "package.json"));

	const packageJson = JSON.parse(await fsp.readFile(path.join(tempExtensionRoot, "package.json"), "utf8"));
	assert.equal(packageJson.dependencies?.qrcode, undefined);
	assert.doesNotMatch(await fsp.readFile(path.join(tempExtensionRoot, "src", "server.js"), "utf8"), /import\(["']qrcode["']\)/);

	const moduleUrl = pathToFileURL(path.join(tempExtensionRoot, "src", "server.js"));
	const module = await import(`${moduleUrl.href}?cacheBust=${Date.now()}`);

	assert.equal(typeof module.OrchestratorServer, "function");
});

test("local QR renderer returns an SVG for a LAN dashboard URL", () => {
	const svg = renderQrSvg("http://192.168.1.23:8123/?token=0123456789abcdef0123456789abcdef0123456789abcdef");

	assert.match(svg, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
	assert.match(svg, /viewBox="0 0 \d+ \d+"/);
	assert.match(svg, /<rect width="100%" height="100%" fill="#fff"\/>/);
	assert.match(svg, /<path fill="#000" d="M\d+,\d+h\d+v1h-\d+z/);
	assert.throws(() => renderQrSvg(""), /must not be empty/);
	assert.throws(() => renderQrSvg("x".repeat(214)), /too large/);
});

test("dashboard renderer injects runtime data", async () => {
	const html = await renderDashboardHtml("test-token");

	assert.match(html, /const TOKEN = "test-token";/);
	assert.match(html, /const LANES = \["Created","Planning"/);
	assert.match(html, /"Backlog"/);
	assert.match(html, /const KANBAN_LANES = \["Created","Planning"/);
	assert.match(html, /const LANE = \{"CREATED":"Created"/);
	assert.match(html, /"BACKLOG":"Backlog"/);
	assert.match(html, /const ROLE_DEFAULTS = \{"planner":/);
	assert.match(html, /const THINKING_LEVELS = \["low","medium","high","xhigh"\];/);
	assert.match(html, /const DEFAULT_PROFILE_ID = "default";/);
	assert.match(html, /id="create-drawer"/);
	assert.match(html, /id="kanban-tab"/);
	assert.match(html, /id="backlog-tab"/);
	assert.match(html, />Kanban<\/button>/);
	assert.match(html, />Backlog<\/button>/);
	assert.match(html, /id="backlog-view"/);
	assert.match(html, /Add to Backlog/);
	assert.match(html, /Edit Issue/);
	assert.match(html, /Send to Agent/);
	assert.match(html, /board\.hidden = activeView !== "kanban";/);
	assert.match(html, /backlog\.hidden = activeView !== "backlog";/);
	assert.match(html, /if \(activeView !== "kanban"\) return;\s*for \(const lane of KANBAN_LANES\)/);
	assert.match(html, /for \(const lane of KANBAN_LANES\)/);
	assert.match(html, /const KANBAN_LANES =/);
	assert.match(html, /id="enable-notifications"/);
	assert.match(html, /id="enable-notifications" class="secondary" hidden disabled/);
	assert.match(html, /id="clean-completed" class="secondary clean-completed-button"/);
	assert.match(html, /Clean completed tickets/);
	assert.match(html, /let cleanupCompletedLoading = false;/);
	assert.match(html, /async function cleanCompletedTickets\(\)/);
	assert.match(html, /api\("\/api\/issues\/clean-completed", \{ method: "POST", body: "\{\}" \}\)/);
	assert.match(html, /No old completed tickets to clean\./);
	assert.match(html, /Cleanup failed:/);
	assert.match(html, /document\.getElementById\("clean-completed"\)\.addEventListener\("click"/);
	assert.match(html, /Notification\.permission/);
	assert.match(html, /Notification\.requestPermission\(\)/);
	assert.match(html, /new Notification\(/);
	assert.match(html, /const HUMAN_INTERVENTION_LANES = new Set\(\[LANE\.PLAN_REVIEW, LANE\.IN_REVIEW\]\);/);
	assert.match(html, /function syncHumanInterventionNotifications\(nextState\)/);
	assert.match(html, /id="open-share"/);
	assert.match(html, /id="share-dialog"/);
	assert.match(html, /id="share-qr"/);
	assert.match(html, /id="linkedDirectory" name="linkedDirectory" list="linkedDirectorySuggestions"/);
	assert.match(html, /id="linkedDirectoryQuickSelect"/);
	assert.match(html, /class="secondary desktop-directory-picker" id="pick-directory"/);
	assert.match(html, /id="linkedDirectorySuggestions"/);
	assert.match(html, /id="spec-wand"/);
	assert.match(html, /Improve spec with Spec Writer/);
	assert.match(html, /id="improved-spec-container" hidden/);
	assert.match(html, />Improved Spec<\/h3>/);
	assert.match(html, /id="accept-improved-spec"/);
	assert.match(html, /id="reject-improved-spec"/);
	assert.match(html, /id="refine-improved-spec"/);
	assert.match(html, /class="spinner"/);
	assert.match(html, /\/api\/spec\/improve/);
	assert.match(html, /function resetSpecWriterState\(\)/);
	assert.match(html, /function setSpecWriterLoading\(loading\)/);
	assert.match(html, /function renderImprovedSpec\(\)/);
	assert.match(html, /function linkedDirectoryChoices\(\)/);
	assert.match(html, /function populateLinkedDirectoryOptions\(\)/);
	assert.match(html, /linkedDirectory"\)\.addEventListener\("input"/);
	assert.match(html, /linkedDirectoryQuickSelect"\)\.addEventListener\("change"/);
	assert.match(html, /const pickDirectoryButton = document\.getElementById\("pick-directory"\);/);
	assert.match(html, /style\?\.display === "none"/);
	assert.match(html, /\/api\/share/);
	assert.match(html, /\/api\/share\.svg/);
	assert.match(html, /function shareSvgUrl\(cacheKey = Date\.now\(\)\)/);
	assert.match(html, /"&_=" \+ encodeURIComponent\(cacheKey\)/);
	assert.match(html, /qr\.alt = "Loading dashboard QR code…";/);
	assert.match(html, /qr\.onerror = \(\) => \{/);
	assert.match(html, /QR code failed to load\. Use the URL above or refresh the dialog\./);
	assert.match(html, /<div class="brand-mark" aria-label="Pi">π<\/div>/);
	assert.doesNotMatch(html, /<div class="brand-mark">PI<\/div>/);
	assert.match(html, /const feedbackDraftsByIssueId = new Map\(\);/);
	assert.match(html, /function captureFeedbackDraft\(issueId = currentFeedbackDraftKey\(\)\)/);
	assert.match(html, /if \(feedback\) feedback\.value = feedbackDraft\(issue\.id\);/);
	assert.match(html, /feedback\.addEventListener\("input", \(\) => feedbackDraftsByIssueId\.set\(issue\.id, feedback\.value\)\)/);
	assert.match(html, /const minimizedIssueIds = new Set\(\);/);
	assert.match(html, /const pendingResumeIssueIds = new Set\(\);/);
	assert.match(html, /let issueLaneById = new Map\(\);/);
	assert.match(html, /function minimizedTitle\(title\)/);
	assert.match(html, /function syncCompletedTicketMinimization\(nextState\)/);
	assert.match(html, /issue\.lane === LANE\.COMPLETED && previousLane !== LANE\.COMPLETED/);
	assert.match(html, /minimizedIssueIds\.add\(issue\.id\);/);
	assert.match(html, /issueLaneById = nextIssueLaneById;/);
	assert.match(html, /const nextState = await api\("\/api\/state"\);/);
	assert.match(html, /const nextState = await api\("\/api\/state"\);\s*captureFeedbackDraft\(\);\s*syncCompletedTicketMinimization\(nextState\);\s*syncHumanInterventionNotifications\(nextState\);\s*state = nextState;/);
	const cardActionsStart = html.indexOf("\"<div class='card-actions'>\" +");
	const cardHeadBeforeActions = html.lastIndexOf("\"<div class='card-head'>\" +", cardActionsStart);
	const badgeInCardActions = html.indexOf("\"<span class='badge \" + badgeClass(issue) + \"'>\" + escapeHtml(stateLabel(issue)) + \"</span>\" +", cardActionsStart);
	const toggleInCardActions = html.indexOf("toggleButton +", badgeInCardActions);
	const expandedTitleAfterActions = html.indexOf("\"<div class='card-title'>\" + escapeHtml(issue.title) + \"</div>\" +", toggleInCardActions);
	const expandedHeadClose = html.lastIndexOf("\"</div>\" +", expandedTitleAfterActions);
	assert.ok(cardHeadBeforeActions !== -1, "expanded card renders an actions row");
	assert.ok(cardActionsStart !== -1, "expanded card renders a card actions container");
	assert.ok(badgeInCardActions !== -1, "expanded card actions render the state badge");
	assert.ok(toggleInCardActions !== -1, "expanded card actions render the minimize button");
	assert.ok(badgeInCardActions < toggleInCardActions, "expanded card actions render the badge before the minimize button");
	assert.ok(expandedHeadClose > toggleInCardActions, "expanded card closes the actions row before rendering the title");
	assert.ok(expandedTitleAfterActions > expandedHeadClose, "expanded card title renders outside and after the card head");
	const minimizedBranchStart = html.indexOf("if (minimized) {");
	const minimizedHeadStart = html.indexOf("\"<div class='card-head'>\" +", minimizedBranchStart);
	const minimizedToggle = html.indexOf("toggleButton +", minimizedHeadStart);
	const minimizedHeadClose = html.indexOf("\"</div>\" +", minimizedToggle);
	const minimizedTitleAfterHead = html.indexOf("\"<div class='card-title'>\" + escapeHtml(minimizedTitle(issue.title)) + \"</div>\"", minimizedHeadClose);
	assert.ok(minimizedToggle > minimizedHeadStart, "minimized card renders the restore button in the card head");
	assert.ok(minimizedTitleAfterHead > minimizedHeadClose, "minimized card title renders outside and after the card head");
	assert.match(html, /data-minimize-toggle/);
	assert.match(html, /aria-expanded='/);
	assert.match(html, /Resume from last session/);
	assert.match(html, /function resumeEligibility\(issue\)/);
	assert.match(html, /function resumeDisabledReason\(issue\)/);
	assert.match(html, /async function postResumeIssue\(id\)/);
	assert.match(html, /pendingResumeIssueIds\.has\(id\)/);
	assert.match(html, /api\("\/api\/issues\/" \+ encodeURIComponent\(id\) \+ "\/resume"/);
	assert.match(html, /Resume request failed:/);
	assert.match(html, /data-resume-issue=/);
	assert.match(html, /diffs-section/);
	assert.match(html, /function loadDiffsForSelectedIssue\(issue = issueById\(selectedId\), options = \{\}\)/);
	assert.match(html, /data-diff-section-toggle/);
	assert.match(html, /data-diff-file/);
	assert.match(html, /renderUnifiedDiff/);
	assert.match(html, /data-resize-panel="create"/);
	assert.match(html, /data-resize-panel="detail"/);
	assert.match(html, /function applyCreateDrawerWidth\(\)/);
	assert.match(html, /function applyDetailPanelWidth\(\)/);
	assert.match(html, /Agent Output/);
	assert.match(html, /data-view-run/);
	assert.doesNotMatch(html, /__(TOKEN|LANES|KANBAN_LANES|LANE|ROLE_DEFAULTS|THINKING_LEVELS|DEFAULT_PROFILE_ID)_JSON__/);
});

test("dashboard renders agent sessions and timeline history states", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = {
		api: async () => ({ issueId: "PI-agent", runId: "run-2", events: [{ type: "message_update", messageId: "m2", delta: "persisted " }] }),
	};
	vm.runInNewContext(dashboardAgentSessionTestSource(html), context);
	const ui = context.__dashboardAgentSession;
	const issue = { id: "PI-agent", recentEvents: [{ type: "agent_run_started", at: "2026-05-12T00:00:00.000Z", runId: "run-1" }] };

	assert.match(ui.renderAgentSession(issue, null), /No agent session is active/);
	ui.setPayload(issue.id, "missing-run", { issueId: issue.id, runId: "missing-run", error: "not found", events: [], session: { items: [] } });
	assert.match(ui.renderAgentSession(issue, "missing-run"), /Agent session history is unavailable: not found/);
	ui.setPayload(issue.id, "run-1", {
		issueId: issue.id,
		runId: "run-1",
		events: [],
		session: ui.assembleAgentSessionForUi([
			{ type: "message_start", messageId: "m1" },
			{ type: "message_update", messageId: "m1", assistantMessageEvent: { content: "Hello " } },
			{ type: "message_end", messageId: "m1", message: { content: [{ type: "text", text: "Hello final" }] } },
			{ type: "tool_execution_start", toolExecutionId: "t1", toolName: "bash", input: { command: "echo hi" } },
			{ type: "tool_execution_update", toolExecutionId: "t1", partialResult: { content: [{ type: "text", text: "hi" }] } },
			{ type: "tool_execution_end", toolExecutionId: "t1", result: { content: [{ type: "text", text: "done" }] } },
		]),
	});

	const rendered = ui.renderAgentSession(issue, "run-1");
	assert.match(rendered, /Live session/);
	assert.match(rendered, /agent-message/);
	assert.match(rendered, /Hello final/);
	assert.match(rendered, /tool-call-card/);
	assert.match(rendered, /echo hi/);

	const piStream = ui.assembleAgentSessionForUi([
		{ type: "message_start", message: { id: "m-pi", role: "assistant", content: [] } },
		{ type: "message_update", message: { id: "m-pi", role: "assistant", content: [{ type: "text", text: "Hi" }] }, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" } },
		{ type: "message_update", message: { id: "m-pi", role: "assistant", content: [{ type: "text", text: "Hi" }] }, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hi" } },
	]);
	assert.equal(piStream.items[0].content, "Hi");

	ui.setPayload(issue.id, "run-2", { issueId: issue.id, runId: "run-2", events: [{ type: "message_update", messageId: "m2", delta: "live" }], session: { items: [] }, loadedFromApi: false });
	const loaded = await ui.loadAgentSession(issue.id, "run-2");
	assert.equal(loaded.loadedFromApi, true);
	assert.equal(ui.cachedAgentSession(issue.id, "run-2").session.items[0].content, "persisted live");

	assert.match(ui.renderTimeline(issue), /View session/);
	ui.selectTimelineRun("run-1");
	assert.match(ui.renderTimeline(issue), /Persisted session/);
	ui.markTimelineMissing();
	assert.match(ui.renderTimeline(issue), /No persisted history was found/);
});

test("dashboard event stream ingests live run events without full reload", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = { api: async () => ({ issueId: "PI-agent", runId: "run-live", events: [], session: { items: [] } }) };
	vm.runInNewContext(dashboardAgentSessionTestSource(html), context);
	const ui = context.__dashboardAgentSession;

	ui.setSelected("PI-agent", "agent");
	ui.handleEventStreamMessage({
		data: JSON.stringify({
			type: "store",
			event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: "Hello" } },
		}),
	});
	assert.equal(ui.loadCalls, 0);
	assert.equal(ui.renderDetailCalls, 1);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Hello");

	ui.setSelected("PI-agent", "timeline", "run-live");
	ui.handleEventStreamMessage({
		data: JSON.stringify({
			type: "store",
			event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: " world" } },
		}),
	});
	assert.equal(ui.renderDetailCalls, 2);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Hello world");

	ui.handleEventStreamMessage({ data: JSON.stringify({ type: "store", event: { type: "metadata_updated", id: "PI-agent" } }) });
	assert.equal(ui.loadCalls, 1);
	ui.handleEventStreamMessage({ data: "not json" });
	assert.equal(ui.loadCalls, 2);
});

test("dashboard preserves unsent feedback drafts across unrelated ticket refreshes", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardDraftVmContext();
	const result = await vm.runInNewContext(`${dashboardDraftTestSource(html)}
		renderBoard = () => {};
		syncHumanInterventionNotifications = () => {};
		renderDiffsSection = () => "";
		bindDiffActions = () => {};
		loadDiffsForSelectedIssue = async () => {};
		activeMergeForIssue = () => null;
		getDependencyIssueId = () => "";
		hasUnresolvedDependency = () => false;
		dependencyDisplay = () => "none";
		(async () => {
			const selectedIssue = {
				id: "PI-A",
				title: "Selected ticket",
				lane: LANE.PLAN_REVIEW,
				updatedAt: "2026-05-11T00:00:00.000Z",
				comments: [{ createdAt: "2026-05-11T00:01:00.000Z", author: "human", phase: "general", text: "submitted comment" }],
			};
			state = { issues: [
				selectedIssue,
				{ id: "PI-B", title: "Other worker ticket", lane: LANE.IN_PROGRESS, updatedAt: "2026-05-11T00:00:00.000Z", comments: [] },
			], lanes: {} };
			selectedId = "PI-A";
			detailTab = "comments";
			renderDetail();
			const feedback = document.getElementById("feedback");
			feedback.value = "keep this local draft";
			feedback.dispatchEvent({ type: "input" });
			api = async (apiPath) => {
				if (apiPath !== "/api/state") throw new Error("unexpected API path " + apiPath);
				return { issues: [
					{ ...selectedIssue },
					{ id: "PI-B", title: "Other worker ticket", lane: LANE.IN_REVIEW, updatedAt: "2026-05-11T00:02:00.000Z", comments: [] },
				], lanes: {} };
			};
			await load();
			return {
				feedbackValue: document.getElementById("feedback").value,
				draftValue: feedbackDraft("PI-A"),
				detailHtml: document.getElementById("detail").innerHTML,
			};
		})()
	`, context);

	assert.equal(result.feedbackValue, "keep this local draft");
	assert.equal(result.draftValue, "keep this local draft");
	assert.match(result.detailHtml, /submitted comment/);
});

test("dashboard clears only consumed feedback drafts after successful submissions", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardDraftVmContext();
	const result = await vm.runInNewContext(`${dashboardDraftTestSource(html)}
		renderBoard = () => {};
		syncHumanInterventionNotifications = () => {};
		renderDiffsSection = () => "";
		bindDiffActions = () => {};
		loadDiffsForSelectedIssue = async () => {};
		activeMergeForIssue = () => null;
		getDependencyIssueId = () => "";
		hasUnresolvedDependency = () => false;
		dependencyDisplay = () => "none";
		(async () => {
			state = { issues: [
				{ id: "PI-A", title: "Selected ticket", lane: LANE.PLAN_REVIEW, comments: [] },
				{ id: "PI-B", title: "Unrelated ticket", lane: LANE.IN_PROGRESS, comments: [] },
			], lanes: {} };
			selectedId = "PI-A";
			renderDetail();
			const feedback = document.getElementById("feedback");
			feedback.value = "  please revise the plan  ";
			feedback.dispatchEvent({ type: "input" });
			feedbackDraftsByIssueId.set("PI-B", "unrelated draft");
			const calls = [];
			api = async (apiPath, options = {}) => {
				calls.push({ apiPath, body: options.body ? JSON.parse(options.body) : null });
				if (apiPath === "/api/state") return state;
				return {};
			};
			await postAction("PI-A", "request-plan-changes", { text: feedbackText() });
			return {
				feedbackValue: document.getElementById("feedback").value,
				selectedDraft: feedbackDraft("PI-A"),
				otherDraft: feedbackDraft("PI-B"),
				calls,
			};
		})()
	`, context);

	assert.equal(result.feedbackValue, "");
	assert.equal(result.selectedDraft, "");
	assert.equal(result.otherDraft, "unrelated draft");
	assert.equal(result.calls[0].apiPath, "/api/issues/PI-A/request-plan-changes");
	assert.deepEqual(JSON.parse(JSON.stringify(result.calls[0].body)), { text: "please revise the plan" });
	assert.equal(result.calls[1].apiPath, "/api/state");
});

test("dashboard clean completed tickets action calls cleanup endpoint and reloads", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardDraftVmContext();
	const result = await vm.runInNewContext(`${dashboardCleanupTestSource(html)}
		(async () => {
			const calls = [];
			let loadCalls = 0;
			api = async (apiPath, options = {}) => {
				calls.push({ apiPath, options });
				return { cleanedCount: 2, cleanedIds: ["PI-old-a", "PI-old-b"], retentionDays: 30 };
			};
			load = async () => { loadCalls += 1; };
			await cleanCompletedTickets();
			return {
				calls,
				loadCalls,
				status: document.getElementById("status").textContent,
				buttonDisabled: document.getElementById("clean-completed").disabled,
				buttonText: document.getElementById("clean-completed").textContent,
				loading: __dashboardCleanup.loading,
			};
		})()
	`, context);

	assert.equal(result.calls.length, 1);
	assert.equal(result.calls[0].apiPath, "/api/issues/clean-completed");
	assert.equal(result.calls[0].options.method, "POST");
	assert.equal(result.calls[0].options.body, "{}");
	assert.equal(result.loadCalls, 1);
	assert.equal(result.status, "Cleaned 2 completed tickets.");
	assert.equal(result.buttonDisabled, false);
	assert.equal(result.buttonText, "Clean completed tickets");
	assert.equal(result.loading, false);
});

test("dashboard clean completed tickets action handles nothing-to-clean and failures", async () => {
	const html = await renderDashboardHtml("test-token");
	const nothingContext = dashboardDraftVmContext();
	const nothing = await vm.runInNewContext(`${dashboardCleanupTestSource(html)}
		(async () => {
			let loadCalls = 0;
			api = async () => ({ cleanedCount: 0, cleanedIds: [], retentionDays: 30 });
			load = async () => { loadCalls += 1; };
			await cleanCompletedTickets();
			return { loadCalls, status: document.getElementById("status").textContent };
		})()
	`, nothingContext);
	assert.equal(nothing.loadCalls, 1);
	assert.equal(nothing.status, "No old completed tickets to clean.");

	const failureContext = dashboardDraftVmContext();
	const failure = await vm.runInNewContext(`${dashboardCleanupTestSource(html)}
		(async () => {
			let loadCalls = 0;
			api = async () => { throw new Error("disk is unavailable"); };
			load = async () => { loadCalls += 1; };
			await cleanCompletedTickets();
			return {
				loadCalls,
				status: document.getElementById("status").textContent,
				buttonDisabled: document.getElementById("clean-completed").disabled,
				loading: __dashboardCleanup.loading,
			};
		})()
	`, failureContext);
	assert.equal(failure.loadCalls, 0);
	assert.equal(failure.status, "Cleanup failed: disk is unavailable");
	assert.equal(failure.buttonDisabled, false);
	assert.equal(failure.loading, false);
});

test("dashboard resume helpers enable and disable blocked ticket actions", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = {
		renderBoard() {},
		renderDetail() {},
		api: async () => ({}),
		load: async () => {},
		alert() {},
	};
	vm.runInNewContext(dashboardResumeTestSource(html), context);
	const resumable = {
		id: "PI-resumable",
		title: "Blocked with session",
		lane: LANE.IN_PROGRESS,
		automation: { paused: true, error: "Worker stopped.", activeRunId: null },
		dependencies: { issueId: null, resolvedAt: null },
		resume: { canResume: true, runId: "worker-old", sessionFile: "/tmp/session.jsonl", reason: "" },
	};
	const missingSession = {
		...resumable,
		id: "PI-missing",
		resume: { canResume: false, runId: null, sessionFile: null, reason: "The last worker session file is unavailable." },
	};
	const dependencyBlocked = {
		...resumable,
		id: "PI-dependency",
		automation: { paused: false, error: null, activeRunId: null },
		dependencies: { issueId: "PI-dep", resolvedAt: null },
		resume: { canResume: false, reason: "This ticket is waiting on an unresolved dependency." },
	};
	const completed = { ...resumable, id: "PI-done", lane: LANE.COMPLETED };
	context.__dashboardResume.setState({ issues: [resumable, missingSession, dependencyBlocked, completed, { id: "PI-dep", lane: LANE.IN_REVIEW }] });

	const eligibility = context.__dashboardResume.resumeEligibility(resumable);
	assert.equal(eligibility.visible, true);
	assert.equal(eligibility.canResume, true);
	assert.equal(eligibility.pending, false);
	assert.equal(eligibility.reason, "");
	assert.match(context.__dashboardResume.renderResumeAction(resumable), /Resume from last session/);
	assert.doesNotMatch(context.__dashboardResume.renderResumeAction(resumable), /disabled/);
	assert.match(context.__dashboardResume.renderResumeAction(missingSession), /disabled/);
	assert.match(context.__dashboardResume.renderResumeAction(missingSession), /last worker session file is unavailable/);
	assert.match(context.__dashboardResume.renderResumeAction(dependencyBlocked), /disabled/);
	assert.match(context.__dashboardResume.renderResumeAction(dependencyBlocked), /unresolved dependency/);
	assert.equal(context.__dashboardResume.renderResumeAction(completed), "");
});

test("dashboard resume request prevents duplicates and reloads on success", async () => {
	const html = await renderDashboardHtml("test-token");
	let releaseApi;
	const apiDone = new Promise((resolve) => { releaseApi = resolve; });
	const calls = [];
	let loadCalls = 0;
	let renderBoardCalls = 0;
	let renderDetailCalls = 0;
	const alerts = [];
	const context = {
		renderBoard() { renderBoardCalls += 1; },
		renderDetail() { renderDetailCalls += 1; },
		api: async (url, options) => {
			calls.push({ url, options });
			await apiDone;
			return { metadata: { id: "PI-resumable" } };
		},
		load: async () => { loadCalls += 1; },
		alert: (message) => alerts.push(message),
	};
	vm.runInNewContext(dashboardResumeTestSource(html), context);

	const first = context.__dashboardResume.postResumeIssue("PI-resumable");
	await Promise.resolve();
	const second = context.__dashboardResume.postResumeIssue("PI-resumable");
	await Promise.resolve();

	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "/api/issues/PI-resumable/resume");
	assert.equal(calls[0].options.method, "POST");
	assert.equal(calls[0].options.body, "{}");
	assert.equal(context.__dashboardResume.isPending("PI-resumable"), true);
	releaseApi();
	await Promise.all([first, second]);
	assert.equal(loadCalls, 1);
	assert.equal(alerts.length, 0);
	assert.equal(context.__dashboardResume.isPending("PI-resumable"), false);
	assert.ok(renderBoardCalls >= 2);
	assert.ok(renderDetailCalls >= 2);
});

test("dashboard resume request surfaces failures and leaves retry available", async () => {
	const html = await renderDashboardHtml("test-token");
	const alerts = [];
	const context = {
		renderBoard() {},
		renderDetail() {},
		api: async () => { throw new Error("The last worker session file is unavailable."); },
		load: async () => assert.fail("failed resume should not reload state"),
		alert: (message) => alerts.push(message),
	};
	vm.runInNewContext(dashboardResumeTestSource(html), context);

	await context.__dashboardResume.postResumeIssue("PI-missing");

	assert.equal(context.__dashboardResume.isPending("PI-missing"), false);
	assert.equal(alerts.length, 1);
	assert.match(alerts[0], /Resume request failed: The last worker session file is unavailable\./);
});

test("dashboard notification helper notifies only on human-intervention transitions", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = notificationVmContext({ permission: "granted" });
	const result = await vm.runInNewContext(`${dashboardNotificationTestSource(html)}
		(async () => {
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the plan", lane: LANE.PLAN_REVIEW, linkedDirectory: "/tmp/project" }
			] });
			const afterBaseline = notifications.length;
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the plan", lane: LANE.PLAN_REVIEW, linkedDirectory: "/tmp/project" }
			] });
			const afterDuplicate = notifications.length;
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the plan", lane: LANE.IN_PROGRESS, linkedDirectory: "/tmp/project" },
				{ id: "PI-ignored", title: "Still working", lane: LANE.CREATED }
			] });
			const afterNonHuman = notifications.length;
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the plan", lane: LANE.PLAN_REVIEW, linkedDirectory: "/tmp/project" }
			] });
			const afterReenterPlanReview = notifications.length;
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the implementation", lane: LANE.IN_REVIEW, git: { branchName: "feature/review" } }
			] });
			const afterEnterImplementationReview = notifications.length;
			syncHumanInterventionNotifications({ issues: [
				{ id: "PI-202605110001-very-long-ticket-id-for-shortening", title: "Review the implementation", lane: LANE.IN_REVIEW, git: { branchName: "feature/review" } }
			] });
			return { afterBaseline, afterDuplicate, afterNonHuman, afterReenterPlanReview, afterEnterImplementationReview, finalCount: notifications.length, notifications };
		})()
	`, context);

	assert.equal(result.afterBaseline, 0, "initial load establishes a baseline without notification bursts");
	assert.equal(result.afterDuplicate, 0, "polling while staying in the same human step is suppressed");
	assert.equal(result.afterNonHuman, 0, "non-human lanes do not notify");
	assert.equal(result.afterReenterPlanReview, 1, "leaving and re-entering plan review notifies");
	assert.equal(result.afterEnterImplementationReview, 2, "transitioning into implementation review notifies");
	assert.equal(result.finalCount, 2, "remaining in implementation review does not spam duplicates");
	assert.equal(result.notifications[0].title, "Ticket needs attention");
	assert.match(result.notifications[0].options.body, /Step: Plan in review/);
	assert.match(result.notifications[0].options.tag, /^orchestrator:PI-202605110001-very-long-ticket-id-for-shortening:Plan in review$/);
	assert.match(result.notifications[1].options.body, /Branch: feature\/review/);
});

test("dashboard notification permission states are graceful", async () => {
	const html = await renderDashboardHtml("test-token");
	const source = dashboardNotificationTestSource(html);

	const grantedContext = notificationVmContext({ permission: "granted" });
	const granted = await vm.runInNewContext(`${source}
		(async () => {
			const state = refreshNotificationPermissionUi();
			const shown = showTicketNotification({ id: "PI-granted", title: "Ready", lane: LANE.IN_REVIEW }, LANE.IN_REVIEW);
			return { state, button, shown, notifications };
		})()
	`, grantedContext);
	assert.equal(granted.state, "granted");
	assert.equal(granted.button.hidden, true);
	assert.equal(granted.shown, true);
	assert.equal(granted.notifications.length, 1);

	const deniedContext = notificationVmContext({ permission: "denied", requestPermission: () => "granted" });
	const denied = await vm.runInNewContext(`${source}
		(async () => {
			const state = refreshNotificationPermissionUi();
			await requestNotificationPermission();
			const shown = showTicketNotification({ id: "PI-denied", title: "Denied", lane: LANE.PLAN_REVIEW }, LANE.PLAN_REVIEW);
			return { state, button, permissionRequests, shown, notifications };
		})()
	`, deniedContext);
	assert.equal(denied.state, "denied");
	assert.equal(denied.button.hidden, true);
	assert.equal(denied.permissionRequests, 0, "denied permission is not requested again");
	assert.equal(denied.shown, false);
	assert.equal(denied.notifications.length, 0);

	const defaultContext = notificationVmContext({ permission: "default", requestPermission: () => "default" });
	const defaultResult = await vm.runInNewContext(`${source}
		(async () => {
			const state = refreshNotificationPermissionUi();
			const visibleBeforePrompt = !button.hidden && !button.disabled;
			await requestNotificationPermission();
			await requestNotificationPermission();
			return { state, visibleBeforePrompt, button, permissionRequests, notifications };
		})()
	`, defaultContext);
	assert.equal(defaultResult.state, "default");
	assert.equal(defaultResult.visibleBeforePrompt, true, "default permission exposes the explicit enable button");
	assert.equal(defaultResult.permissionRequests, 1, "dismissed prompts are not repeated automatically");
	assert.equal(defaultResult.button.hidden, true);
	assert.equal(defaultResult.notifications.length, 0);

	const unsupportedContext = notificationVmContext({ supported: false });
	const unsupported = await vm.runInNewContext(`${source}
		(async () => {
			const state = refreshNotificationPermissionUi();
			await requestNotificationPermission();
			const shown = showTicketNotification({ id: "PI-unsupported", title: "Unsupported", lane: LANE.IN_REVIEW }, LANE.IN_REVIEW);
			return { state, button, shown, notifications };
		})()
	`, unsupportedContext);
	assert.equal(unsupported.state, "unsupported");
	assert.equal(unsupported.button.hidden, true);
	assert.equal(unsupported.button.disabled, true);
	assert.equal(unsupported.shown, false);
	assert.equal(unsupported.notifications.length, 0);
});

test("dashboard css keeps the desktop board compact and stacks it on mobile", async () => {
	const html = await renderDashboardHtml("test-token");

	assert.match(html, /body \{[^}]*min-width: 0;[^}]*overflow-x: hidden;/);
	assert.match(html, /\[hidden\] \{ display: none !important; \}/);
	assert.doesNotMatch(html, /body \{[^}]*width: 100vw;/);
	assert.match(html, /\.topbar \{[^}]*width: 100%;[^}]*min-width: 0;/);
	assert.match(html, /\.top-actions \{[^}]*justify-content: flex-end;[^}]*min-width: 0;/);
	assert.doesNotMatch(html, /\.top-actions \{[^}]*position: fixed;/);
	assert.match(html, /\.app-shell \{[\s\S]*grid-template-rows: auto auto;[\s\S]*align-content: start;[\s\S]*min-height: calc\(100vh - 64px\);[\s\S]*width: 100%;/);
	assert.doesNotMatch(html, /grid-template-rows: auto minmax\(0, auto\);/);
	assert.match(html, /\.board \{[\s\S]*overflow-x: auto;[\s\S]*padding: 10px 18px 18px;/);
	assert.match(html, /\.card-head \{[^}]*justify-content: flex-end;[^}]*margin-bottom: 6px;[^}]*min-width: 0;/);
	assert.match(html, /\.card-title \{[^}]*display: block;[^}]*width: 100%;[^}]*overflow-wrap: anywhere;/);
	const cardActionCss = html.match(/\.card-action \{([^}]*)\}/)?.[1] || "";
	assert.ok(cardActionCss, "dashboard card action CSS rule exists");
	assert.match(cardActionCss, /width: 26px;/);
	assert.match(cardActionCss, /height: 26px;/);
	assert.match(cardActionCss, /min-width: 26px;/);
	assert.match(cardActionCss, /min-height: 26px;/);
	assert.match(cardActionCss, /padding: 0;/);
	assert.match(cardActionCss, /box-sizing: border-box;/);
	assert.match(cardActionCss, /flex: 0 0 26px;/);
	assert.match(cardActionCss, /align-self: center;/);
	assert.doesNotMatch(cardActionCss, /height: 24px;/);
	assert.doesNotMatch(cardActionCss, /padding: 0 7px;/);
	assert.match(html, /\.minimized \.card-title \{ margin-bottom: 0; \}/);
	assert.doesNotMatch(html, /\.card-head \{[^}]*justify-content: space-between;/);
	assert.match(html, /@media \(max-width: 640px\) \{[\s\S]*\.desktop-directory-picker \{ display: none; \}[\s\S]*\.board \{[\s\S]*grid-template-columns: 1fr;[\s\S]*overflow-x: visible;[\s\S]*\}[\s\S]*\.lane \{ min-height: 180px; \}/);
	assert.match(html, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.desktop-directory-picker \{ display: none; \}\s*\}/);
});

test("server renders token-gated dashboard html", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "test-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	try {
		const denied = await fetch(url.split("?")[0]);
		assert.equal(denied.status, 401);
		const allowed = await fetch(url);
		assert.equal(allowed.status, 200);
		const html = await allowed.text();
		assert.match(html, /const TOKEN = "test-token";/);
		assert.match(html, /create-drawer/);
		assert.match(html, /renderMarkdown/);
		assert.match(html, /Plan Review Report/);
		assert.match(html, /\.markdown :not\(pre\) > code \{[\s\S]*overflow-wrap: anywhere;[\s\S]*word-break: break-word;/);
		assert.match(html, /\.app-shell \{[\s\S]*min-height: calc\(100vh - 64px\);[\s\S]*width: 100%;/);
		assert.match(html, /\.board \{[\s\S]*align-items: start;[\s\S]*overflow-x: auto;/);
		assert.match(html, /@media \(max-width: 640px\) \{[\s\S]*\.desktop-directory-picker \{ display: none; \}[\s\S]*\.board \{[\s\S]*grid-template-columns: 1fr;[\s\S]*overflow-x: visible;/);
		assert.match(html, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.desktop-directory-picker \{ display: none; \}\s*\}/);
		assert.match(html, /\.lane \{[\s\S]*min-height: 430px;[\s\S]*height: fit-content;/);
		assert.match(html, /\.panel-resize-handle/);
		assert.match(html, /--create-drawer-default-width: 460px;/);
		assert.match(html, /--detail-panel-default-width: 520px;/);
		assert.equal(html.includes("body { overflow: hidden; }"), false);
		assert.match(html, /Approve and merge/);
		assert.match(html, /function mergeTargetKey\(issue\)/);
		assert.match(html, /function activeMergeForIssue\(issue\)/);
		assert.match(html, /Merge blocked by/);
		assert.match(html, /until its active merge is done/);
		assert.match(html, /Approve and leave in worktree/);
		assert.match(html, /Request Changes/);
		assert.match(html, /Depends on issue/);
		assert.match(html, /dependencyIssueId/);
		assert.match(html, /linkedDirectoryQuickSelect/);
		assert.match(html, /class="secondary desktop-directory-picker" id="pick-directory"/);
		assert.match(html, /linkedDirectorySuggestions/);
		assert.match(html, /function linkedDirectoryChoices\(\)/);
		assert.match(html, /populateLinkedDirectoryOptions\(\);/);
		assert.match(html, /minimizedIssueIds\.has\(id\)/);
		assert.match(html, /let issueLaneById = new Map\(\);/);
		assert.match(html, /function syncCompletedTicketMinimization\(nextState\)/);
		assert.match(html, /syncCompletedTicketMinimization\(nextState\);/);
		assert.match(html, /escapeHtml\(minimizedTitle\(issue\.title\)\)/);
		assert.match(html, /event\.target\.closest\("\[data-minimize-toggle\]"\)/);
		assert.match(html, /Minimize ticket/);
		assert.match(html, /Restore ticket/);
		const formElCapture = html.indexOf("const formEl = event.currentTarget;");
		const createApiCall = html.indexOf('await api("/api/issues"');
		assert.ok(formElCapture !== -1, "issue form submit handler captures currentTarget before async work");
		assert.ok(createApiCall !== -1, "issue form submit handler creates issues through the API");
		assert.ok(formElCapture < createApiCall, "issue form stores currentTarget before awaiting issue creation");
		assert.match(html, /const form = new FormData\(formEl\);/);
		assert.match(html, /formEl\.reset\(\);/);
		assert.doesNotMatch(html, /event\.currentTarget\.reset\(\);/);
		assert.match(html, /profileSelect/);
		assert.match(html, /Settings differ from selected profile/);
		assert.match(html, /Save to selected profile/);
		assert.match(html, /Save as new profile/);
		assert.match(html, /Diffs appear once work reaches In Progress/);
		assert.match(html, /\/api\/issues\/" \+ encodeURIComponent\(issue\.id\) \+ "\/diffs/);
		assert.match(html, /diff-file-toggle/);
		assert.match(html, /Agent Output/);
		assert.match(html, /function renderAgentSession\(issue, runId/);
		assert.match(html, /data-view-run/);
		assert.match(html, /\/api\/issues\/" \+ encodeURIComponent\(issueId\) \+ "\/runs\//);
		assert.match(html, /partialResult/);
		assert.match(html, /toolEventIsError/);
		assert.match(html, /isError/);
		assert.match(html, /handleEventStreamMessage/);
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated share metadata and QR endpoints", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "share-token",
		config: { host: "0.0.0.0", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const deniedShare = await fetch(`${base}/api/share`);
		assert.equal(deniedShare.status, 401);

		const share = await fetch(`${base}/api/share?token=share-token`);
		assert.equal(share.status, 200);
		const body = await share.json();
		assert.equal(body.host, "0.0.0.0");
		assert.equal(body.lanEnabled, true);
		assert.equal(body.port > 0, true);
		assert.match(body.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?token=share-token$/);
		assert.equal(body.localUrl.includes("0.0.0.0"), false);
		assert.equal(body.shareUrl.includes("0.0.0.0"), false);
		if (body.networkUrl) assert.equal(body.networkUrl.includes("0.0.0.0"), false);

		const deniedSvg = await fetch(`${base}/api/share.svg`);
		assert.equal(deniedSvg.status, 401);

		const svg = await fetch(`${base}/api/share.svg?token=share-token`);
		assert.equal(svg.status, 200);
		assert.match(svg.headers.get("content-type") || "", /image\/svg\+xml/);
		const svgText = await svg.text();
		assert.match(svgText, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
		assert.match(svgText, /viewBox="0 0 \d+ \d+"/);
		assert.match(svgText, /<rect width="100%" height="100%" fill="#fff"\/>/);
		assert.match(svgText, /<path fill="#000" d="M\d+,\d+h\d+v1h-\d+z/);
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated spec improvement API", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const calls = [];
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "spec-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			improveSpec: async (body) => {
				calls.push(body);
				if (body.fail) throw new Error("Spec writer failed.");
				return { spec: "Improved spec." };
			},
			createIssue: reject,
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/spec/improve`, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);

		const improved = await fetch(`${base}/api/spec/improve?token=spec-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ spec: "Draft", suggestions: "Be clearer" }),
		});
		assert.equal(improved.status, 200);
		assert.deepEqual(await improved.json(), { spec: "Improved spec." });
		assert.deepEqual(calls[0], { spec: "Draft", suggestions: "Be clearer" });

		const failed = await fetch(`${base}/api/spec/improve?token=spec-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ spec: "Draft", fail: true }),
		});
		assert.equal(failed.status, 400);
		assert.deepEqual(await failed.json(), { error: "Spec writer failed." });
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated profile API", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "profile-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/profiles`);
		assert.equal(denied.status, 401);

		const first = await fetch(`${base}/api/profiles?token=profile-token`);
		assert.equal(first.status, 200);
		const firstBody = await first.json();
		assert.equal(firstBody.profiles[0].id, DEFAULT_PROFILE_ID);

		const created = await fetch(`${base}/api/profiles?token=profile-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				name: "Deep worker",
				agentSettings: {
					planner: { model: "planner-deep", thinking: "high" },
					worker: { model: "worker-deep", thinking: "xhigh" },
					reviewer: { model: "reviewer-deep", thinking: "low" },
				},
			}),
		});
		assert.equal(created.status, 200);
		const createdBody = await created.json();
		assert.equal(createdBody.profile.name, "Deep worker");
		assert.equal(createdBody.profile.agentSettings.worker.thinking, "xhigh");

		const second = await fetch(`${base}/api/profiles?token=profile-token`);
		const secondBody = await second.json();
		assert.equal(secondBody.profiles.some((profile) => profile.id === createdBody.profile.id), true);
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated agent session API", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({ title: "API session", spec: "Expose run output.", linkedDirectory: linked });
	await store.appendRunEvent(issue.metadata.id, "run-api", { type: "message_end", message: { content: [{ type: "text", text: "persisted" }] } });
	const reject = async () => { throw new Error("not used"); };
	const server = new OrchestratorServer({
		store,
		token: "session-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			updateBacklogIssue: reject,
			sendBacklogIssueToAgent: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
			resumeBlockedIssue: reject,
			improveSpec: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/runs/run-api`);
		assert.equal(denied.status, 401);
		const response = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/runs/run-api?token=session-token`);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.issueId, issue.metadata.id);
		assert.equal(body.runId, "run-api");
		assert.equal(body.session.messages[0].content, "persisted");
		const traversal = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/runs/${encodeURIComponent("../run-api")}?token=session-token`);
		assert.equal(traversal.status, 400);
	} finally {
		await server.stop();
	}
});

test("server routes backlog create, update, and send actions", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const calls = [];
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "backlog-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: async (body) => {
				calls.push(["create", body]);
				return { metadata: { id: "PI-backlog", lane: body.backlog ? LANE.BACKLOG : LANE.CREATED } };
			},
			updateBacklogIssue: async (id, body) => {
				calls.push(["update", id, body]);
				return { metadata: { id, lane: LANE.BACKLOG } };
			},
			sendBacklogIssueToAgent: async (id) => {
				calls.push(["send", id]);
				return { metadata: { id, lane: LANE.CREATED } };
			},
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/issues/PI-backlog/update-backlog`, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);

		const created = await fetch(`${base}/api/issues?token=backlog-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Idea", backlog: true }),
		});
		assert.equal(created.status, 201);
		assert.equal(calls[0][0], "create");
		assert.equal(calls[0][1].backlog, true);

		const updated = await fetch(`${base}/api/issues/PI-backlog/update-backlog?token=backlog-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Edited" }),
		});
		assert.equal(updated.status, 200);
		assert.deepEqual(calls[1], ["update", "PI-backlog", { title: "Edited" }]);

		const sent = await fetch(`${base}/api/issues/PI-backlog/send-to-agent?token=backlog-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(sent.status, 200);
		assert.deepEqual(calls[2], ["send", "PI-backlog"]);
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated completed ticket cleanup API", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const oldCompleted = await store.createIssue({ title: "Old done server", spec: "Archive me.", linkedDirectory: linked });
	await store.setLane(oldCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, oldCompleted.metadata.id, { updatedAt: "2026-03-01T00:00:00.000Z" });
	const recentCompleted = await store.createIssue({ title: "Recent done server", spec: "Keep me.", linkedDirectory: linked });
	await store.setLane(recentCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, recentCompleted.metadata.id, { updatedAt: "2026-05-10T00:00:00.000Z" });
	const originalCleanCompletedTickets = store.cleanCompletedTickets.bind(store);
	store.cleanCompletedTickets = (options = {}) => originalCleanCompletedTickets({ now: new Date("2026-05-12T00:00:00.000Z"), ...options });
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "cleanup-token",
		actions: {
			createIssue: reject,
			comment: reject,
			updateBacklogIssue: reject,
			sendBacklogIssueToAgent: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
			resumeBlockedIssue: reject,
			improveSpec: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/issues/clean-completed`, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);

		const response = await fetch(`${base}/api/issues/clean-completed?token=cleanup-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.cleanedCount, 1);
		assert.deepEqual(body.cleanedIds, [oldCompleted.metadata.id]);
		assert.equal(body.retentionDays, COMPLETED_TICKET_CLEANUP_RETENTION_DAYS);
		assert.equal(await exists(path.join(root, "issues", oldCompleted.metadata.id)), false);
		assert.equal(await exists(path.join(root, "issues", recentCompleted.metadata.id)), true);
	} finally {
		await server.stop();
	}
});

test("server routes blocked issue resume action", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const calls = [];
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "resume-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			updateBacklogIssue: reject,
			sendBacklogIssueToAgent: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
			resumeBlockedIssue: async (id) => {
				calls.push(id);
				return { metadata: { id } };
			},
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const response = await fetch(`${base}/api/issues/PI-resume/resume?token=resume-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 200);
		assert.deepEqual(calls, ["PI-resume"]);
	} finally {
		await server.stop();
	}
});

test("runtime creates backlog issues without scheduling until they are sent", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	let queued = 0;
	runtime.scheduler.queueTick = () => {
		queued += 1;
	};
	const actions = runtime.createActions();

	const backlog = await actions.createIssue({ title: "Runtime backlog", spec: "Later.", linkedDirectory: linked, backlog: true });
	assert.equal(backlog.metadata.lane, LANE.BACKLOG);
	assert.equal(queued, 0);

	const sent = await actions.sendBacklogIssueToAgent(backlog.metadata.id);
	assert.equal(sent.metadata.lane, LANE.CREATED);
	assert.equal(queued, 1);
});

test("runtime resumes a blocked issue using the latest worker session", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	let queued = 0;
	runtime.scheduler.queueTick = () => {
		queued += 1;
	};
	const issue = await createBlockedWorkerIssue(runtime.store, linked, { title: "Runtime resumable", runId: "worker-old" });
	const actions = runtime.createActions();

	const resumed = await actions.resumeBlockedIssue(issue.metadata.id);

	assert.equal(resumed.metadata.automation.paused, false);
	assert.equal(resumed.metadata.automation.error, null);
	assert.equal(resumed.metadata.automation.resumeRunId, "worker-old");
	assert.equal(resumed.metadata.automation.resumeSessionFile, path.join(root, "sessions", issue.metadata.id, "worker-old.jsonl"));
	assert.equal(resumed.events.some((event) => event.type === "blocked_issue_resume_requested" && event.resumeRunId === "worker-old"), true);
	assert.equal(queued, 1);
	assert.deepEqual(await runtime.store.listIssueIds(), [issue.metadata.id]);
	await assert.rejects(() => actions.resumeBlockedIssue(issue.metadata.id), /not blocked/);
});

test("runtime resume validation fails safely", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	runtime.scheduler.queueTick = () => assert.fail("resume failure should not queue scheduler work");
	const missing = await createBlockedWorkerIssue(runtime.store, linked, { title: "Missing runtime session", runId: "worker-missing", createSession: false });
	await assert.rejects(() => runtime.createActions().resumeBlockedIssue(missing.metadata.id), /session file is unavailable/);
	let unchanged = await runtime.store.loadIssue(missing.metadata.id);
	assert.equal(unchanged.metadata.automation.paused, true);
	assert.equal(unchanged.metadata.automation.resumeSessionFile, undefined);

	const active = await createBlockedWorkerIssue(runtime.store, linked, { title: "Active blocked", runId: "worker-active" });
	await runtime.store.updateMetadata(active.metadata.id, (metadata) => ({
		...metadata,
		automation: { ...metadata.automation, activeRunId: "worker-active", activeRole: "worker" },
	}));
	await assert.rejects(() => runtime.createActions().resumeBlockedIssue(active.metadata.id), /active run/);
	unchanged = await runtime.store.loadIssue(active.metadata.id);
	assert.equal(unchanged.metadata.automation.resumeSessionFile, undefined);

	const dependency = await runtime.store.createIssue({ title: "Runtime dependency", spec: "First.", linkedDirectory: linked });
	await runtime.store.setLane(dependency.metadata.id, LANE.IN_REVIEW, "test");
	const blockedByDependency = await runtime.store.createIssue({
		title: "Runtime dependency blocked",
		spec: "Second.",
		linkedDirectory: linked,
		dependencyIssueId: dependency.metadata.id,
	});
	await runtime.store.updateMetadata(blockedByDependency.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		automation: { ...metadata.automation, paused: true, error: "Blocked.", activeRunId: null, activeRole: null },
	}));
	await assert.rejects(() => runtime.createActions().resumeBlockedIssue(blockedByDependency.metadata.id), /unresolved dependency/);
});

test("runtime improves specs through spec-writer subagent", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const calls = [];
	runtime.runner = {
		run: async (request) => {
			calls.push(request);
			return { text: "  Improved runtime spec.  " };
		},
	};
	const actions = runtime.createActions();

	const result = await actions.improveSpec({ spec: "Draft runtime spec.", suggestions: "Add tests.", linkedDirectory: linked });

	assert.deepEqual(result, { spec: "Improved runtime spec." });
	assert.equal(calls[0].issueId, "spec-writer");
	assert.equal(calls[0].role, "spec-writer");
	assert.equal(calls[0].internal, true);
	assert.equal(await fsp.realpath(calls[0].cwd), await fsp.realpath(linked));
	assert.equal(calls[0].agentSettings, null);
	assert.match(calls[0].prompt, /Draft runtime spec\./);
	assert.match(calls[0].prompt, /Add tests\./);

	await assert.rejects(() => actions.improveSpec({ spec: "  " }), /Spec is required/);
	runtime.runner = { run: async () => ({ text: "  " }) };
	await assert.rejects(() => actions.improveSpec({ spec: "Draft" }), /empty spec/);
});

test("runtime spec writer logs outside issues and does not create a synthetic board issue", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const fakePi = path.join(root, "fake-pi.mjs");
	await fsp.writeFile(
		fakePi,
		[
			"#!/usr/bin/env node",
			"let buffer = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => {",
			"  buffer += chunk;",
			"  const lines = buffer.split('\\n');",
			"  buffer = lines.pop() || '';",
			"  for (const line of lines) {",
			"    if (!line.trim()) continue;",
			"    const request = JSON.parse(line);",
			"    if (request.type !== 'prompt') continue;",
			"    const message = { role: 'assistant', content: [{ type: 'text', text: 'Improved by fake spec writer.' }] };",
			"    console.log(JSON.stringify({ type: 'response', id: request.id, success: true }));",
			"    console.log(JSON.stringify({ type: 'message_end', message }));",
			"    console.log(JSON.stringify({ type: 'agent_end', messages: [message] }));",
			"    setTimeout(() => process.exit(0), 20);",
			"  }",
			"});",
			"",
		].join("\n"),
		"utf-8",
	);
	await fsp.chmod(fakePi, 0o755);

	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	runtime.runner = new RpcAgentRunner({
		store: runtime.store,
		command: fakePi,
		timeoutMs: 5000,
		idleTimeoutMs: 1000,
	});
	const actions = runtime.createActions();

	const result = await actions.improveSpec({ spec: "Draft board-safe spec.", linkedDirectory: linked });

	assert.deepEqual(result, { spec: "Improved by fake spec writer." });
	assert.equal(await exists(path.join(root, "issues", "spec-writer")), false);
	assert.deepEqual(await runtime.store.listIssueIds(), []);
	assert.equal((await runtime.store.getBoardState()).issues.length, 0);

	const legacyInternalIssueDir = path.join(root, "issues", "__spec-writer__");
	await fsp.mkdir(path.join(legacyInternalIssueDir, "runs"), { recursive: true });
	assert.deepEqual(await runtime.store.listIssueIds(), []);
	assert.equal((await runtime.store.getBoardState()).issues.length, 0);
	assert.equal(await exists(path.join(legacyInternalIssueDir, "events.jsonl")), false);

	const internalRunDir = path.join(root, "runs", "spec-writer");
	assert.equal(await exists(internalRunDir), true);
	const internalRunFiles = await fsp.readdir(internalRunDir);
	assert.equal(internalRunFiles.length, 1);
	const log = await fsp.readFile(path.join(internalRunDir, internalRunFiles[0]), "utf-8");
	assert.match(log, /"type":"run_started"/);
	assert.match(log, /"type":"run_finished"/);
});

test("diff helper reports tracked, renamed, and untracked worktree changes", async () => {
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await fsp.writeFile(path.join(repo, "deleted.txt"), "remove me\n", "utf-8");
	await fsp.writeFile(path.join(repo, "old-name.txt"), "rename me\n", "utf-8");
	await git(["add", "."], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseSha = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

	await fsp.writeFile(path.join(repo, "README.md"), "before\nafter\n", "utf-8");
	await fsp.writeFile(path.join(repo, "added.txt"), "tracked add\n", "utf-8");
	await git(["add", "added.txt"], repo);
	await git(["rm", "deleted.txt"], repo);
	await git(["mv", "old-name.txt", "renamed.txt"], repo);
	await fsp.writeFile(path.join(repo, "untracked.txt"), "untracked add\n", "utf-8");

	const diffs = await getIssueDiffs({
		metadata: {
			id: "PI-diff-test",
			workspace: { kind: "git-worktree", path: repo },
			git: { baseSha },
		},
	});

	assert.equal(diffs.available, true);
	assert.equal(diffs.reason, null);
	assert.equal(diffs.baseSha, baseSha);
	assert.match(diffs.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
	const byPath = new Map(diffs.files.map((file) => [file.path, file]));
	assert.equal(byPath.get("README.md").status, "modified");
	assert.equal(byPath.get("README.md").additions, 1);
	assert.match(byPath.get("README.md").patch, /\+after/);
	assert.equal(byPath.get("added.txt").status, "added");
	assert.equal(byPath.get("deleted.txt").status, "deleted");
	assert.equal(byPath.get("renamed.txt").status, "renamed");
	assert.equal(byPath.get("renamed.txt").oldPath, "old-name.txt");
	assert.equal(byPath.get("untracked.txt").status, "untracked");
	assert.match(byPath.get("untracked.txt").patch, /new file mode/);
});

test("diff helper returns unavailable payload for non-git issues", async () => {
	const diffs = await getIssueDiffs({ metadata: { id: "PI-no-git", workspace: { kind: "directory", path: "/tmp" }, git: null } });

	assert.equal(diffs.available, false);
	assert.equal(diffs.reason, "not_git_backed");
	assert.deepEqual(diffs.files, []);
});

test("server exposes authenticated issue diffs API", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseSha = (await git(["rev-parse", "HEAD"], repo)).stdout.trim();

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({ title: "Diff endpoint", spec: "Expose diffs.", linkedDirectory: repo });
	await store.updateMetadata(issue.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		workspace: { kind: "git-worktree", path: repo },
		git: { baseSha, repoRoot: repo, baseBranch: "main", branchName: "test" },
	}));
	await fsp.writeFile(path.join(repo, "README.md"), "before\nafter\n", "utf-8");

	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "diff-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			createIssue: reject,
			comment: reject,
			approvePlan: reject,
			requestPlanChanges: reject,
			approveReview: reject,
			approveReviewAndMerge: reject,
			requestReviewChanges: reject,
		},
	});
	const url = await server.start();
	const base = url.split("?")[0].replace(/\/$/, "");
	try {
		const denied = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/diffs`);
		assert.equal(denied.status, 401);

		const allowed = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/diffs?token=diff-token`);
		assert.equal(allowed.status, 200);
		const body = await allowed.json();
		assert.equal(body.issueId, issue.metadata.id);
		assert.equal(body.available, true);
		assert.equal(body.files.some((file) => file.path === "README.md" && file.status === "modified"), true);
	} finally {
		await server.stop();
	}
});

test("issue store creates folder-per-issue artifacts and board state", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Add parser tests",
		spec: "Implement parser tests.",
		linkedDirectory: linked,
		agentSettings: {
			planner: { model: "planner-model", thinking: "xhigh" },
			worker: { model: "worker-model", thinking: "low" },
			reviewer: { model: "reviewer-model", thinking: "invalid" },
		},
	});

	const id = issue.metadata.id;
	assert.equal(issue.metadata.lane, LANE.CREATED);
	assert.deepEqual(issue.metadata.dependencies, { issueId: null, resolvedAt: null });
	assert.deepEqual(issue.metadata.agentSettings.planner, { model: "planner-model", thinking: "xhigh" });
	assert.deepEqual(issue.metadata.agentSettings.worker, { model: "worker-model", thinking: "low" });
	assert.deepEqual(issue.metadata.agentSettings.reviewer, { model: "reviewer-model", thinking: ROLE_DEFAULTS.reviewer.thinking });
	assert.equal(await exists(path.join(root, "issues", id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", id, "spec.md")), true);
	assert.equal(await exists(path.join(root, "issues", id, "plan.md")), true);
	assert.equal(await exists(path.join(root, "issues", id, "plan-report.md")), true);
	assert.equal(await exists(path.join(root, "issues", id, "review-report.md")), true);

	await store.writePlanReport(id, "# Plan report\n");
	await store.writeReviewReport(id, "# Review report\n");

	const state = await store.getBoardState();
	assert.equal(state.issues.length, 1);
	assert.deepEqual(state.lanes[LANE.CREATED], [id]);
	assert.equal(state.issues[0].planReport, "# Plan report\n");
	assert.equal(state.issues[0].reviewReport, "# Review report\n");
});

test("issue store retrieves persisted agent session history", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({ title: "Session history", spec: "Persist run output.", linkedDirectory: linked });
	await store.appendRunEvent(issue.metadata.id, "run-1", { type: "message_update", delta: "hello" });
	await store.appendRunEvent(issue.metadata.id, "run-1", { type: "message_end", message: { content: [{ type: "text", text: "hello final" }] } });
	await store.appendRunEvent(issue.metadata.id, "run-2", { type: "message_end", message: { content: [{ type: "text", text: "other run" }] } });

	const session = await store.getAgentSession(issue.metadata.id, "run-1");
	assert.equal(session.issueId, issue.metadata.id);
	assert.equal(session.runId, "run-1");
	assert.equal(session.events.length, 2);
	assert.equal(session.session.messages[0].content, "hello final");
	assert.equal((await store.getAgentSession(issue.metadata.id, "run-2")).session.messages[0].content, "other run");
});

test("issue store cleans only old completed tickets into archive", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const cleanupNow = new Date("2026-05-12T00:00:00.000Z");

	const oldCompleted = await store.createIssue({ title: "Old completed cleanup", spec: "Archive me.", linkedDirectory: linked });
	await store.setLane(oldCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, oldCompleted.metadata.id, { updatedAt: "2026-03-01T00:00:00.000Z" });

	const oldInProgress = await store.createIssue({ title: "Old active cleanup", spec: "Keep active.", linkedDirectory: linked });
	await store.setLane(oldInProgress.metadata.id, LANE.IN_PROGRESS, "test");
	await patchIssueMetadata(store, oldInProgress.metadata.id, { updatedAt: "2026-03-01T00:00:00.000Z" });

	const recentCompleted = await store.createIssue({ title: "Recent completed cleanup", spec: "Keep recent.", linkedDirectory: linked });
	await store.setLane(recentCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, recentCompleted.metadata.id, { updatedAt: "2026-05-01T00:00:00.000Z" });
	await fsp.mkdir(path.join(root, "sessions", oldCompleted.metadata.id), { recursive: true });
	await fsp.writeFile(path.join(root, "sessions", oldCompleted.metadata.id, "run.jsonl"), "{}\n", "utf-8");
	await fsp.mkdir(path.join(root, "sessions", oldInProgress.metadata.id), { recursive: true });

	const result = await store.cleanCompletedTickets({ now: cleanupNow });
	assert.equal(result.cleanedCount, 1);
	assert.deepEqual(result.cleanedIds, [oldCompleted.metadata.id]);
	assert.equal(result.retentionDays, COMPLETED_TICKET_CLEANUP_RETENTION_DAYS);
	assert.equal(await exists(path.join(root, "issues", oldCompleted.metadata.id)), false);
	assert.equal(await exists(path.join(root, "issues", "__archived_completed__", oldCompleted.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", oldInProgress.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", recentCompleted.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "sessions", oldCompleted.metadata.id)), false);
	assert.equal(await exists(path.join(root, "sessions", oldInProgress.metadata.id)), true);

	const state = await store.getBoardState();
	const visibleIds = state.issues.map((issue) => issue.id).sort();
	assert.deepEqual(visibleIds, [oldInProgress.metadata.id, recentCompleted.metadata.id].sort());
	assert.deepEqual(state.lanes[LANE.IN_PROGRESS], [oldInProgress.metadata.id]);
	assert.deepEqual(state.lanes[LANE.COMPLETED], [recentCompleted.metadata.id]);
});

test("issue store completed ticket cleanup handles nothing eligible", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const recentCompleted = await store.createIssue({ title: "Recent only cleanup", spec: "Keep me.", linkedDirectory: linked });
	await store.setLane(recentCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, recentCompleted.metadata.id, { updatedAt: "2026-05-10T00:00:00.000Z" });
	const invalidCompleted = await store.createIssue({ title: "Invalid date cleanup", spec: "Keep invalid date.", linkedDirectory: linked });
	await store.setLane(invalidCompleted.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, invalidCompleted.metadata.id, { updatedAt: "not-a-date" });

	const result = await store.cleanCompletedTickets({ now: new Date("2026-05-12T00:00:00.000Z") });
	assert.deepEqual(result, { cleanedCount: 0, cleanedIds: [], retentionDays: COMPLETED_TICKET_CLEANUP_RETENTION_DAYS });
	assert.equal(await exists(path.join(root, "issues", recentCompleted.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", invalidCompleted.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", "__archived_completed__")), false);
});

test("issue store completed ticket cleanup rolls back moves when archiving fails", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const cleanupNow = new Date("2026-05-12T00:00:00.000Z");
	const first = await store.createIssue({ title: "Rollback completed one", spec: "Keep on failure.", linkedDirectory: linked });
	await store.setLane(first.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, first.metadata.id, { updatedAt: "2026-03-01T00:00:00.000Z" });
	const second = await store.createIssue({ title: "Rollback completed two", spec: "Keep on failure too.", linkedDirectory: linked });
	await store.setLane(second.metadata.id, LANE.COMPLETED, "test");
	await patchIssueMetadata(store, second.metadata.id, { updatedAt: "2026-03-01T00:00:00.000Z" });
	const events = [];
	store.onChange((event) => events.push(event));
	const originalUniqueCompletedArchiveDir = store.uniqueCompletedArchiveDir.bind(store);
	let archivePathCalls = 0;
	store.uniqueCompletedArchiveDir = async (...args) => {
		archivePathCalls += 1;
		if (archivePathCalls === 2) return path.join(root, "missing-parent", "archive-target");
		return originalUniqueCompletedArchiveDir(...args);
	};

	await assert.rejects(() => store.cleanCompletedTickets({ now: cleanupNow }), /ENOENT/);
	assert.equal(await exists(path.join(root, "issues", first.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", second.metadata.id, "metadata.json")), true);
	assert.equal(events.some((event) => event.type === "completed_tickets_cleaned"), false);
	const state = await store.getBoardState();
	const visibleIds = state.issues.map((issue) => issue.id).sort();
	assert.deepEqual(visibleIds, [first.metadata.id, second.metadata.id].sort());
});

test("issue store reports resume eligibility for blocked in-progress tickets", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await createBlockedWorkerIssue(store, linked, { title: "Resumable issue", runId: "worker-old" });

	const state = await store.getBoardState();
	const entry = state.issues.find((item) => item.id === issue.metadata.id);
	assert.equal(entry.resume.canResume, true);
	assert.equal(entry.resume.runId, "worker-old");
	assert.equal(entry.resume.sessionFile, path.join(root, "sessions", issue.metadata.id, "worker-old.jsonl"));
});

test("issue store does not fall back to an older session when the newest worker session is missing", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await createBlockedWorkerIssue(store, linked, { title: "Stale session", runId: "worker-old" });
	await store.appendEvent(issue.metadata.id, { type: "agent_run_started", role: "worker", runId: "worker-new" });

	const state = await store.getBoardState();
	const entry = state.issues.find((item) => item.id === issue.metadata.id);
	assert.equal(entry.resume.canResume, false);
	assert.equal(entry.resume.runId, null);
	assert.equal(entry.resume.sessionFile, null);
	assert.match(entry.resume.reason, /last worker session file is unavailable/);
});

test("issue store resolves mapped resume sessions for resumed worker runs", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await createBlockedWorkerIssue(store, linked, { title: "Mapped resume", runId: "worker-old" });
	const sessionFile = path.join(root, "sessions", issue.metadata.id, "worker-old.jsonl");
	await store.appendEvent(issue.metadata.id, { type: "agent_run_started", role: "worker", runId: "worker-new" });
	await store.appendEvent(issue.metadata.id, {
		type: "implementation_resume_started",
		runId: "worker-new",
		resumeRunId: "worker-old",
		resumeSessionFile: sessionFile,
	});

	const state = await store.getBoardState();
	const entry = state.issues.find((item) => item.id === issue.metadata.id);
	assert.equal(entry.resume.canResume, true);
	assert.equal(entry.resume.runId, "worker-old");
	assert.equal(entry.resume.sessionFile, sessionFile);
});

test("issue store explains non-resumable blocked tickets", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const missingSession = await createBlockedWorkerIssue(store, linked, { title: "Missing session", runId: "worker-missing", createSession: false });
	const dependency = await store.createIssue({ title: "Dependency", spec: "Finish first.", linkedDirectory: linked });
	await store.setLane(dependency.metadata.id, LANE.IN_REVIEW, "test");
	const dependencyBlocked = await store.createIssue({
		title: "Dependency blocked",
		spec: "Wait.",
		linkedDirectory: linked,
		dependencyIssueId: dependency.metadata.id,
	});
	await store.updateMetadata(dependencyBlocked.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		automation: { ...metadata.automation, paused: false, error: null, activeRunId: null, activeRole: null },
	}));

	const state = await store.getBoardState();
	const missingEntry = state.issues.find((item) => item.id === missingSession.metadata.id);
	const dependencyEntry = state.issues.find((item) => item.id === dependencyBlocked.metadata.id);
	assert.equal(missingEntry.resume.canResume, false);
	assert.match(missingEntry.resume.reason, /session file is unavailable/);
	assert.equal(dependencyEntry.resume.canResume, false);
	assert.match(dependencyEntry.resume.reason, /unresolved dependency/);
});

test("workflow resume validation only allows blocked inactive In Progress tickets", () => {
	const base = normalizeMetadata({
		id: "PI-resume",
		title: "Resume",
		lane: LANE.IN_PROGRESS,
		createdAt: "2026-01-01T00:00:00.000Z",
		automation: { paused: true, error: "Worker stopped.", activeRunId: null },
	});
	assert.equal(canRequestResume(base), true);
	assert.equal(canRequestResume({ ...base, lane: LANE.COMPLETED }), false);
	assert.match(resumeBlockedReason({ ...base, lane: LANE.COMPLETED }), /Only In Progress/);
	assert.equal(canRequestResume({ ...base, automation: { ...base.automation, paused: false, error: null } }), false);
	assert.match(resumeBlockedReason({ ...base, automation: { ...base.automation, activeRunId: "run" } }), /active run/);
	assert.match(resumeBlockedReason(base, { hasUnresolvedDependency: true }), /unresolved dependency/);
});

test("spec writer prompt includes draft and suggestions and requires spec-only output", () => {
	const prompt = buildSpecWriterPrompt({
		spec: "Add a backlog magic wand.",
		suggestions: "Mention disabled controls while loading.",
	});

	assert.match(prompt, /Add a backlog magic wand\./);
	assert.match(prompt, /Mention disabled controls while loading\./);
	assert.match(prompt, /Return only the improved spec text/);
	assert.match(prompt, /Output the improved spec only\./);
	assert.doesNotMatch(prompt, /BEGIN_IMPLEMENTATION_PLAN/);
});

test("final reviewer prompt prioritizes newer review comments over conflicting plan details", () => {
	const prompt = buildFinalReviewerPrompt(
		{
			metadata: {
				id: "PI-final-review-chronology",
				title: "Honor review feedback",
				linkedDirectory: "/repo",
				workspace: { kind: "git-worktree", path: "/repo/worktree" },
				git: {
					repoRoot: "/repo",
					baseBranch: "main",
					baseSha: "abc123",
					branchName: "pi-orchestrator/pi-final-review-chronology",
					worktreePath: "/repo/worktree",
				},
			},
			spec: "Original requirement: render the status using a plain text label.",
			plan: "Accepted plan: implement approach A by adding a blocking modal for the status.",
			comments: [
				{
					createdAt: "2026-05-11T20:00:00.000Z",
					author: "human",
					phase: "review",
					text: "In Review decision: do not use approach A; use approach B with an inline non-blocking banner instead.",
				},
			],
		},
		"Worker followed approach B with an inline non-blocking banner; reviewer noted this deviates from approach A in the plan.",
	);

	assert.match(prompt, /review the full ticket chronology/i);
	assert.match(prompt, /Guidance priority for conflicting requirements:/);
	const humanPriority = prompt.indexOf("1. Most recent explicit human comments or decisions on the ticket.");
	const statePriority = prompt.indexOf("2. Current ticket state and phase-specific instructions.");
	const planPriority = prompt.indexOf("3. The accepted implementation plan.");
	const descriptionPriority = prompt.indexOf("4. The original ticket description.");
	assert.ok(humanPriority !== -1, "prompt includes human feedback as first priority");
	assert.ok(humanPriority < statePriority && statePriority < planPriority && planPriority < descriptionPriority, "prompt orders conflicting guidance priorities");
	assert.match(prompt, /In Review decision: do not use approach A; use approach B with an inline non-blocking banner instead\./);
	assert.match(prompt, /Do not request changes solely for deviation from an older plan when the worker followed newer human feedback\./);
	assert.match(prompt, /incorrect implementations/);
	assert.match(prompt, /regressions/);
	assert.match(prompt, /incomplete required work/);
});

test("planner and final reviewer outputs parse delimited human reports with fallback", () => {
	const planner = parsePlannerOutput(
		[
			PLAN_START,
			"## Goal\nShip it.",
			PLAN_END,
			PLAN_REPORT_START,
			"# Plan Review\nReady for approval.",
			PLAN_REPORT_END,
		].join("\n"),
	);
	assert.equal(planner.plan, "## Goal\nShip it.");
	assert.equal(planner.report, "# Plan Review\nReady for approval.");

	assert.deepEqual(parsePlannerOutput("plain plan"), { plan: "plain plan", report: "plain plan" });

	const final = parseFinalReviewerOutput(
		["DECISION: PASS", REVIEW_REPORT_START, "# Review Report\nVerified.", REVIEW_REPORT_END].join("\n"),
	);
	assert.equal(final.report, "# Review Report\nVerified.");
	assert.equal(parseFinalReviewerOutput("DECISION: PASS\nNo delimiter.").report, "DECISION: PASS\nNo delimiter.");
});

test("merger output parser requires explicit merged result", () => {
	assert.deepEqual(parseMergerOutput("MERGE_RESULT: MERGED\nMerged into main.").result, "MERGED");
	assert.deepEqual(parseMergerOutput("MERGE_RESULT: BLOCKED\nBase branch dirty.").result, "BLOCKED");
	assert.deepEqual(parseMergerOutput("Plain summary without marker.").result, "BLOCKED");
});

test("merger prompt requires squash merge and Conventional Commits", () => {
	const prompt = buildMergerPrompt({
		metadata: {
			id: "PI-merge-prompt",
			title: "Merge prompt",
			linkedDirectory: "/repo",
			workspace: { kind: "git-worktree", path: "/repo/worktree" },
			git: {
				repoRoot: "/repo",
				baseBranch: "main",
				baseSha: "abc123",
				branchName: "pi-orchestrator/pi-merge-prompt",
				worktreePath: "/repo/worktree",
			},
		},
		spec: "Make the merge useful.",
		plan: "Squash branch changes.",
		reviewReport: "Ready to merge.",
		comments: [],
		events: [],
	});

	assert.match(prompt, /git merge --squash <issue-branch>/);
	assert.match(prompt, /Conventional Commit/);
	assert.match(prompt, /final base-branch commit must be a Conventional Commit/);
	assert.match(prompt, /squash commit created/);
});

test("issue store defaults new issue agent models to gpt-5.5", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Use defaults",
		spec: "Create an issue with default agent settings.",
		linkedDirectory: linked,
	});

	for (const role of ["planner", "worker", "reviewer"]) {
		assert.equal(issue.metadata.agentSettings[role].model, "openai-codex/gpt-5.5");
		assert.equal(issue.metadata.agentSettings[role].thinking, ROLE_DEFAULTS[role].thinking);
	}
});

test("issue store persists dependency metadata and creation event", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Base issue", spec: "Do this first.", linkedDirectory: linked });
	const issue = await store.createIssue({
		title: "Dependent issue",
		spec: "Wait for base issue.",
		linkedDirectory: linked,
		dependencyIssueId: dependency.metadata.id,
	});

	assert.deepEqual(issue.metadata.dependencies, { issueId: dependency.metadata.id, resolvedAt: null });
	assert.equal(issue.events[0].type, "issue_created");
	assert.equal(issue.events[0].dependencyIssueId, dependency.metadata.id);
	assert.equal(issue.events[0].dependencyTitle, dependency.metadata.title);

	const state = await store.getBoardState();
	assert.equal(state.issues.find((entry) => entry.id === issue.metadata.id).dependencies.issueId, dependency.metadata.id);
});

test("issue store rejects a missing dependency issue", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	await assert.rejects(
		() =>
			store.createIssue({
				title: "Blocked on missing",
				spec: "This should fail.",
				linkedDirectory: linked,
				dependencyIssueId: "PI-missing",
			}),
		/Dependency issue does not exist: PI-missing/,
	);
});

test("issue store rejects an already resolved non-git dependency issue", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Finished first", spec: "Already done.", linkedDirectory: linked });
	await store.setLane(dependency.metadata.id, LANE.COMPLETED, "test");

	await assert.rejects(
		() =>
			store.createIssue({
				title: "Too late",
				spec: "Cannot depend on done work.",
				linkedDirectory: linked,
				dependencyIssueId: dependency.metadata.id,
			}),
		/Dependency issue is already resolved/,
	);
});

test("issue store creates, updates, and sends backlog issues", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Backlog idea",
		spec: "Save this for later.",
		linkedDirectory: linked,
		backlog: true,
	});

	assert.equal(issue.metadata.lane, LANE.BACKLOG);
	assert.equal(issue.events[0].backlog, true);
	assert.equal(issue.events[0].lane, LANE.BACKLOG);
	let state = await store.getBoardState();
	assert.deepEqual(state.lanes[LANE.BACKLOG], [issue.metadata.id]);

	const updated = await store.updateBacklogIssue(issue.metadata.id, {
		title: "Renamed backlog idea",
		spec: "Edited spec.",
		linkedDirectory: linked,
		agentSettings: { planner: { model: "planner-x", thinking: "high" } },
	});
	assert.equal(updated.metadata.id, issue.metadata.id);
	assert.equal(updated.metadata.title, "Renamed backlog idea");
	assert.equal(updated.spec, "Edited spec.\n");
	assert.equal(updated.metadata.agentSettings.planner.model, "planner-x");
	assert.equal(updated.events.some((event) => event.type === "backlog_issue_updated"), true);

	const sent = await store.sendBacklogIssueToAgent(issue.metadata.id);
	assert.equal(sent.metadata.lane, LANE.CREATED);
	assert.equal(sent.metadata.automation.paused, false);
	assert.equal(sent.metadata.automation.error, null);
	assert.equal(sent.events.some((event) => event.type === "backlog_issue_sent_to_agent"), true);
	state = await store.getBoardState();
	assert.deepEqual(state.lanes[LANE.BACKLOG], []);
	assert.deepEqual(state.lanes[LANE.CREATED], [issue.metadata.id]);
});

test("issue store rejects sending a backlog issue blocked by another backlog issue", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Backlog dependency", spec: "First.", linkedDirectory: linked, backlog: true });
	const issue = await store.createIssue({
		title: "Blocked backlog",
		spec: "Second.",
		linkedDirectory: linked,
		backlog: true,
		dependencyIssueId: dependency.metadata.id,
	});

	await assert.rejects(
		() => store.sendBacklogIssueToAgent(issue.metadata.id),
		/Cannot send to agent while dependency .* is still in Backlog/,
	);
	assert.equal((await store.loadIssue(issue.metadata.id)).metadata.lane, LANE.BACKLOG);
});

test("issue store lists a built-in default profile when profiles file is absent", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const profiles = await store.listProfiles();

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].id, DEFAULT_PROFILE_ID);
	assert.equal(profiles[0].name, "Default");
	assert.deepEqual(profiles[0].agentSettings, {
		planner: ROLE_DEFAULTS.planner,
		worker: ROLE_DEFAULTS.worker,
		reviewer: ROLE_DEFAULTS.reviewer,
	});
});

test("issue store saves named profiles and normalizes invalid thinking values", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const result = await store.saveProfile({
		name: "Fast review",
		agentSettings: {
			planner: { model: "planner-fast", thinking: "invalid" },
			worker: { model: "worker-fast", thinking: "low" },
			reviewer: { model: "reviewer-fast", thinking: "nope" },
		},
	});

	assert.equal(result.profile.name, "Fast review");
	assert.equal(result.profile.agentSettings.planner.thinking, ROLE_DEFAULTS.planner.thinking);
	assert.equal(result.profile.agentSettings.worker.thinking, "low");
	assert.equal(result.profile.agentSettings.reviewer.thinking, ROLE_DEFAULTS.reviewer.thinking);
	assert.equal(await exists(path.join(root, "profiles.json")), true);

	const reloadedStore = new IssueStore({ dataRoot: root });
	const profiles = await reloadedStore.listProfiles();
	assert.equal(profiles.some((profile) => profile.id === DEFAULT_PROFILE_ID), true);
	assert.deepEqual(profiles.find((profile) => profile.id === result.profile.id), result.profile);
});

test("workflow transitions enforce plan approval and planning loop limit", () => {
	const base = {
		id: "PI-1",
		title: "Thing",
		lane: LANE.PLAN_REVIEW,
		automation: { planningAttempts: 1, activeRunId: null, paused: false, error: null },
		approvals: {},
	};
	const approved = approvePlan(base, "2026-01-01T00:00:00.000Z");
	assert.equal(approved.lane, LANE.IN_PROGRESS);
	assert.equal(approved.approvals.planApprovedAt, "2026-01-01T00:00:00.000Z");

	const changed = requestPlanChanges(base);
	assert.equal(changed.lane, LANE.PLANNING);
	assert.equal(changed.automation.paused, false);

	const exhausted = requestPlanChanges({
		...base,
		automation: { ...base.automation, planningAttempts: 3 },
	});
	assert.equal(exhausted.lane, LANE.PLAN_REVIEW);
	assert.equal(exhausted.automation.paused, true);
});

test("review change requests restart implementation after loop exhaustion", () => {
	const base = {
		id: "PI-1",
		title: "Thing",
		lane: LANE.IN_REVIEW,
		automation: {
			implementationAttempts: 3,
			activeRunId: "stale-run",
			activeRole: "worker",
			paused: true,
			error: "Implementation loop limit reached after 3 attempts.",
		},
		approvals: { reviewApprovedAt: "2026-01-01T00:00:00.000Z" },
	};

	const changed = requestReviewChanges(base, "2026-01-02T00:00:00.000Z");
	assert.equal(changed.lane, LANE.IN_PROGRESS);
	assert.equal(changed.automation.implementationAttempts, 0);
	assert.equal(changed.automation.paused, false);
	assert.equal(changed.automation.error, null);
	assert.equal(changed.automation.activeRunId, null);
	assert.equal(changed.automation.activeRole, null);
	assert.equal(changed.approvals.reviewApprovedAt, null);
});

test("workflow dependency resolution handles non-git and git completion rules", () => {
	assert.equal(isDependencyResolved(normalizeMetadata({ lane: LANE.IN_REVIEW })), false);
	assert.equal(isDependencyResolved(normalizeMetadata({ lane: LANE.COMPLETED, git: null })), true);
	assert.equal(
		isDependencyResolved(
			normalizeMetadata({
				lane: LANE.COMPLETED,
				workspace: { kind: "git-worktree" },
				git: { finalCommitSha: "abc" },
			}),
		),
		false,
	);
	assert.equal(
		isDependencyResolved(
			normalizeMetadata({
				lane: LANE.COMPLETED,
				git: { finalCommitSha: "abc", mergeCommitSha: "def" },
			}),
		),
		true,
	);
	assert.equal(
		isDependencyResolved(
			normalizeMetadata({
				lane: LANE.COMPLETED,
				git: { mergedAt: "2026-01-01T00:00:00.000Z" },
			}),
		),
		true,
	);
});

test("branch name helper uses orchestrator namespace", () => {
	assert.match(branchNameForIssue("PI-123", "Fix auth flow!"), /^pi-orchestrator\/pi-123-fix-auth-flow/);
});

test("workspace manager creates a central git worktree and completion commit", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Update readme",
		spec: "Update the readme.",
		linkedDirectory: repo,
	});
	const workspace = await ensureIssueWorkspace(store, issue);
	assert.equal(workspace.kind, "git-worktree");
	assert.match(workspace.path, new RegExp(`${escapeRegExp(path.join(root, "worktrees"))}`));

	await fsp.writeFile(path.join(workspace.path, "README.md"), "after\n", "utf-8");
	await store.setLane(issue.metadata.id, LANE.IN_REVIEW, "test");
	const commit = await commitIssueWorktree(store, issue.metadata.id);
	assert.equal(commit.kind, "git");
	assert.match(commit.commitSha, /^[a-f0-9]{40}$/);
	const subject = (await git(["log", "-1", "--pretty=%s"], workspace.path)).stdout.trim();
	assert.equal(subject, "chore(orchestrator): complete Update readme");

	const reloaded = await store.loadIssue(issue.metadata.id);
	const completed = approveReview(reloaded.metadata);
	assert.equal(completed.lane, LANE.COMPLETED);
});

test("approve and merge starts merger rpc role and completes after squash merge", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();

	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const issue = await runtime.store.createIssue({
		title: "Merge readme update",
		spec: "Update the readme and merge it.",
		linkedDirectory: repo,
	});
	const workspace = await ensureIssueWorkspace(runtime.store, issue);
	await runtime.store.writePlan(issue.metadata.id, "Update README.md.");
	await runtime.store.writeReviewReport(issue.metadata.id, "Human review says this is ready.");
	await fsp.writeFile(path.join(workspace.path, "README.md"), "after\n", "utf-8");
	await runtime.store.setLane(issue.metadata.id, LANE.IN_REVIEW, "test");
	const prepared = await runtime.store.loadIssue(issue.metadata.id);
	const calls = [];
	runtime.runner = {
		run: async ({ role, cwd, prompt, onRunStarted }) => {
			calls.push({ role, cwd, prompt });
			assert.equal(role, "merger");
			assert.equal(await fsp.realpath(cwd), await fsp.realpath(repo));
			assert.match(prompt, /Update the readme and merge it/);
			assert.match(prompt, /Update README\.md/);
			assert.match(prompt, /Human review says this is ready/);
			assert.match(prompt, /git merge --squash/);
			assert.match(prompt, /Conventional Commit/);
			if (onRunStarted) await onRunStarted("merge-run");
			await git(["add", "-A"], workspace.path);
			await git(["commit", "-m", "chore(orchestrator): complete merge readme update"], workspace.path);
			await git(["merge", "--squash", prepared.metadata.git.branchName], repo);
			await git(["commit", "-m", "feat: update readme"], repo);
			return { runId: "merge-run", text: "MERGE_RESULT: MERGED\nSquash commit created on the base branch." };
		},
		stopAll: async () => {},
	};

	await runtime.createActions().approveReviewAndMerge(issue.metadata.id);
	await waitFor(async () => (await runtime.store.loadIssue(issue.metadata.id)).metadata.lane === LANE.COMPLETED);

	const completed = await runtime.store.loadIssue(issue.metadata.id);
	assert.equal(calls.length, 1);
	assert.equal(completed.metadata.git.mergedToBranch, baseBranch);
	assert.match(completed.metadata.git.mergeCommitSha, /^[a-f0-9]{40}$/);
	assert.equal(completed.metadata.git.mergeCommitSha, (await git(["rev-parse", baseBranch], repo)).stdout.trim());
	assert.equal((await git(["log", "-1", "--pretty=%s"], repo)).stdout.trim(), "feat: update readme");
	let issueBranchIsAncestor = true;
	try {
		await git(["merge-base", "--is-ancestor", prepared.metadata.git.branchName, baseBranch], repo);
	} catch {
		issueBranchIsAncestor = false;
	}
	assert.equal(issueBranchIsAncestor, false, "squash-merged issue branch should not need to be a base ancestor");
	assert.equal(await fsp.readFile(path.join(repo, "README.md"), "utf-8"), "after\n");
	assert.equal(completed.events.some((event) => event.type === "review_approved_and_merged"), true);
});

test("approve and merge rejects another active merge targeting the same repo and base branch", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();

	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const first = await runtime.store.createIssue({
		title: "First merge",
		spec: "Merge this first.",
		linkedDirectory: repo,
	});
	const second = await runtime.store.createIssue({
		title: "Second merge",
		spec: "Do not merge while first is active.",
		linkedDirectory: repo,
	});
	await ensureIssueWorkspace(runtime.store, first);
	await ensureIssueWorkspace(runtime.store, second);
	const firstPrepared = await runtime.store.loadIssue(first.metadata.id);
	const repoRoot = firstPrepared.metadata.git.repoRoot;
	await runtime.store.setLane(first.metadata.id, LANE.IN_REVIEW, "test");
	await runtime.store.setLane(second.metadata.id, LANE.IN_REVIEW, "test");

	let releaseMerge;
	const mergeGate = new Promise((resolve) => {
		releaseMerge = resolve;
	});
	const calls = [];
	runtime.runner = {
		run: async ({ role, onRunStarted }) => {
			calls.push(role);
			if (onRunStarted) await onRunStarted("merge-run-1");
			await mergeGate;
			return { runId: "merge-run-1", text: "MERGE_RESULT: BLOCKED\nStopped by test." };
		},
		stopAll: async () => {},
	};

	await runtime.createActions().approveReviewAndMerge(first.metadata.id);
	await waitFor(
		async () => (await runtime.store.loadIssue(first.metadata.id)).metadata.automation.activeRunId === "merge-run-1",
	);

	await assert.rejects(
		() => runtime.createActions().approveReviewAndMerge(second.metadata.id),
		new RegExp(`Another merge is already active for ${escapeRegExp(baseBranch)} in ${escapeRegExp(repoRoot)}`),
	);
	const unchanged = await runtime.store.loadIssue(second.metadata.id);
	assert.equal(unchanged.metadata.lane, LANE.IN_REVIEW);
	assert.equal(unchanged.metadata.automation.activeRunId, null);

	releaseMerge();
	await waitFor(async () => (await runtime.store.loadIssue(first.metadata.id)).metadata.automation.activeRunId === null);
	assert.deepEqual(calls, ["merger"]);
});

test("rpc runner rejects a process that exits before agent_end", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Run fake worker",
		spec: "Exercise runner failure.",
		linkedDirectory: linked,
	});
	const fakeRpc = path.join(root, "fake-rpc.mjs");
	await fsp.writeFile(
		fakeRpc,
		[
			"#!/usr/bin/env node",
			"let buffer = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => {",
			"  buffer += chunk;",
			"  const index = buffer.indexOf('\\n');",
			"  if (index === -1) return;",
			"  const command = JSON.parse(buffer.slice(0, index));",
			"  const response = { id: command.id, type: 'response', command: command.type, success: true };",
			"  process.stdout.write(JSON.stringify(response) + '\\n', () => process.exit(0));",
			"});",
			"setTimeout(() => process.exit(0), 5000).unref();",
			"",
		].join("\n"),
		"utf-8",
	);
	await fsp.chmod(fakeRpc, 0o755);

	const runner = new RpcAgentRunner({ store, command: fakeRpc, timeoutMs: 2000, idleTimeoutMs: 0 });
	await assert.rejects(
		() =>
			runner.run({
				issueId: issue.metadata.id,
				role: "worker",
				cwd: linked,
				prompt: "hello",
			}),
		/before agent_end/,
	);

	const runs = await fsp.readdir(path.join(root, "issues", issue.metadata.id, "runs"));
	const log = await fsp.readFile(path.join(root, "issues", issue.metadata.id, "runs", runs[0]), "utf-8");
	assert.match(log, /"type":"process_exit"/);
});

test("rpc runner can reuse an existing session file", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Resume runner",
		spec: "Reuse session.",
		linkedDirectory: linked,
	});
	const argvPath = path.join(root, "argv.json");
	const existingSession = path.join(root, "sessions", issue.metadata.id, "existing-worker.jsonl");
	await fsp.mkdir(path.dirname(existingSession), { recursive: true });
	await fsp.writeFile(existingSession, "", "utf-8");
	const fakeRpc = path.join(root, "fake-rpc.mjs");
	await fsp.writeFile(
		fakeRpc,
		[
			"#!/usr/bin/env node",
			"import * as fs from 'node:fs';",
			`fs.writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)));`,
			"let buffer = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', async (chunk) => {",
			"  buffer += chunk;",
			"  const index = buffer.indexOf('\\n');",
			"  if (index === -1) return;",
			"  const command = JSON.parse(buffer.slice(0, index));",
			"  console.log(JSON.stringify({ id: command.id, type: 'response', command: command.type, success: true }));",
			"  const message = { role: 'assistant', content: [{ type: 'text', text: 'resumed' }] };",
			"  console.log(JSON.stringify({ type: 'message_end', message }));",
			"  console.log(JSON.stringify({ type: 'agent_end', messages: [message] }));",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf-8",
	);
	await fsp.chmod(fakeRpc, 0o755);

	const runner = new RpcAgentRunner({ store, command: fakeRpc, timeoutMs: 2000, idleTimeoutMs: 0 });
	const result = await runner.run({
		issueId: issue.metadata.id,
		role: "worker",
		cwd: linked,
		prompt: "resume",
		sessionFile: existingSession,
	});

	const argv = JSON.parse(await fsp.readFile(argvPath, "utf-8"));
	assert.equal(argv[argv.indexOf("--session") + 1], existingSession);
	assert.equal(result.sessionFile, existingSession);
	assert.equal(result.text, "resumed");
});

test("rpc runner persists streaming lifecycle events with oversized payload truncation", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Compact run log",
		spec: "Avoid large stream logs.",
		linkedDirectory: linked,
	});
	const fakeRpc = path.join(root, "fake-rpc.mjs");
	await fsp.writeFile(
		fakeRpc,
		[
			"#!/usr/bin/env node",
			"let buffer = '';",
			"const emit = (event) => new Promise((resolve) => process.stdout.write(JSON.stringify(event) + '\\n', resolve));",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', async (chunk) => {",
			"  buffer += chunk;",
			"  const index = buffer.indexOf('\\n');",
			"  if (index === -1) return;",
			"  const command = JSON.parse(buffer.slice(0, index));",
			"  await emit({ id: command.id, type: 'response', command: command.type, success: true });",
			"  await emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'x'.repeat(1024 * 1024) } });",
			"  const message = { role: 'assistant', content: [{ type: 'text', text: 'finished' }] };",
			"  await emit({ type: 'message_end', message });",
			"  await emit({ type: 'agent_end', messages: [message] });",
			"  process.exit(0);",
			"});",
			"",
		].join("\n"),
		"utf-8",
	);
	await fsp.chmod(fakeRpc, 0o755);

	const runner = new RpcAgentRunner({ store, command: fakeRpc, timeoutMs: 2000, idleTimeoutMs: 0 });
	const result = await runner.run({
		issueId: issue.metadata.id,
		role: "worker",
		cwd: linked,
		prompt: "hello",
	});

	const runs = await fsp.readdir(path.join(root, "issues", issue.metadata.id, "runs"));
	const logPath = path.join(root, "issues", issue.metadata.id, "runs", runs[0]);
	const log = await fsp.readFile(logPath, "utf-8");
	const stats = await fsp.stat(logPath);
	assert.equal(result.text, "finished");
	assert.match(log, /message_update/);
	assert.match(log, /"truncated":true/);
	assert.ok(stats.size < 16 * 1024, `run log should stay compact, got ${stats.size} bytes`);
	const events = log.trim().split("\n").map((line) => JSON.parse(line));
	assert.equal(events.some((event) => event.type === "message_update" && event.truncated), true);
	assert.equal(events.some((event) => event.type === "message_end"), true);
});

test("scheduler startup recovers interrupted active runs", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Recover worker",
		spec: "Recover stale worker state.",
		linkedDirectory: linked,
	});
	await store.updateMetadata(issue.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		automation: {
			...metadata.automation,
			activeRunId: "starting",
			activeRole: "worker",
			paused: false,
			error: null,
		},
	}));

	const scheduler = new OrchestratorScheduler({
		store,
		runner: { stopAll: async () => {} },
	});
	await scheduler.recoverInterruptedRuns();

	const recovered = await store.loadIssue(issue.metadata.id);
	assert.equal(recovered.metadata.automation.activeRunId, null);
	assert.equal(recovered.metadata.automation.activeRole, null);
	assert.equal(recovered.metadata.automation.paused, false);
	assert.equal(recovered.metadata.automation.error, null);
	assert.equal(recovered.events.some((event) => event.type === "interrupted_run_recovered"), true);
});

test("scheduler writes parsed plan and plan review report after planning", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Plan report issue",
		spec: "Create a plan and report.",
		linkedDirectory: linked,
	});
	const runner = planningRunner();
	const scheduler = new OrchestratorScheduler({ store, runner });
	await scheduler.runPlanning(issue.metadata.id, new AbortController().signal);

	const planned = await store.loadIssue(issue.metadata.id);
	assert.equal(planned.metadata.lane, LANE.PLAN_REVIEW);
	assert.equal(planned.plan.trim(), "## Goal\nImplement the feature.");
	assert.equal(planned.planReport.trim(), "# Plan Review\nThis plan is ready for human approval.");
});

test("scheduler does not start planning for backlog issues", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Backlog should wait",
		spec: "Do not plan yet.",
		linkedDirectory: linked,
		backlog: true,
	});
	let calls = 0;
	const scheduler = new OrchestratorScheduler({
		store,
		runner: {
			run: async () => {
				calls += 1;
				return { runId: "planner-run", text: "should not run" };
			},
			stopAll: async () => {},
		},
	});

	await scheduler.tick();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(calls, 0);
	assert.equal((await store.loadIssue(issue.metadata.id)).metadata.lane, LANE.BACKLOG);
});

test("scheduler does not start planning while dependency is unresolved", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Dependency work", spec: "Finish me first.", linkedDirectory: linked });
	await store.setLane(dependency.metadata.id, LANE.IN_REVIEW, "test");
	const issue = await store.createIssue({
		title: "Blocked planning",
		spec: "Wait before planning.",
		linkedDirectory: linked,
		dependencyIssueId: dependency.metadata.id,
	});
	let calls = 0;
	const scheduler = new OrchestratorScheduler({
		store,
		runner: {
			run: async () => {
				calls += 1;
				return { runId: "planner-run", text: "should not run" };
			},
			stopAll: async () => {},
		},
	});

	await scheduler.tick();
	await new Promise((resolve) => setTimeout(resolve, 50));
	const blocked = await store.loadIssue(issue.metadata.id);
	assert.equal(calls, 0);
	assert.equal(blocked.metadata.lane, LANE.CREATED);
	assert.equal(blocked.metadata.dependencies.resolvedAt, null);
	assert.equal(blocked.metadata.automation.paused, false);
});

test("scheduler starts planning once a non-git dependency is completed", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Non git dependency", spec: "Finish me first.", linkedDirectory: linked });
	const issue = await store.createIssue({
		title: "Unblocked planning",
		spec: "Start after dependency.",
		linkedDirectory: linked,
		dependencyIssueId: dependency.metadata.id,
	});
	const runner = planningRunner();
	const scheduler = new OrchestratorScheduler({ store, runner });

	await store.setLane(dependency.metadata.id, LANE.COMPLETED, "test");
	await scheduler.tick();
	await waitFor(async () => (await store.loadIssue(issue.metadata.id)).metadata.lane === LANE.PLAN_REVIEW);

	const planned = await store.loadIssue(issue.metadata.id);
	assert.equal(runner.calls.length, 1);
	assert.match(planned.metadata.dependencies.resolvedAt, /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(planned.events.some((event) => event.type === "dependency_resolved"), true);
});

test("scheduler requires git dependencies to be completed and merged before planning", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const dependency = await store.createIssue({ title: "Git dependency", spec: "Finish and merge me.", linkedDirectory: repo });
	await ensureIssueWorkspace(store, dependency);
	await store.setLane(dependency.metadata.id, LANE.COMPLETED, "approved without merge");
	const issue = await store.createIssue({
		title: "Git blocked planning",
		spec: "Wait for merge.",
		linkedDirectory: repo,
		dependencyIssueId: dependency.metadata.id,
	});
	const runner = planningRunner();
	const scheduler = new OrchestratorScheduler({ store, runner });

	await scheduler.tick();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(runner.calls.length, 0);
	assert.equal((await store.loadIssue(issue.metadata.id)).metadata.lane, LANE.CREATED);

	await store.updateMetadata(dependency.metadata.id, (metadata) => ({
		...metadata,
		git: { ...metadata.git, mergeCommitSha: "abc123", mergedAt: "2026-01-01T00:00:00.000Z" },
	}));
	await scheduler.tick();
	await waitFor(async () => (await store.loadIssue(issue.metadata.id)).metadata.lane === LANE.PLAN_REVIEW);
	assert.equal(runner.calls.length, 1);
});

test("scheduler passes stored session file to resumed worker run", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Scheduler resume",
		spec: "Continue from the worker session.",
		linkedDirectory: linked,
	});
	const resumeSessionFile = path.join(root, "sessions", issue.metadata.id, "worker-old.jsonl");
	await fsp.mkdir(path.dirname(resumeSessionFile), { recursive: true });
	await fsp.writeFile(resumeSessionFile, "{}\n", "utf-8");
	await store.updateMetadata(issue.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		automation: {
			...metadata.automation,
			implementationAttempts: 2,
			paused: false,
			error: null,
			activeRunId: null,
			activeRole: null,
			resumeSessionFile,
			resumeRunId: "worker-old",
		},
	}));
	const calls = [];
	const runner = {
		calls,
		run: async (request) => {
			calls.push(request);
			await request.onRunStarted?.(`${request.role}-new`);
			if (request.role === "worker") return { runId: "worker-new", text: "worker continued" };
			if (request.role === "reviewer") return { runId: "reviewer-new", text: "DECISION: PASS\nLooks good." };
			return {
				runId: "final-reviewer-new",
				text: ["DECISION: PASS", REVIEW_REPORT_START, "# Review\nReady.", REVIEW_REPORT_END].join("\n"),
			};
		},
		stopAll: async () => {},
	};
	const scheduler = new OrchestratorScheduler({ store, runner });

	await scheduler.runImplementation(issue.metadata.id, new AbortController().signal);

	assert.equal(calls[0].role, "worker");
	assert.equal(calls[0].sessionFile, resumeSessionFile);
	assert.equal(calls[1].sessionFile, undefined);
	const resumed = await store.loadIssue(issue.metadata.id);
	assert.equal(resumed.metadata.lane, LANE.IN_REVIEW);
	assert.equal(resumed.metadata.automation.implementationAttempts, 2);
	assert.equal(resumed.metadata.automation.resumeSessionFile, null);
	assert.equal(resumed.metadata.automation.resumeRunId, null);
	assert.equal(resumed.events.some((event) => event.type === "implementation_resume_started" && event.resumeRunId === "worker-old" && event.resumeSessionFile === resumeSessionFile), true);
});

test("scheduler writes fallback review report when implementation loop is exhausted", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Needs human review",
		spec: "Exercise exhausted implementation reporting.",
		linkedDirectory: linked,
	});
	const scheduler = new OrchestratorScheduler({
		store,
		runner: { stopAll: async () => {} },
	});
	await scheduler.pauseImplementationExhausted(issue.metadata.id, "Reviewer said tests are missing.");

	const review = await store.loadIssue(issue.metadata.id);
	assert.equal(review.metadata.lane, LANE.IN_REVIEW);
	assert.equal(review.metadata.automation.paused, true);
	assert.match(review.reviewReport, /Implementation Review Requires Human Attention/);
	assert.match(review.reviewReport, /Reviewer said tests are missing/);
});

function planningRunner() {
	const calls = [];
	return {
		calls,
		run: async ({ onRunStarted, role, prompt }) => {
			calls.push({ role, prompt });
			if (onRunStarted) await onRunStarted("planner-run");
			return {
				runId: "planner-run",
				text: [
					PLAN_START,
					"## Goal\nImplement the feature.",
					PLAN_END,
					PLAN_REPORT_START,
					"# Plan Review\nThis plan is ready for human approval.",
					PLAN_REPORT_END,
				].join("\n"),
			};
		},
		stopAll: async () => {},
	};
}

async function createBlockedWorkerIssue(store, linkedDirectory, { title = "Blocked worker", runId = "worker-run", createSession = true } = {}) {
	const issue = await store.createIssue({
		title,
		spec: "Resume blocked work.",
		linkedDirectory,
	});
	await store.updateMetadata(issue.metadata.id, (metadata) => ({
		...metadata,
		lane: LANE.IN_PROGRESS,
		automation: {
			...metadata.automation,
			implementationAttempts: 1,
			paused: true,
			error: "Worker stopped.",
			activeRunId: null,
			activeRole: null,
		},
	}));
	await store.appendEvent(issue.metadata.id, { type: "agent_run_started", role: "worker", runId });
	const sessionFile = path.join(store.sessionsRoot, issue.metadata.id, `${runId}.jsonl`);
	if (createSession) {
		await fsp.mkdir(path.dirname(sessionFile), { recursive: true });
		await fsp.writeFile(sessionFile, JSON.stringify({ type: "message", text: "previous work" }) + "\n", "utf-8");
	}
	return store.loadIssue(issue.metadata.id);
}

async function patchIssueMetadata(store, id, patch) {
	const metadataPath = store.issuePath(id, "metadata.json");
	const metadata = JSON.parse(await fsp.readFile(metadataPath, "utf-8"));
	await fsp.writeFile(metadataPath, `${JSON.stringify({ ...metadata, ...patch }, null, "\t")}\n`, "utf-8");
}

async function exists(filePath) {
	try {
		await fsp.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(predicate, timeoutMs = 2000) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	assert.fail(`condition was not met within ${timeoutMs}ms`);
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
