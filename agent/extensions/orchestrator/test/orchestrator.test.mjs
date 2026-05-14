import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { assembleAgentSession, sanitizeAgentStreamEvent } from "../src/agent-session.js";
import { COMPLETED_TICKET_CLEANUP_RETENTION_DAYS, DEFAULT_PROFILE_ID, KANBAN_LANES, LANE, LANES, ROLE_DEFAULTS, ROLE_TOOLS } from "../src/constants.js";
import { getIssueDiffs } from "../src/diffs.js";
import {
	PLAN_END,
	PLAN_REPORT_END,
	PLAN_REPORT_START,
	PLAN_START,
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
	FEATURE_SUGGESTIONS_END,
	FEATURE_SUGGESTIONS_START,
	buildFeatureSuggestorPrompt,
	buildFinalReviewerPrompt,
	buildMergerPrompt,
	buildSpecWriterPrompt,
	parseFeatureSuggestorOutput,
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
const DASHBOARD_JS_SOURCE = readFileSync(new URL("../src/ui/dashboard.js", import.meta.url), "utf8");
const DASHBOARD_CSS_SOURCE = readFileSync(new URL("../src/ui/dashboard.css", import.meta.url), "utf8");

async function tempDir() {
	return fsp.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-"));
}

async function git(args, cwd) {
	return execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
}

async function initGitRepoWithMain(repo) {
	try {
		await git(["init", "-b", "main"], repo);
	} catch {
		await git(["init"], repo);
		await git(["checkout", "-B", "main"], repo);
	}
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "initial\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
}

function dashboardNotificationTestSource() {
	const start = DASHBOARD_JS_SOURCE.indexOf("const HUMAN_INTERVENTION_LANES = new Set");
	const end = DASHBOARD_JS_SOURCE.indexOf("function resetSpecWriterState()", start);
	assert.ok(start !== -1, "dashboard script declares notification state");
	assert.ok(end > start, "dashboard script keeps notification helpers before spec writer helpers");
	return DASHBOARD_JS_SOURCE.slice(start, end);
}

function dashboardDraftTestSource() {
	const start = DASHBOARD_JS_SOURCE.indexOf("let state = { issues: [], lanes: {} };");
	const end = DASHBOARD_JS_SOURCE.indexOf("function populateLaneFilter()", start);
	assert.ok(start !== -1, "dashboard script declares mutable state");
	assert.ok(end > start, "dashboard script exposes load before DOM event bindings");
	return DASHBOARD_JS_SOURCE.slice(start, end);
}

function dashboardCleanupTestSource(html) {
	return `${dashboardDraftTestSource(html)}\nglobalThis.__dashboardCleanup = { cleanCompletedTickets, updateCleanCompletedButton, get loading() { return cleanupCompletedLoading; } };\n`;
}

function dashboardBacklogSuggestionTestSource(html) {
	return `${dashboardDraftTestSource(html)}\nglobalThis.__dashboardBacklogSuggestions = {\n\tsetState(nextState) { state = nextState; projects = Array.isArray(nextState.projects) ? nextState.projects : []; },\n\tsetProjects(nextProjects) { projects = nextProjects; state = { ...state, projects: nextProjects }; },\n\tupdateBacklogSuggestionControls,\n\tstartBacklogSuggestions,\n\tstatusText: backlogSuggestionStatusText,\n\tisActive: backlogSuggestionIsActive,\n};\n`;
}

function dashboardProjectTestSource(html) {
	return `${dashboardDraftTestSource(html)}\nglobalThis.__dashboardProject = {\n\tsetProjects(nextProjects) { projects = nextProjects; state = { ...state, projects: nextProjects }; },\n\tsetProfiles(nextProfiles) { profiles = nextProfiles; },\n\tselectProject(id) { selectedProjectId = id; },\n\tsetIssueFormMode(mode) { issueFormMode = mode; },\n\tsetBranchMode(mode) { branchMode = mode; },\n\tget branchMode() { return branchMode; },\n\tget selectedProfileId() { return selectedProfileId; },\n\tget agentSettingsDirtyByUser() { return agentSettingsDirtyByUser; },\n\tgetProject(id) { return projectById(id); },\n\tisProjectRefreshing,\n\tprojectRefreshError,\n\tpopulateLinkedDirectoryOptions,\n\trefreshSelectedProjectGitState,\n\trenderGitBranchControls,\n\trenderAgentSettingsControls,\n\trenderProfileSelect,\n\trenderProjectProfileSelect,\n\tprojectConfiguredProfile,\n\tapplyProjectAgentSettingsDefault,\n\tapplyAgentSettings,\n\tmarkAgentSettingsDirtyByUser,\n\tselectAgentSettingsProfile(id) { selectedProfileId = id; renderProfileSelect(); applyAgentSettings(profileById(selectedProfileId).agentSettings); markAgentSettingsDirtyByUser(); },\n\tcurrentAgentSettingsFromDom,\n\tupdateBranchValidationMessage,\n\tsaveProjectFromForm,\n\tsaveInlineProject,\n};\n`;
}

function dashboardProjectVmContext(ids = []) {
	const elements = new Map();
	class FakeElement {
		constructor(id) {
			this.id = id;
			this.value = "";
			this.textContent = "";
			this.hidden = false;
			this.disabled = false;
			this.options = [];
			this._innerHTML = "";
			this.validationMessage = "";
		}
		set innerHTML(value) {
			this._innerHTML = String(value);
			this.options = Array.from(this._innerHTML.matchAll(/<option value='([^']*)'/g), (match) => ({ value: match[1] }));
			if (this.options.length && !this.value) this.value = this.options[0].value;
		}
		get innerHTML() {
			return this._innerHTML;
		}
		setCustomValidity(message) {
			this.validationMessage = String(message || "");
		}
		focus() {}
	}
	for (const id of ids) elements.set(id, new FakeElement(id));
	return {
		DEFAULT_PROFILE_ID,
		LANE,
		ROLE_DEFAULTS,
		PROFILE_ROLES: ["planner", "worker", "reviewer"],
		THINKING_LEVELS: ["low", "medium", "high", "xhigh"],
		document: {
			getElementById(id) {
				return elements.get(id) || null;
			},
			querySelectorAll() {
				return [];
			},
		},
		window: { innerWidth: 1200, matchMedia: () => ({ matches: false }) },
		fetch: async () => { throw new Error("unexpected fetch"); },
		setTimeout(fn) { fn(); },
		alert(message) { throw new Error(message); },
	};
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
		PROFILE_ROLES: ["planner", "worker", "reviewer"],
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
		LANE,
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

function dashboardResumeTestSource() {
	const resumeHelpersStart = DASHBOARD_JS_SOURCE.indexOf("function issueById(id)");
	const resumeHelpersEnd = DASHBOARD_JS_SOURCE.indexOf("function issueState(issue)", resumeHelpersStart);
	const postResumeStart = DASHBOARD_JS_SOURCE.indexOf("async function postResumeIssue(id)");
	const escapeStart = DASHBOARD_JS_SOURCE.indexOf("function escapeHtml(value)", postResumeStart);
	const escapeEnd = DASHBOARD_JS_SOURCE.indexOf("function renderInlineMarkdown(value)", escapeStart);
	assert.ok(resumeHelpersStart !== -1 && resumeHelpersEnd > resumeHelpersStart, "dashboard script declares resume helpers");
	assert.ok(postResumeStart !== -1 && escapeStart > postResumeStart && escapeEnd > escapeStart, "dashboard script declares resume action helpers");
	return [
		"let state = { issues: [], lanes: {} };\n",
		"const pendingResumeIssueIds = new Set();\n",
		DASHBOARD_JS_SOURCE.slice(resumeHelpersStart, resumeHelpersEnd),
		DASHBOARD_JS_SOURCE.slice(postResumeStart, escapeEnd),
		`\nglobalThis.__dashboardResume = {\n\tsetState(next) { state = next; },\n\tresumeEligibility,\n\tresumeDisabledReason,\n\trenderResumeAction,\n\tpostResumeIssue,\n\tisPending(id) { return pendingResumeIssueIds.has(id); },\n};\n`,
	].join("");
}

function dashboardAgentSessionTestSource() {
	const agentStart = DASHBOARD_JS_SOURCE.indexOf("function agentSessionKey(issueId, runId)");
	const agentEnd = DASHBOARD_JS_SOURCE.indexOf("function renderDetail()", agentStart);
	const timelineStart = DASHBOARD_JS_SOURCE.indexOf("function renderTimeline(issue)");
	const timelineEnd = DASHBOARD_JS_SOURCE.indexOf("function bindDetailActions(issue)", timelineStart);
	const eventStart = DASHBOARD_JS_SOURCE.indexOf("function handleEventStreamMessage(message)");
	const eventEnd = DASHBOARD_JS_SOURCE.indexOf("function updateCleanCompletedButton()", eventStart);
	const escapeStart = DASHBOARD_JS_SOURCE.indexOf("function escapeHtml(value)");
	const escapeEnd = DASHBOARD_JS_SOURCE.indexOf("function renderMarkdown(input)", escapeStart);
	assert.ok(agentStart !== -1 && agentEnd > agentStart, "dashboard script declares agent session helpers");
	assert.ok(timelineStart !== -1 && timelineEnd > timelineStart, "dashboard script declares timeline renderer");
	assert.ok(eventStart !== -1 && eventEnd > eventStart, "dashboard script declares event stream handler");
	assert.ok(escapeStart !== -1 && escapeEnd > escapeStart, "dashboard script declares markdown helpers");
	return [
		"const agentSessions = new Map();\nlet activeAgentStream = null;\nlet activeAgentStreamTarget = null;\nlet activeAgentStreamReady = false;\nlet selectedTimelineRunId = null;\nlet selectedTimelineSessionMissing = false;\nlet selectedId = null;\nlet detailTab = 'agent';\nlet renderDetailCalls = 0;\nlet loadCalls = 0;\nlet state = { issues: [] };\nconst TOKEN = 'test-token';\n",
		"function formatDate(value) { return value || 'unknown'; }\nfunction renderDetail() { renderDetailCalls += 1; }\nasync function load() { loadCalls += 1; }\nfunction issueById(id) { return (state.issues || []).find((issue) => issue.id === id) || null; }\n",
		DASHBOARD_JS_SOURCE.slice(agentStart, agentEnd),
		DASHBOARD_JS_SOURCE.slice(timelineStart, timelineEnd),
		DASHBOARD_JS_SOURCE.slice(eventStart, eventEnd),
		DASHBOARD_JS_SOURCE.slice(escapeStart, escapeEnd),
		`\nglobalThis.__dashboardAgentSession = {\n\tagentSessionKey,\n\tassembleAgentSessionForUi,\n\tloadAgentSession,\n\tcachedAgentSession,\n\trenderAgentSession,\n\trenderTimeline,\n\thandleEventStreamMessage,\n\thandleAgentStreamMessage,\n\tdesiredAgentStreamTarget,\n\topenAgentStream,\n\tcloseAgentStream,\n\tupdateAgentStreamSubscription,\n\tensureActiveAgentSessionLoaded,\n\tsetPayload(issueId, runId, payload) { agentSessions.set(agentSessionKey(issueId, runId), payload); },\n\tselectTimelineRun(runId) { selectedTimelineRunId = runId; selectedTimelineSessionMissing = false; },\n\tmarkTimelineMissing() { selectedTimelineSessionMissing = true; },\n\tsetSelected(issueId, tab = 'agent', runId = null) { selectedId = issueId; detailTab = tab; selectedTimelineRunId = runId; },\n\tsetState(nextState) { state = nextState; },\n\tget activeAgentStreamTarget() { return activeAgentStreamTarget; },\n\tget activeAgentStreamReady() { return activeAgentStreamReady; },\n\tget renderDetailCalls() { return renderDetailCalls; },\n\tget loadCalls() { return loadCalls; },\n};\n`,
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
	assert.equal("updates" in session.tools[0], false);
	assert.equal("output" in session.tools[0], false);
	assert.equal(session.tools[0].status, "complete");
});

test("agent session assembler marks Pi RPC isError tool results as errors", () => {
	const session = assembleAgentSession([
		{ type: "tool_execution_start", toolExecutionId: "t2", toolName: "read" },
		{ type: "tool_execution_update", toolExecutionId: "t2", partialResult: { content: [{ type: "text", text: "permission denied" }], isError: true } },
		{ type: "tool_execution_end", toolExecutionId: "t2", result: { content: [{ type: "text", text: "permission denied" }], isError: true } },
	]);
	assert.equal(session.tools.length, 1);
	assert.equal("updates" in session.tools[0], false);
	assert.equal("output" in session.tools[0], false);
	assert.equal("error" in session.tools[0], false);
	assert.equal(session.tools[0].status, "error");
});

test("agent stream sanitizer strips tool outputs while preserving messages and tool arguments", () => {
	assert.deepEqual(sanitizeAgentStreamEvent({ type: "message_update", messageId: "m1", assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } }), {
		type: "message_update",
		messageId: "m1",
		assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
	});
	const sanitized = sanitizeAgentStreamEvent({
		type: "tool_execution_end",
		toolExecutionId: "t1",
		toolName: "bash",
		arguments: { command: "echo hi" },
		result: { content: [{ type: "text", text: "large output" }], isError: false },
		stdout: "large output",
		text: "large output",
	});
	assert.deepEqual(sanitized, {
		type: "tool_execution_end",
		toolCallId: "t1",
		toolName: "bash",
		input: "{\n  \"command\": \"echo hi\"\n}",
		status: "complete",
	});
	assert.equal(sanitizeAgentStreamEvent({ type: "tool_execution_update", toolExecutionId: "t1", output: "only output" }), null);
	assert.equal(sanitizeAgentStreamEvent({ type: "tool_execution_end", result: { content: [{ type: "text", text: "only output" }] } }), null);
	assert.deepEqual(sanitizeAgentStreamEvent({ type: "tool_call_start", tool_call: { tool_call_id: "snake-1", tool_name: "grep", arguments: { pattern: "TODO" } } }), {
		type: "tool_call_start",
		toolCallId: "snake-1",
		toolName: "grep",
		input: "{\n  \"pattern\": \"TODO\"\n}",
		status: "running",
	});
});

test("agent session assembler handles malformed and interrupted streams", () => {
	const session = assembleAgentSession([
		null,
		{ type: "message_update", text: "partial" },
		{ type: "tool_call_end", toolCallId: "legacy-output-only", output: "large legacy output" },
		{ type: "tool_call_end", name: "read", error: "missing file" },
	]);
	assert.equal(session.ignoredCount, 2);
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

test("spec writer and feature suggestor roles have read-only tool and default model config", () => {
	assert.equal(ROLE_TOOLS["spec-writer"], "read,grep,find,ls");
	assert.deepEqual(ROLE_DEFAULTS["spec-writer"], {
		model: ROLE_DEFAULTS.planner.model,
		thinking: "medium",
	});
	assert.equal(ROLE_TOOLS["feature-suggestor"], "read,grep,find,ls");
	assert.deepEqual(ROLE_DEFAULTS["feature-suggestor"], {
		model: ROLE_DEFAULTS.planner.model,
		thinking: "medium",
	});
});

test("feature suggestor prompt includes project details and existing backlog context", () => {
	const prompt = buildFeatureSuggestorPrompt({
		project: { id: "project-app", name: "App", path: "/work/app" },
		existingBacklogIssues: [{ title: "Existing idea", spec: "Already improve the dashboard." }],
	});

	assert.match(prompt, /feature-suggestor/);
	assert.match(prompt, /Do not modify files/);
	assert.match(prompt, new RegExp(FEATURE_SUGGESTIONS_START));
	assert.match(prompt, new RegExp(FEATURE_SUGGESTIONS_END));
	assert.match(prompt, /- ID: project-app/);
	assert.match(prompt, /- Name: App/);
	assert.match(prompt, /- Path: \/work\/app/);
	assert.match(prompt, /Existing idea/);
	assert.match(prompt, /Already improve the dashboard/);
});

test("feature suggestor output parser validates delimiters, drops empty items, and deduplicates exact suggestions", () => {
	const valid = [
		"preamble is ignored inside strict delimiter parsing only when outside block",
		FEATURE_SUGGESTIONS_START,
		JSON.stringify([
			{ title: "  Add health check  ", spec: "  Create a status endpoint.  " },
			{ title: "", spec: "Missing title." },
			{ title: "Missing spec", spec: "" },
			{ title: "Add health check", spec: "Create a status endpoint." },
			{ title: "Fix docs", spec: "Document setup." },
		]),
		FEATURE_SUGGESTIONS_END,
	].join("\n");

	assert.deepEqual(parseFeatureSuggestorOutput(valid), [
		{ title: "Add health check", spec: "Create a status endpoint." },
		{ title: "Fix docs", spec: "Document setup." },
	]);
	assert.deepEqual(parseFeatureSuggestorOutput(`${FEATURE_SUGGESTIONS_START}\n[]\n${FEATURE_SUGGESTIONS_END}`), []);
	assert.throws(() => parseFeatureSuggestorOutput("[]"), /missing the suggestions JSON delimiters/);
	assert.throws(() => parseFeatureSuggestorOutput(`${FEATURE_SUGGESTIONS_START}\nnot-json\n${FEATURE_SUGGESTIONS_END}`), /invalid JSON/);
	assert.throws(() => parseFeatureSuggestorOutput(`${FEATURE_SUGGESTIONS_START}\n{}\n${FEATURE_SUGGESTIONS_END}`), /must be a JSON array/);
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
	const source = `${html}\n${DASHBOARD_JS_SOURCE}\n${DASHBOARD_CSS_SOURCE}`;

	assert.match(html, /<link rel="stylesheet" href="\/ui\/dashboard\.css">/);
	assert.match(html, /<script src="\/ui\/dashboard\.js"[\s\S]*data-token="&quot;test-token&quot;"[\s\S]*><\/script>/);
	assert.doesNotMatch(html, /<style>[\s\S]*<\/style>/);
	assert.doesNotMatch(html, /<script>\s*[\s\S]*?<\/script>/);

	assert.match(html, /data-token="&quot;test-token&quot;"/);
	assert.match(html, /data-lanes="\[&quot;Created&quot;,&quot;Planning&quot;/);
	assert.match(html, /&quot;Backlog&quot;/);
	assert.match(html, /data-kanban-lanes="\[&quot;Created&quot;,&quot;Planning&quot;/);
	assert.match(html, /data-lane="\{&quot;CREATED&quot;:&quot;Created&quot;/);
	assert.match(html, /&quot;BACKLOG&quot;:&quot;Backlog&quot;/);
	assert.match(html, /data-role-defaults="\{&quot;planner&quot;:/);
	assert.match(html, /data-thinking-levels="\[&quot;low&quot;,&quot;medium&quot;,&quot;high&quot;,&quot;xhigh&quot;\]"/);
	assert.match(html, /data-default-profile-id="&quot;default&quot;"/);
	assert.match(source, /const TOKEN = readDashboardConfig\("token"\);/);
	assert.match(source, /id="create-drawer"/);
	assert.match(source, /id="kanban-tab"/);
	assert.match(source, /id="backlog-tab"/);
	assert.match(source, />Kanban<\/button>/);
	assert.match(source, />Backlog<\/button>/);
	assert.match(source, /id="backlog-view"/);
	assert.match(source, /id="suggest-backlog"/);
	assert.match(source, /Suggest Backlog Items/);
	assert.match(source, /id="backlog-suggestion-status"/);
	assert.match(source, /\/api\/backlog\/suggestions/);
	assert.match(source, /function updateBacklogSuggestionControls\(\)/);
	assert.match(source, /function startBacklogSuggestions\(\)/);
	assert.match(source, /Add to Backlog/);
	assert.match(source, /Edit Issue/);
	assert.match(source, /Send to Agent/);
	assert.match(source, /data-delete-backlog/);
	assert.match(source, /class='bad' data-delete-backlog=.*Delete/);
	assert.match(source, /board\.hidden = activeView !== "kanban";/);
	assert.match(source, /backlog\.hidden = activeView !== "backlog";/);
	assert.match(source, /if \(activeView !== "kanban"\) return;\s*for \(const lane of KANBAN_LANES\)/);
	assert.match(source, /for \(const lane of KANBAN_LANES\)/);
	assert.match(source, /const KANBAN_LANES =/);
	assert.match(source, /id="enable-notifications"/);
	assert.match(source, /id="enable-notifications" class="secondary" hidden disabled/);
	assert.match(source, /id="clean-completed" class="secondary clean-completed-button"/);
	assert.match(source, /Clean completed tickets/);
	assert.match(source, /let cleanupCompletedLoading = false;/);
	assert.match(source, /async function cleanCompletedTickets\(\)/);
	assert.match(source, /api\("\/api\/issues\/clean-completed", \{ method: "POST", body: "\{\}" \}\)/);
	assert.match(source, /No old completed tickets to clean\./);
	assert.match(source, /Cleanup failed:/);
	assert.match(source, /document\.getElementById\("clean-completed"\)\.addEventListener\("click"/);
	assert.match(source, /Notification\.permission/);
	assert.match(source, /Notification\.requestPermission\(\)/);
	assert.match(source, /new Notification\(/);
	assert.match(source, /const HUMAN_INTERVENTION_LANES = new Set\(\[LANE\.PLAN_REVIEW, LANE\.IN_REVIEW\]\);/);
	assert.match(source, /function syncHumanInterventionNotifications\(nextState\)/);
	assert.match(source, /id="open-share"/);
	assert.match(source, /id="share-dialog"/);
	assert.match(source, /id="share-qr"/);
	assert.match(source, /id="open-add-project"/);
	assert.match(source, /id="projects-tab"/);
	assert.match(source, /id="projects-view"/);
	assert.match(source, /id="projectSelect" name="projectId"/);
	assert.match(source, /id="linkedDirectory" name="linkedDirectory" type="hidden"/);
	assert.match(source, /class="secondary desktop-directory-picker" id="pick-directory"/);
	assert.match(source, /id="inlineProjectName"/);
	assert.match(source, /id="inlineProjectPath"/);
	assert.match(source, /id="inlineProjectAgentSettingsProfileId"/);
	assert.match(source, /id="projectFormAgentSettingsProfileId"/);
	assert.match(source, /Default Agent Settings profile \(optional\)/);
	assert.match(source, /No project default/);
	assert.match(source, /id="git-branch-controls"/);
	assert.match(source, /id="spec-wand"/);
	assert.match(source, /Improve spec with Spec Writer/);
	assert.match(source, /id="improved-spec-container" hidden/);
	assert.match(source, />Improved Spec<\/h3>/);
	assert.match(source, /id="accept-improved-spec"/);
	assert.match(source, /id="reject-improved-spec"/);
	assert.match(source, /id="refine-improved-spec"/);
	assert.match(source, /class="spinner"/);
	assert.match(source, /\/api\/spec\/improve/);
	assert.match(source, /function resetSpecWriterState\(\)/);
	assert.match(source, /function setSpecWriterLoading\(loading\)/);
	assert.match(source, /function renderImprovedSpec\(\)/);
	assert.match(source, /function projectById\(id\)/);
	assert.match(source, /async function refreshSelectedProjectGitState\(projectId = selectedProjectId\)/);
	assert.match(source, /\/api\/projects\/" \+ encodeURIComponent\(id\) \+ "\/refresh/);
	assert.match(source, /function populateLinkedDirectoryOptions\(\)/);
	assert.match(source, /function renderProjectProfileSelect\(selectedId = "", elementId = "projectFormAgentSettingsProfileId"\)/);
	assert.match(source, /function projectConfiguredProfile\(project\)/);
	assert.match(source, /function applyProjectAgentSettingsDefault\(project\)/);
	assert.match(source, /function projectGitStatusMessage\(project\)/);
	assert.match(source, /function newBranchValidationError\(project, branchName, baseBranch\)/);
	assert.match(source, /Selected Project is no longer configured\. Choose another Project before submitting\./);
	assert.match(source, /Refreshing Git branches…/);
	assert.match(source, /Git branch refresh failed:/);
	assert.match(source, /Git branch controls unavailable:/);
	assert.match(source, /Branch already exists: /);
	assert.match(source, /projectSelect"\)\.addEventListener\("change"/);
	assert.match(source, /save-inline-project"\)\.addEventListener\("click"/);
	assert.match(source, /const pickDirectoryButton = document\.getElementById\("pick-directory"\);/);
	assert.match(source, /style\?\.display === "none"/);
	assert.match(source, /\/api\/share/);
	assert.match(source, /\/api\/share\.svg/);
	assert.match(source, /function shareSvgUrl\(cacheKey = Date\.now\(\)\)/);
	assert.match(source, /"&_=" \+ encodeURIComponent\(cacheKey\)/);
	assert.match(source, /qr\.alt = "Loading dashboard QR code…";/);
	assert.match(source, /qr\.onerror = \(\) => \{/);
	assert.match(source, /QR code failed to load\. Use the URL above or refresh the dialog\./);
	assert.match(source, /<div class="brand-mark" aria-label="Pi">π<\/div>/);
	assert.doesNotMatch(source, /<div class="brand-mark">PI<\/div>/);
	assert.match(source, /const feedbackDraftsByIssueId = new Map\(\);/);
	assert.match(source, /function captureFeedbackDraft\(issueId = currentFeedbackDraftKey\(\)\)/);
	assert.match(source, /if \(feedback\) feedback\.value = feedbackDraft\(issue\.id\);/);
	assert.match(source, /feedback\.addEventListener\("input", \(\) => feedbackDraftsByIssueId\.set\(issue\.id, feedback\.value\)\)/);
	assert.match(source, /const minimizedIssueIds = new Set\(\);/);
	assert.match(source, /const pendingResumeIssueIds = new Set\(\);/);
	assert.match(source, /let issueLaneById = new Map\(\);/);
	assert.match(source, /function minimizedTitle\(title\)/);
	assert.match(source, /function syncCompletedTicketMinimization\(nextState\)/);
	assert.match(source, /issue\.lane === LANE\.COMPLETED && previousLane !== LANE\.COMPLETED/);
	assert.match(source, /minimizedIssueIds\.add\(issue\.id\);/);
	assert.match(source, /issueLaneById = nextIssueLaneById;/);
	assert.match(source, /const nextState = await api\("\/api\/state"\);/);
	assert.match(source, /const nextState = await api\("\/api\/state"\);\s*captureFeedbackDraft\(\);\s*syncCompletedTicketMinimization\(nextState\);\s*syncHumanInterventionNotifications\(nextState\);\s*state = nextState;/);
	const cardActionsStart = DASHBOARD_JS_SOURCE.indexOf("\"<div class='card-actions'>\" +");
	const cardHeadBeforeActions = DASHBOARD_JS_SOURCE.lastIndexOf("\"<div class='card-head'>\" +", cardActionsStart);
	const badgeInCardActions = DASHBOARD_JS_SOURCE.indexOf("\"<span class='badge \" + badgeClass(issue) + \"'>\" + escapeHtml(stateLabel(issue)) + \"</span>\" +", cardActionsStart);
	const toggleInCardActions = DASHBOARD_JS_SOURCE.indexOf("toggleButton +", badgeInCardActions);
	const expandedTitleAfterActions = DASHBOARD_JS_SOURCE.indexOf("\"<div class='card-title'>\" + escapeHtml(issue.title) + \"</div>\" +", toggleInCardActions);
	const expandedHeadClose = DASHBOARD_JS_SOURCE.lastIndexOf("\"</div>\" +", expandedTitleAfterActions);
	assert.ok(cardHeadBeforeActions !== -1, "expanded card renders an actions row");
	assert.ok(cardActionsStart !== -1, "expanded card renders a card actions container");
	assert.ok(badgeInCardActions !== -1, "expanded card actions render the state badge");
	assert.ok(toggleInCardActions !== -1, "expanded card actions render the minimize button");
	assert.ok(badgeInCardActions < toggleInCardActions, "expanded card actions render the badge before the minimize button");
	assert.ok(expandedHeadClose > toggleInCardActions, "expanded card closes the actions row before rendering the title");
	assert.ok(expandedTitleAfterActions > expandedHeadClose, "expanded card title renders outside and after the card head");
	const minimizedBranchStart = DASHBOARD_JS_SOURCE.indexOf("if (minimized) {");
	const minimizedHeadStart = DASHBOARD_JS_SOURCE.indexOf("\"<div class='card-head'>\" +", minimizedBranchStart);
	const minimizedToggle = DASHBOARD_JS_SOURCE.indexOf("toggleButton +", minimizedHeadStart);
	const minimizedHeadClose = DASHBOARD_JS_SOURCE.indexOf("\"</div>\" +", minimizedToggle);
	const minimizedTitleAfterHead = DASHBOARD_JS_SOURCE.indexOf("\"<div class='card-title'>\" + escapeHtml(minimizedTitle(issue.title)) + \"</div>\"", minimizedHeadClose);
	assert.ok(minimizedToggle > minimizedHeadStart, "minimized card renders the restore button in the card head");
	assert.ok(minimizedTitleAfterHead > minimizedHeadClose, "minimized card title renders outside and after the card head");
	assert.match(source, /data-minimize-toggle/);
	assert.match(source, /aria-expanded='/);
	assert.match(source, /Resume from last session/);
	assert.match(source, /function resumeEligibility\(issue\)/);
	assert.match(source, /function resumeDisabledReason\(issue\)/);
	assert.match(source, /async function postResumeIssue\(id\)/);
	assert.match(source, /pendingResumeIssueIds\.has\(id\)/);
	assert.match(source, /api\("\/api\/issues\/" \+ encodeURIComponent\(id\) \+ "\/resume"/);
	assert.match(source, /Resume request failed:/);
	assert.match(source, /data-resume-issue=/);
	assert.match(source, /diffs-section/);
	assert.match(source, /function loadDiffsForSelectedIssue\(issue = issueById\(selectedId\), options = \{\}\)/);
	assert.match(source, /data-diff-section-toggle/);
	assert.match(source, /data-diff-file/);
	assert.match(source, /renderUnifiedDiff/);
	assert.match(source, /data-resize-panel="create"/);
	assert.match(source, /data-resize-panel="detail"/);
	assert.match(source, /function applyCreateDrawerWidth\(\)/);
	assert.match(source, /function applyDetailPanelWidth\(\)/);
	assert.match(source, /Agent Output/);
	assert.match(source, /selectedId = issue\.metadata\.id;\n    detailTab = "report";\n    selectedTimelineRunId = null;/);
	assert.match(source, /data-view-run/);
	assert.doesNotMatch(html, /__(TOKEN|LANES|KANBAN_LANES|LANE|ROLE_DEFAULTS|THINKING_LEVELS|DEFAULT_PROFILE_ID)_JSON(?:_ATTR)?__/);
	assert.doesNotMatch(source, /__(TOKEN|LANES|KANBAN_LANES|LANE|ROLE_DEFAULTS|THINKING_LEVELS|DEFAULT_PROFILE_ID)_JSON__/);
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
	assert.match(rendered, /Arguments/);
	assert.match(rendered, /echo hi/);
	assert.doesNotMatch(rendered, /Output/);
	assert.doesNotMatch(rendered, /done/);
	assert.equal("updates" in ui.cachedAgentSession(issue.id, "run-1").session.items.find((item) => item.kind === "tool"), false);

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

test("dashboard opens live agent streams only for the active Agent tab and ignores global run events", async () => {
	const html = await renderDashboardHtml("test-token");
	const opened = [];
	class FakeEventSource {
		constructor(url) {
			this.url = url;
			this.closed = false;
			opened.push(this);
		}
		close() { this.closed = true; }
	}
	const context = { api: async () => ({ issueId: "PI-agent", runId: "run-live", events: [], session: { items: [] } }), EventSource: FakeEventSource, document: { getElementById: () => ({ textContent: "" }) } };
	vm.runInNewContext(dashboardAgentSessionTestSource(html), context);
	const ui = context.__dashboardAgentSession;
	ui.setState({ issues: [
		{ id: "PI-agent", automation: { activeRunId: "run-live" } },
		{ id: "PI-other", automation: { activeRunId: "run-other" } },
	] });

	ui.setSelected("PI-agent", "report");
	ui.updateAgentStreamSubscription();
	assert.equal(opened.length, 0);
	assert.equal(ui.activeAgentStreamTarget, null);

	ui.setSelected("PI-agent", "agent");
	ui.updateAgentStreamSubscription();
	ui.updateAgentStreamSubscription();
	assert.equal(opened.length, 1);
	assert.match(opened[0].url, /\/api\/issues\/PI-agent\/runs\/run-live\/events\?token=test-token/);
	assert.equal(ui.activeAgentStreamTarget.issueId, "PI-agent");
	assert.equal(ui.activeAgentStreamTarget.runId, "run-live");

	opened[0].onmessage({ data: JSON.stringify({ type: "run_event", event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: "Hello" } } }) });
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Hello");
	assert.equal(ui.renderDetailCalls, 1);

	ui.handleEventStreamMessage({ data: JSON.stringify({ type: "store", event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", delta: "ignored" } } }) });
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Hello");
	assert.equal(ui.loadCalls, 0);

	ui.setSelected("PI-agent", "report");
	ui.updateAgentStreamSubscription();
	assert.equal(opened[0].closed, true);
	assert.equal(ui.activeAgentStreamTarget, null);

	ui.setSelected("PI-agent", "agent");
	ui.updateAgentStreamSubscription();
	ui.setSelected("PI-other", "agent");
	ui.updateAgentStreamSubscription();
	assert.equal(opened.length, 3);
	assert.equal(opened[1].closed, true);
	assert.equal(opened[2].closed, false);
	opened[2].onmessage({ data: JSON.stringify({ type: "run_event", event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: " ignored" } } }) });
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Hello");

	ui.handleEventStreamMessage({ data: JSON.stringify({ type: "store", event: { type: "metadata_updated", id: "PI-agent" } }) });
	assert.equal(ui.loadCalls, 1);
	ui.handleEventStreamMessage({ data: "not json" });
	assert.equal(ui.loadCalls, 2);
});

test("dashboard waits for live stream ready before loading Agent tab snapshot", async () => {
	const html = await renderDashboardHtml("test-token");
	const opened = [];
	class FakeEventSource {
		constructor(url) {
			this.url = url;
			this.closed = false;
			this.listeners = new Map();
			opened.push(this);
		}
		addEventListener(type, listener) { this.listeners.set(type, listener); }
		dispatch(type) { this.listeners.get(type)?.({ data: "{}" }); }
		close() { this.closed = true; }
	}
	let apiCalls = 0;
	const context = {
		api: async () => {
			apiCalls += 1;
			return { issueId: "PI-agent", runId: "run-live", events: [{ type: "message_update", messageId: "m-live", delta: "Snapshot" }] };
		},
		EventSource: FakeEventSource,
		document: { getElementById: () => ({ textContent: "" }) },
	};
	vm.runInNewContext(dashboardAgentSessionTestSource(html), context);
	const ui = context.__dashboardAgentSession;
	const issue = { id: "PI-agent", automation: { activeRunId: "run-live" } };
	ui.setState({ issues: [issue] });
	ui.setSelected("PI-agent", "agent");

	ui.updateAgentStreamSubscription();
	const loadBeforeReady = ui.ensureActiveAgentSessionLoaded(issue, "run-live");
	assert.equal(loadBeforeReady, null);
	assert.equal(apiCalls, 0);
	assert.equal(opened.length, 1);
	assert.equal(ui.activeAgentStreamReady, false);

	opened[0].dispatch("ready");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(apiCalls, 1);
	assert.equal(ui.activeAgentStreamReady, true);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Snapshot");
});


test("dashboard refreshes missed agent stream events when re-entering Agent tab", async () => {
	const html = await renderDashboardHtml("test-token");
	const opened = [];
	class FakeEventSource {
		constructor(url) {
			this.url = url;
			this.closed = false;
			opened.push(this);
		}
		close() { this.closed = true; }
	}
	let apiCalls = 0;
	const apiResponses = [
		[{ type: "message_update", messageId: "m-live", delta: "Initial " }],
		[
			{ type: "message_update", messageId: "m-live", delta: "Initial " },
			{ type: "message_update", messageId: "m-live", delta: "Missed" },
		],
	];
	const context = {
		api: async () => ({ issueId: "PI-agent", runId: "run-live", events: apiResponses[Math.min(apiCalls++, apiResponses.length - 1)] }),
		EventSource: FakeEventSource,
		document: { getElementById: () => ({ textContent: "" }) },
	};
	vm.runInNewContext(dashboardAgentSessionTestSource(html), context);
	const ui = context.__dashboardAgentSession;
	const issue = { id: "PI-agent", automation: { activeRunId: "run-live" } };
	ui.setState({ issues: [issue] });

	ui.setSelected("PI-agent", "agent");
	await ui.ensureActiveAgentSessionLoaded(issue, "run-live");
	ui.updateAgentStreamSubscription();
	ui.updateAgentStreamSubscription();
	assert.equal(apiCalls, 1);
	assert.equal(opened.length, 1);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Initial ");

	ui.setSelected("PI-agent", "report");
	ui.updateAgentStreamSubscription();
	assert.equal(opened[0].closed, true);
	assert.equal(ui.activeAgentStreamTarget, null);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").loadedFromApi, false);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").needsRefreshFromApi, true);

	ui.handleEventStreamMessage({ data: JSON.stringify({ type: "store", event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: "Missed" } } }) });
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Initial ");

	ui.setSelected("PI-agent", "agent");
	const refreshPromise = ui.ensureActiveAgentSessionLoaded(issue, "run-live");
	ui.updateAgentStreamSubscription();
	ui.updateAgentStreamSubscription();
	await refreshPromise;
	assert.equal(apiCalls, 2);
	assert.equal(opened.length, 2);
	assert.equal(opened[1].closed, false);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").loadedFromApi, true);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").needsRefreshFromApi, false);
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Initial Missed");

	opened[1].onmessage({ data: JSON.stringify({ type: "run_event", event: { type: "run_event", id: "PI-agent", runId: "run-live", event: { type: "message_update", messageId: "m-live", delta: " Live" } } }) });
	assert.equal(ui.cachedAgentSession("PI-agent", "run-live").session.items[0].content, "Initial Missed Live");
});

test("dashboard clears hidden new-branch validation when Project branch controls disappear", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardProjectVmContext([
		"git-branch-controls",
		"branch-validation-message",
		"existingBaseBranch",
		"newBranchBase",
		"newBranchName",
		"new-branch-panel",
	]);
	const result = await vm.runInNewContext(`${dashboardProjectTestSource(html)}
		(() => {
			const gitProject = { id: "git", name: "Git Project", path: "/tmp/git", isGitRepository: true, git: { branches: ["main"], defaultBranch: "main" } };
			const nonGitProject = { id: "plain", name: "Plain Project", path: "/tmp/plain", isGitRepository: false, git: { branches: [] } };
			__dashboardProject.setProjects([gitProject, nonGitProject]);
			__dashboardProject.selectProject("git");
			__dashboardProject.setBranchMode("new");
			document.getElementById("newBranchName").value = "";
			__dashboardProject.renderGitBranchControls(gitProject);
			const invalidMessage = document.getElementById("newBranchName").validationMessage;
			__dashboardProject.selectProject("plain");
			__dashboardProject.renderGitBranchControls(nonGitProject);
			return {
				invalidMessage,
				clearedMessage: document.getElementById("newBranchName").validationMessage,
				branchMessage: document.getElementById("branch-validation-message").textContent,
				controlsHidden: document.getElementById("git-branch-controls").hidden,
				panelHidden: document.getElementById("new-branch-panel").hidden,
				newBranchDisabled: document.getElementById("newBranchName").disabled,
				baseDisabled: document.getElementById("newBranchBase").disabled,
				existingDisabled: document.getElementById("existingBaseBranch").disabled,
				branchMode: __dashboardProject.branchMode,
			};
		})()
	`, context);

	assert.match(result.invalidMessage, /New branch name is required/);
	assert.equal(result.clearedMessage, "");
	assert.equal(result.branchMessage, "");
	assert.equal(result.controlsHidden, true);
	assert.equal(result.panelHidden, true);
	assert.equal(result.newBranchDisabled, true);
	assert.equal(result.baseDisabled, true);
	assert.equal(result.existingDisabled, true);
	assert.equal(result.branchMode, "existing");
});

test("dashboard refreshes Project branches before showing branch controls", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardProjectVmContext([
		"projectSelect",
		"linkedDirectory",
		"selectedProjectSummary",
		"git-branch-controls",
		"branch-validation-message",
		"existingBaseBranch",
		"newBranchBase",
		"newBranchName",
		"new-branch-panel",
	]);
	const result = await vm.runInNewContext(`${dashboardProjectTestSource(html)}
		(async () => {
			const staleProject = { id: "git", name: "Git Project", path: "/tmp/git", isGitRepository: true, git: { branches: ["main"], defaultBranch: "main" } };
			const refreshedProject = { ...staleProject, git: { branches: ["main", "feature/fresh"], defaultBranch: "main" } };
			let resolveRefresh;
			const urls = [];
			api = async (url, options) => {
				urls.push(url);
				return new Promise((resolve) => { resolveRefresh = resolve; });
			};
			__dashboardProject.setProjects([staleProject]);
			__dashboardProject.selectProject("git");
			__dashboardProject.populateLinkedDirectoryOptions();
			const refreshPromise = __dashboardProject.refreshSelectedProjectGitState("git");
			const during = {
				refreshing: __dashboardProject.isProjectRefreshing("git"),
				summary: document.getElementById("selectedProjectSummary").textContent,
				controlsHidden: document.getElementById("git-branch-controls").hidden,
				existingOptions: document.getElementById("existingBaseBranch").options.map((option) => option.value),
			};
			resolveRefresh({ project: refreshedProject, projects: [refreshedProject] });
			await refreshPromise;
			const after = {
				refreshing: __dashboardProject.isProjectRefreshing("git"),
				summary: document.getElementById("selectedProjectSummary").textContent,
				controlsHidden: document.getElementById("git-branch-controls").hidden,
				existingOptions: document.getElementById("existingBaseBranch").options.map((option) => option.value),
				branches: __dashboardProject.getProject("git").git.branches,
			};
			return { urls, during, after };
		})()
	`, context);

	assert.equal(result.urls.length, 1);
	assert.equal(result.urls[0], "/api/projects/git/refresh");
	assert.equal(result.during.refreshing, true);
	assert.match(result.during.summary, /Refreshing Git branches/);
	assert.equal(result.during.controlsHidden, true);
	assert.equal(result.during.existingOptions.length, 0);
	assert.equal(result.after.refreshing, false);
	assert.equal(result.after.controlsHidden, false);
	assert.equal(result.after.branches.length, 2);
	assert.ok(result.after.branches.includes("main"));
	assert.ok(result.after.branches.includes("feature/fresh"));
	assert.ok(result.after.existingOptions.includes("feature/fresh"));
});

test("dashboard shows Project branch refresh failures and suppresses stale branch options", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardProjectVmContext([
		"projectSelect",
		"linkedDirectory",
		"selectedProjectSummary",
		"git-branch-controls",
		"branch-validation-message",
		"existingBaseBranch",
		"newBranchBase",
		"newBranchName",
		"new-branch-panel",
	]);
	const result = await vm.runInNewContext(`${dashboardProjectTestSource(html)}
		(async () => {
			const staleProject = { id: "git", name: "Git Project", path: "/tmp/git", isGitRepository: true, git: { branches: ["main", "stale/missing"], defaultBranch: "main" } };
			api = async () => { throw new Error("repository access denied"); };
			__dashboardProject.setProjects([staleProject]);
			__dashboardProject.selectProject("git");
			__dashboardProject.populateLinkedDirectoryOptions();
			await __dashboardProject.refreshSelectedProjectGitState("git");
			return {
				error: __dashboardProject.projectRefreshError("git"),
				summary: document.getElementById("selectedProjectSummary").textContent,
				controlsHidden: document.getElementById("git-branch-controls").hidden,
				existingOptions: document.getElementById("existingBaseBranch").options.map((option) => option.value),
			};
		})()
	`, context);

	assert.equal(result.error, "repository access denied");
	assert.match(result.summary, /Git branch refresh failed: repository access denied/);
	assert.equal(result.controlsHidden, true);
	assert.equal(result.existingOptions.length, 0);
});

test("dashboard keeps Project dialog open when duplicate path reuses an existing Project", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardProjectVmContext([
		"projectFormId",
		"projectFormName",
		"projectFormPath",
		"project-form-message",
		"project-dialog",
	]);
	const result = await vm.runInNewContext(`${dashboardProjectTestSource(html)}
		(async () => {
			let loadCalls = 0;
			api = async (url, options) => {
				return { reused: true, project: { id: "project-existing", name: "Existing App", path: "/work/app" } };
			};
			load = async () => { loadCalls += 1; };
			document.getElementById("project-dialog").hidden = false;
			document.getElementById("projectFormName").value = "Duplicate title";
			document.getElementById("projectFormPath").value = "/work/app/";
			await __dashboardProject.saveProjectFromForm();
			return {
				dialogHidden: document.getElementById("project-dialog").hidden,
				message: document.getElementById("project-form-message").textContent,
				idValue: document.getElementById("projectFormId").value,
				nameValue: document.getElementById("projectFormName").value,
				pathValue: document.getElementById("projectFormPath").value,
				loadCalls,
			};
		})()
	`, context);

	assert.equal(result.dialogHidden, false);
	assert.match(result.message, /Existing Project reused for that path: Existing App\./);
	assert.equal(result.idValue, "project-existing");
	assert.equal(result.nameValue, "Existing App");
	assert.equal(result.pathValue, "/work/app");
	assert.equal(result.loadCalls, 1);
});

test("dashboard submits Project Agent Settings profile and defaults issue settings from selected Project", async () => {
	const html = await renderDashboardHtml("test-token");
	const context = dashboardProjectVmContext([
		"projectFormId",
		"projectFormName",
		"projectFormPath",
		"projectFormAgentSettingsProfileId",
		"project-form-message",
		"project-dialog",
		"inlineProjectName",
		"inlineProjectPath",
		"inlineProjectAgentSettingsProfileId",
		"inline-project-message",
		"inline-project-panel",
		"profileSelect",
		"profileActions",
		"modelSuggestions",
		"plannerModel",
		"plannerThinking",
		"workerModel",
		"workerThinking",
		"reviewerModel",
		"reviewerThinking",
	]);
	const result = await vm.runInNewContext(`${dashboardProjectTestSource(html)}
		(async () => {
			const profilesFixture = [
				{ id: DEFAULT_PROFILE_ID, name: "Default", agentSettings: normalizeAgentSettingsClient({}) },
				{ id: "profile-fast", name: "Fast", agentSettings: normalizeAgentSettingsClient({ planner: { model: "fast-plan", thinking: "low" }, worker: { model: "fast-work", thinking: "low" }, reviewer: { model: "fast-review", thinking: "low" } }) },
				{ id: "profile-deep", name: "Deep", agentSettings: normalizeAgentSettingsClient({ planner: { model: "deep-plan", thinking: "high" }, worker: { model: "deep-work", thinking: "xhigh" }, reviewer: { model: "deep-review", thinking: "high" } }) },
			];
			__dashboardProject.setProfiles(profilesFixture);
			__dashboardProject.renderAgentSettingsControls();
			__dashboardProject.renderProfileSelect();
			__dashboardProject.renderProjectProfileSelect("profile-fast", "projectFormAgentSettingsProfileId");
			document.getElementById("projectFormName").value = "Configured";
			document.getElementById("projectFormPath").value = "/work/configured";
			let postedPayload = null;
			api = async (url, options) => {
				postedPayload = JSON.parse(options.body);
				return { reused: false, project: { id: "configured", name: "Configured", path: "/work/configured", agentSettingsProfileId: postedPayload.agentSettingsProfileId } };
			};
			load = async () => {};
			await __dashboardProject.saveProjectFromForm();

			document.getElementById("inlineProjectName").value = "Inline";
			document.getElementById("inlineProjectPath").value = "/work/inline";
			document.getElementById("inlineProjectAgentSettingsProfileId").value = "profile-deep";
			let inlinePayload = null;
			api = async (url, options) => {
				inlinePayload = JSON.parse(options.body);
				return { reused: false, project: { id: "inline", name: "Inline", path: "/work/inline", agentSettingsProfileId: inlinePayload.agentSettingsProfileId } };
			};
			load = async () => { __dashboardProject.setProjects([{ id: "inline", name: "Inline", path: "/work/inline", agentSettingsProfileId: inlinePayload.agentSettingsProfileId }]); };
			__dashboardProject.setIssueFormMode("create");
			agentSettingsDirtyByUser = false;
			await __dashboardProject.saveInlineProject();
			const inlineDefaultProfileId = __dashboardProject.selectedProfileId;

			const projectWithProfile = { id: "configured", name: "Configured", path: "/work/configured", agentSettingsProfileId: "profile-fast" };
			const projectWithoutProfile = { id: "plain", name: "Plain", path: "/work/plain", agentSettingsProfileId: null };
			const projectWithStaleProfile = { id: "stale", name: "Stale", path: "/work/stale", agentSettingsProfileId: "missing-profile" };
			__dashboardProject.setIssueFormMode("create");
			agentSettingsDirtyByUser = false;
			__dashboardProject.applyProjectAgentSettingsDefault(projectWithProfile);
			const configuredDefault = { selectedProfileId: __dashboardProject.selectedProfileId, settings: __dashboardProject.currentAgentSettingsFromDom() };

			__dashboardProject.selectAgentSettingsProfile("profile-deep");
			__dashboardProject.applyProjectAgentSettingsDefault(projectWithoutProfile);
			const afterUserOverrideProjectChange = { selectedProfileId: __dashboardProject.selectedProfileId, settings: __dashboardProject.currentAgentSettingsFromDom(), dirty: __dashboardProject.agentSettingsDirtyByUser };

			agentSettingsDirtyByUser = false;
			__dashboardProject.applyProjectAgentSettingsDefault(projectWithoutProfile);
			const noProfileDefault = { selectedProfileId: __dashboardProject.selectedProfileId, settings: __dashboardProject.currentAgentSettingsFromDom() };

			selectedProfileId = "profile-fast";
			__dashboardProject.applyAgentSettings(profileById(selectedProfileId).agentSettings);
			agentSettingsDirtyByUser = false;
			__dashboardProject.applyProjectAgentSettingsDefault(projectWithStaleProfile);
			const staleProfileDefault = { selectedProfileId: __dashboardProject.selectedProfileId, settings: __dashboardProject.currentAgentSettingsFromDom(), configuredProfile: __dashboardProject.projectConfiguredProfile(projectWithStaleProfile) };

			return {
				postedPayload,
				inlinePayload,
				inlineDefaultProfileId,
				projectOptions: document.getElementById("projectFormAgentSettingsProfileId").options.map((option) => option.value),
				configuredDefault,
				afterUserOverrideProjectChange,
				noProfileDefault,
				staleProfileDefault,
			};
		})()
	`, context);

	assert.equal(result.postedPayload.agentSettingsProfileId, "profile-fast");
	assert.equal(result.inlinePayload.agentSettingsProfileId, "profile-deep");
	assert.equal(result.inlineDefaultProfileId, "profile-deep");
	assert.deepEqual(result.projectOptions, ["", DEFAULT_PROFILE_ID, "profile-fast", "profile-deep"]);
	assert.equal(result.configuredDefault.selectedProfileId, "profile-fast");
	assert.equal(result.configuredDefault.settings.worker.model, "fast-work");
	assert.equal(result.afterUserOverrideProjectChange.selectedProfileId, "profile-deep");
	assert.equal(result.afterUserOverrideProjectChange.settings.worker.model, "deep-work");
	assert.equal(result.afterUserOverrideProjectChange.dirty, true);
	assert.equal(result.noProfileDefault.selectedProfileId, DEFAULT_PROFILE_ID);
	assert.equal(result.noProfileDefault.settings.worker.model, ROLE_DEFAULTS.worker.model);
	assert.equal(result.staleProfileDefault.selectedProfileId, DEFAULT_PROFILE_ID);
	assert.equal(result.staleProfileDefault.settings.worker.model, ROLE_DEFAULTS.worker.model);
	assert.equal(result.staleProfileDefault.configuredProfile, null);
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

test("dashboard backlog suggestion controls reflect no-project and active-run states", async () => {
	const html = await renderDashboardHtml("test-token");
	const elements = new Map();
	class FakeElement {
		constructor(id) {
			this.id = id;
			this.disabled = false;
			this.textContent = "";
			this.title = "";
		}
	}
	for (const id of ["suggest-backlog", "backlog-suggestion-status", "status"]) elements.set(id, new FakeElement(id));
	const context = {
		DEFAULT_PROFILE_ID,
		LANE,
		ROLE_DEFAULTS,
		THINKING_LEVELS: ["low", "medium", "high", "xhigh"],
		document: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [], querySelector: () => null, body: { classList: { add() {}, remove() {} } }, documentElement: { clientWidth: 1200 } },
		window: { innerWidth: 1200, matchMedia: () => ({ matches: false }) },
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		alert(message) { throw new Error(message); },
	};
	const result = await vm.runInNewContext(`${dashboardBacklogSuggestionTestSource(html)}
		(() => {
			__dashboardBacklogSuggestions.setState({ issues: [], lanes: {}, projects: [], backlogSuggestions: { active: false, status: "idle", projects: [] } });
			__dashboardBacklogSuggestions.updateBacklogSuggestionControls();
			const noProject = {
				disabled: document.getElementById("suggest-backlog").disabled,
				buttonText: document.getElementById("suggest-backlog").textContent,
				statusText: document.getElementById("backlog-suggestion-status").textContent,
			};
			__dashboardBacklogSuggestions.setState({ issues: [], lanes: {}, projects: [{ id: "p1", name: "App", path: "/app" }], backlogSuggestions: { active: true, status: "running", totalProjects: 1, projects: [{ status: "running" }] } });
			__dashboardBacklogSuggestions.updateBacklogSuggestionControls();
			return {
				noProject,
				activeDisabled: document.getElementById("suggest-backlog").disabled,
				activeButtonText: document.getElementById("suggest-backlog").textContent,
				activeStatusText: document.getElementById("backlog-suggestion-status").textContent,
			};
		})()
	`, context);

	assert.equal(result.noProject.disabled, true);
	assert.equal(result.noProject.buttonText, "Suggest Backlog Items");
	assert.match(result.noProject.statusText, /Add at least one Project/);
	assert.equal(result.activeDisabled, true);
	assert.equal(result.activeButtonText, "Suggesting…");
	assert.match(result.activeStatusText, /Generating suggestions/);
});

test("dashboard backlog suggestion action calls endpoint and reloads", async () => {
	const html = await renderDashboardHtml("test-token");
	const elements = new Map();
	class FakeElement {
		constructor(id) {
			this.id = id;
			this.disabled = false;
			this.textContent = "";
			this.title = "";
		}
	}
	for (const id of ["suggest-backlog", "backlog-suggestion-status", "status"]) elements.set(id, new FakeElement(id));
	const context = {
		DEFAULT_PROFILE_ID,
		LANE,
		ROLE_DEFAULTS,
		THINKING_LEVELS: ["low", "medium", "high", "xhigh"],
		document: { getElementById: (id) => elements.get(id) || null, querySelectorAll: () => [], querySelector: () => null, body: { classList: { add() {}, remove() {} } }, documentElement: { clientWidth: 1200 } },
		window: { innerWidth: 1200, matchMedia: () => ({ matches: false }) },
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		alert(message) { throw new Error(message); },
	};
	const result = await vm.runInNewContext(`${dashboardBacklogSuggestionTestSource(html)}
		(async () => {
			const calls = [];
			let loadCalls = 0;
			api = async (apiPath, options = {}) => {
				calls.push({ apiPath, options });
				return { active: true, status: "running", totalProjects: 1, projects: [] };
			};
			load = async () => { loadCalls += 1; };
			__dashboardBacklogSuggestions.setState({ issues: [], lanes: {}, projects: [{ id: "p1", name: "App", path: "/app" }], backlogSuggestions: { active: false, status: "idle", projects: [] } });
			await __dashboardBacklogSuggestions.startBacklogSuggestions();
			return {
				calls,
				loadCalls,
				status: document.getElementById("status").textContent,
				buttonDisabled: document.getElementById("suggest-backlog").disabled,
			};
		})()
	`, context);

	assert.equal(result.calls.length, 1);
	assert.equal(result.calls[0].apiPath, "/api/backlog/suggestions");
	assert.equal(result.calls[0].options.method, "POST");
	assert.equal(result.loadCalls, 1);
	assert.equal(result.status, "Backlog suggestion generation started.");
	assert.equal(result.buttonDisabled, true);
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
		LANE,
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
		LANE,
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
		LANE,
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
	const css = DASHBOARD_CSS_SOURCE;

	assert.match(html, /<link rel="stylesheet" href="\/ui\/dashboard\.css">/);
	assert.match(css, /body \{[^}]*min-width: 0;[^}]*overflow-x: hidden;/);
	assert.match(css, /\[hidden\] \{ display: none !important; \}/);
	assert.doesNotMatch(css, /body \{[^}]*width: 100vw;/);
	assert.match(css, /\.topbar \{[^}]*width: 100%;[^}]*min-width: 0;/);
	assert.match(css, /\.top-actions \{[^}]*justify-content: flex-end;[^}]*min-width: 0;/);
	assert.doesNotMatch(css, /\.top-actions \{[^}]*position: fixed;/);
	assert.match(css, /\.app-shell \{[\s\S]*grid-template-rows: auto auto;[\s\S]*align-content: start;[\s\S]*min-height: calc\(100vh - 64px\);[\s\S]*width: 100%;/);
	assert.doesNotMatch(css, /grid-template-rows: auto minmax\(0, auto\);/);
	assert.match(css, /\.board \{[\s\S]*overflow-x: auto;[\s\S]*padding: 10px 18px 18px;/);
	assert.match(css, /\.card-head \{[^}]*justify-content: flex-end;[^}]*margin-bottom: 6px;[^}]*min-width: 0;/);
	assert.match(css, /\.card-title \{[^}]*display: block;[^}]*width: 100%;[^}]*overflow-wrap: anywhere;/);
	const cardActionCss = css.match(/\.card-action \{([^}]*)\}/)?.[1] || "";
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
	assert.match(css, /\.minimized \.card-title \{ margin-bottom: 0; \}/);
	assert.doesNotMatch(css, /\.card-head \{[^}]*justify-content: space-between;/);
	assert.match(css, /@media \(max-width: 640px\) \{[\s\S]*\.desktop-directory-picker \{ display: none; \}[\s\S]*\.board \{[\s\S]*grid-template-columns: 1fr;[\s\S]*overflow-x: visible;[\s\S]*\}[\s\S]*\.lane \{ min-height: 180px; \}/);
	assert.match(css, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.desktop-directory-picker \{ display: none; \}\s*\}/);
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
		assert.match(html, /<link rel="stylesheet" href="\/ui\/dashboard\.css">/);
		assert.match(html, /<script src="\/ui\/dashboard\.js"[\s\S]*data-token="&quot;test-token&quot;"[\s\S]*><\/script>/);
		assert.doesNotMatch(html, /<style>[\s\S]*<\/style>/);
		assert.doesNotMatch(html, /<script>\s*[\s\S]*?<\/script>/);

		const base = url.split("?")[0].replace(/\/$/, "");
		const cssResponse = await fetch(`${base}/ui/dashboard.css`);
		assert.equal(cssResponse.status, 200);
		assert.match(cssResponse.headers.get("content-type") || "", /text\/css/);
		const css = await cssResponse.text();
		const jsResponse = await fetch(`${base}/ui/dashboard.js`);
		assert.equal(jsResponse.status, 200);
		assert.match(jsResponse.headers.get("content-type") || "", /text\/javascript/);
		const js = await jsResponse.text();
		const source = `${html}\n${css}\n${js}`;
		assert.match(html, /data-token="&quot;test-token&quot;"/);
		assert.match(source, /create-drawer/);
		assert.match(source, /renderMarkdown/);
		assert.match(source, /Plan Review Report/);
		assert.match(source, /\.markdown :not\(pre\) > code \{[\s\S]*overflow-wrap: anywhere;[\s\S]*word-break: break-word;/);
		assert.match(source, /\.app-shell \{[\s\S]*min-height: calc\(100vh - 64px\);[\s\S]*width: 100%;/);
		assert.match(source, /\.board \{[\s\S]*align-items: start;[\s\S]*overflow-x: auto;/);
		assert.match(source, /@media \(max-width: 640px\) \{[\s\S]*\.desktop-directory-picker \{ display: none; \}[\s\S]*\.board \{[\s\S]*grid-template-columns: 1fr;[\s\S]*overflow-x: visible;/);
		assert.match(source, /@media \(hover: none\) and \(pointer: coarse\) \{\s*\.desktop-directory-picker \{ display: none; \}\s*\}/);
		assert.match(source, /\.lane \{[\s\S]*min-height: 430px;[\s\S]*height: fit-content;/);
		assert.match(source, /\.panel-resize-handle/);
		assert.match(source, /--create-drawer-default-width: 460px;/);
		assert.match(source, /--detail-panel-default-width: 520px;/);
		assert.equal(source.includes("body { overflow: hidden; }"), false);
		assert.match(source, /Approve and merge/);
		assert.match(source, /function mergeTargetKey\(issue\)/);
		assert.match(source, /function activeMergeForIssue\(issue\)/);
		assert.match(source, /Merge blocked by/);
		assert.match(source, /until its active merge is done/);
		assert.match(source, /Approve and leave in worktree/);
		assert.match(source, /Request Changes/);
		assert.match(source, /Depends on issue/);
		assert.match(source, /dependencyIssueId/);
		assert.match(source, /projects-tab/);
		assert.match(source, /projectSelect/);
		assert.match(source, /class="secondary desktop-directory-picker" id="pick-directory"/);
		assert.match(source, /inlineProjectPath/);
		assert.match(source, /inlineProjectAgentSettingsProfileId/);
		assert.match(source, /projectFormAgentSettingsProfileId/);
		assert.match(source, /No project default/);
		assert.match(source, /function projectById\(id\)/);
		assert.match(source, /populateLinkedDirectoryOptions\(\);/);
		assert.match(source, /applyProjectAgentSettingsDefault\(projectById\(selectedProjectId\)\);/);
		assert.match(source, /let agentSettingsDirtyByUser = false;/);
		assert.match(source, /minimizedIssueIds\.has\(id\)/);
		assert.match(source, /let issueLaneById = new Map\(\);/);
		assert.match(source, /function syncCompletedTicketMinimization\(nextState\)/);
		assert.match(source, /syncCompletedTicketMinimization\(nextState\);/);
		assert.match(source, /escapeHtml\(minimizedTitle\(issue\.title\)\)/);
		assert.match(source, /event\.target\.closest\("\[data-minimize-toggle\]"\)/);
		assert.match(source, /Minimize ticket/);
		assert.match(source, /Restore ticket/);
		const formElCapture = source.indexOf("const formEl = event.currentTarget;");
		const createApiCall = source.indexOf('await api("/api/issues"');
		assert.ok(formElCapture !== -1, "issue form submit handler captures currentTarget before async work");
		assert.ok(createApiCall !== -1, "issue form submit handler creates issues through the API");
		assert.ok(formElCapture < createApiCall, "issue form stores currentTarget before awaiting issue creation");
		assert.match(source, /const form = new FormData\(formEl\);/);
		assert.match(source, /formEl\.reset\(\);/);
		assert.doesNotMatch(source, /event\.currentTarget\.reset\(\);/);
		assert.match(source, /profileSelect/);
		assert.match(source, /Settings differ from selected profile/);
		assert.match(source, /Save to selected profile/);
		assert.match(source, /Save as new profile/);
		assert.match(source, /Diffs appear once work reaches In Progress/);
		assert.match(source, /\/api\/issues\/" \+ encodeURIComponent\(issue\.id\) \+ "\/diffs/);
		assert.match(source, /diff-file-toggle/);
		assert.match(source, /Agent Output/);
		assert.match(source, /function renderAgentSession\(issue, runId/);
		assert.match(source, /data-view-run/);
		assert.match(source, /\/api\/issues\/" \+ encodeURIComponent\(issueId\) \+ "\/runs\//);
		assert.match(source, /partialResult/);
		assert.match(source, /toolEventIsError/);
		assert.match(source, /isError/);
		assert.match(source, /handleEventStreamMessage/);
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

test("server routes run events only to matching per-run streams", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({ title: "SSE session", spec: "Stream run output.", linkedDirectory: linked });
	const reject = async () => { throw new Error("not used"); };
	const server = new OrchestratorServer({
		store,
		token: "stream-token",
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
	const decoder = new TextDecoder();
	async function readUntil(reader, pattern) {
		let text = "";
		const timeout = new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error(`Timed out waiting for ${pattern}`)), 1500));
		const read = (async () => {
			while (!pattern.test(text)) {
				const { value, done } = await reader.read();
				if (done) break;
				text += decoder.decode(value, { stream: true });
			}
			return text;
		})();
		return Promise.race([read, timeout]);
	}
	const globalResponse = await fetch(`${base}/api/events?token=stream-token`);
	const streamResponse = await fetch(`${base}/api/issues/${encodeURIComponent(issue.metadata.id)}/runs/run-sse/events?token=stream-token`);
	assert.equal(globalResponse.status, 200);
	assert.equal(streamResponse.status, 200);
	const globalReader = globalResponse.body.getReader();
	const streamReader = streamResponse.body.getReader();
	try {
		await readUntil(globalReader, /event: ready/);
		await readUntil(streamReader, /event: ready/);
		await store.appendRunEvent(issue.metadata.id, "run-sse", { type: "message_update", messageId: "m1", delta: "streamed" });
		const runChunk = await readUntil(streamReader, /streamed/);
		assert.match(runChunk, /"type":"run_event"/);
		store.emitChange({ type: "metadata_updated", id: issue.metadata.id });
		const globalChunk = await readUntil(globalReader, /metadata_updated|run_event/);
		assert.match(globalChunk, /metadata_updated/);
		assert.doesNotMatch(globalChunk, /run_event/);
	} finally {
		await globalReader.cancel().catch(() => {});
		await streamReader.cancel().catch(() => {});
		await server.stop();
	}
});

test("server exposes authenticated project API", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	await initGitRepoWithMain(linked);
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "project-token",
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
		const denied = await fetch(`${base}/api/projects`);
		assert.equal(denied.status, 401);

		const created = await fetch(`${base}/api/projects?token=project-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: linked }),
		});
		assert.equal(created.status, 200);
		const createdBody = await created.json();
		assert.equal(createdBody.project.name, path.basename(linked));

		const resolved = await fetch(`${base}/api/projects/resolve-path?token=project-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ path: `${linked}/` }),
		});
		assert.equal(resolved.status, 200);
		const resolvedBody = await resolved.json();
		assert.equal(resolvedBody.reused, true);
		assert.equal(resolvedBody.project.id, createdBody.project.id);

		await git(["branch", "server-fresh"], linked);
		const refreshed = await fetch(`${base}/api/projects/${encodeURIComponent(createdBody.project.id)}/refresh?token=project-token`, { method: "POST", body: "{}" });
		assert.equal(refreshed.status, 200);
		const refreshedBody = await refreshed.json();
		assert.ok(refreshedBody.project.git.branches.includes("server-fresh"));

		const list = await fetch(`${base}/api/projects?token=project-token`);
		assert.equal(list.status, 200);
		const listBody = await list.json();
		assert.equal(listBody.projects.length, 1);
		assert.deepEqual(listBody.counts[createdBody.project.id], { active: 0, completed: 0 });

		await fsp.rm(linked, { recursive: true, force: true });
		const failedRefresh = await fetch(`${base}/api/projects/${encodeURIComponent(createdBody.project.id)}/refresh?token=project-token`, { method: "POST", body: "{}" });
		assert.equal(failedRefresh.status, 400);
		const failedRefreshBody = await failedRefresh.json();
		assert.match(failedRefreshBody.error, /Project path is not accessible/);
	} finally {
		await server.stop();
	}
});

test("server routes backlog create, update, delete, and send actions", async () => {
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
			deleteBacklogIssue: async (id) => {
				calls.push(["delete", id]);
				return { id, removed: true };
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

		const deleted = await fetch(`${base}/api/issues/PI-backlog/delete-backlog?token=backlog-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(deleted.status, 200);
		assert.deepEqual(calls[3], ["delete", "PI-backlog"]);
	} finally {
		await server.stop();
	}
});

test("server exposes authenticated backlog suggestion API and state", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const calls = [];
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "suggest-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			startBacklogSuggestions: async () => {
				calls.push("start");
				return { active: true, status: "running", totalProjects: 1, projects: [] };
			},
			getBacklogSuggestionState: async () => ({ active: true, status: "running", totalProjects: 1, projects: [] }),
			createIssue: reject,
			comment: reject,
			updateBacklogIssue: reject,
			sendBacklogIssueToAgent: reject,
			deleteBacklogIssue: reject,
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
		const denied = await fetch(`${base}/api/backlog/suggestions`, { method: "POST", body: "{}" });
		assert.equal(denied.status, 401);

		const response = await fetch(`${base}/api/backlog/suggestions?token=suggest-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 202);
		assert.deepEqual(await response.json(), { active: true, status: "running", totalProjects: 1, projects: [] });
		assert.deepEqual(calls, ["start"]);

		const stateResponse = await fetch(`${base}/api/state?token=suggest-token`);
		assert.equal(stateResponse.status, 200);
		const stateBody = await stateResponse.json();
		assert.deepEqual(stateBody.backlogSuggestions, { active: true, status: "running", totalProjects: 1, projects: [] });
	} finally {
		await server.stop();
	}
});

test("server returns backlog suggestion action errors with existing error shape", async () => {
	const root = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const reject = async () => {
		throw new Error("not used");
	};
	const server = new OrchestratorServer({
		store,
		token: "suggest-error-token",
		config: { host: "127.0.0.1", port: 0 },
		actions: {
			startBacklogSuggestions: async () => {
				throw new Error("No projects configured.");
			},
			getBacklogSuggestionState: async () => ({ active: false, status: "idle", projects: [] }),
			createIssue: reject,
			comment: reject,
			updateBacklogIssue: reject,
			sendBacklogIssueToAgent: reject,
			deleteBacklogIssue: reject,
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
		const response = await fetch(`${base}/api/backlog/suggestions?token=suggest-error-token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		assert.equal(response.status, 400);
		assert.deepEqual(await response.json(), { error: "No projects configured." });
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

	const removable = await actions.createIssue({ title: "Runtime removable backlog", spec: "Delete later.", linkedDirectory: linked, backlog: true });
	assert.deepEqual(await actions.deleteBacklogIssue(removable.metadata.id), { id: removable.metadata.id, removed: true });
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

test("runtime rejects backlog suggestion runs when no Projects are configured", async () => {
	const root = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();

	await assert.rejects(() => runtime.createActions().startBacklogSuggestions(), /No projects configured/);
	assert.deepEqual(runtime.getBacklogSuggestionState(), { active: false, status: "idle", projects: [] });
});

test("runtime spawns one feature suggestor per Project and stores suggestions in the correct backlog", async () => {
	const root = await tempDir();
	const firstDir = await tempDir();
	const secondDir = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const firstProject = (await runtime.store.saveProject({ name: "First", path: firstDir })).project;
	const secondProject = (await runtime.store.saveProject({ name: "Second", path: secondDir })).project;
	const calls = [];
	runtime.runner = {
		run: async (request) => {
			calls.push(request);
			await request.onRunStarted?.(`run-${calls.length}`);
			return {
				runId: `run-${calls.length}`,
				text: [
					FEATURE_SUGGESTIONS_START,
					JSON.stringify([{ title: `Improve ${path.basename(request.cwd)}`, spec: `Do useful work in ${request.cwd}.` }]),
					FEATURE_SUGGESTIONS_END,
				].join("\n"),
			};
		},
	};

	const started = await runtime.createActions().startBacklogSuggestions();
	assert.equal(started.active, true);
	assert.equal(started.totalProjects, 2);
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls.map((call) => call.role), ["feature-suggestor", "feature-suggestor"]);
	assert.deepEqual(new Set(calls.map((call) => call.cwd)), new Set([firstDir, secondDir]));
	assert.deepEqual(new Set(calls.map((call) => call.issueId)), new Set([`feature-suggestor-${firstProject.id}`, `feature-suggestor-${secondProject.id}`]));
	assert.equal(calls.every((call) => call.internal === true), true);
	assert.match(calls[0].prompt, /Existing backlog items for this project/);

	const state = runtime.getBacklogSuggestionState();
	assert.equal(state.status, "completed");
	assert.equal(state.createdCount, 2);
	assert.equal(state.projects.every((project) => project.status === "completed"), true);

	const board = await runtime.store.getBoardState();
	const created = board.issues.filter((issue) => issue.lane === LANE.BACKLOG);
	assert.equal(created.length, 2);
	assert.deepEqual(new Set(created.map((issue) => issue.projectId)), new Set([firstProject.id, secondProject.id]));
});

test("runtime backlog suggestion run records partial failure and continues other Projects", async () => {
	const root = await tempDir();
	const goodDir = await tempDir();
	const badDir = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const goodProject = (await runtime.store.saveProject({ name: "Good", path: goodDir })).project;
	const badProject = (await runtime.store.saveProject({ name: "Bad", path: badDir })).project;
	runtime.runner = {
		run: async (request) => {
			if (request.cwd === badDir) throw new Error("scan failed");
			return {
				runId: "good-run",
				text: `${FEATURE_SUGGESTIONS_START}\n${JSON.stringify([{ title: "Good idea", spec: "Create the good improvement." }])}\n${FEATURE_SUGGESTIONS_END}`,
			};
		},
	};

	await runtime.createActions().startBacklogSuggestions();
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);

	const state = runtime.getBacklogSuggestionState();
	assert.equal(state.status, "partial-failed");
	assert.equal(state.failedCount, 1);
	assert.equal(state.projects.find((project) => project.projectId === badProject.id).error, "scan failed");
	assert.equal(state.projects.find((project) => project.projectId === goodProject.id).createdCount, 1);
	const issues = (await runtime.store.getBoardState()).issues.filter((issue) => issue.lane === LANE.BACKLOG);
	assert.equal(issues.length, 1);
	assert.equal(issues[0].projectId, goodProject.id);
});

test("runtime prevents duplicate concurrent backlog suggestion runs", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	await runtime.store.saveProject({ name: "App", path: linked });
	const originalListProjects = runtime.store.listProjects.bind(runtime.store);
	let releaseList;
	let listCalls = 0;
	const listGate = new Promise((resolve) => {
		releaseList = resolve;
	});
	runtime.store.listProjects = async (...args) => {
		listCalls += 1;
		await listGate;
		return originalListProjects(...args);
	};
	runtime.runner = {
		run: async () => ({ text: `${FEATURE_SUGGESTIONS_START}\n[]\n${FEATURE_SUGGESTIONS_END}` }),
	};

	const firstStart = runtime.createActions().startBacklogSuggestions();
	const secondStart = runtime.createActions().startBacklogSuggestions();
	await assert.rejects(() => secondStart, /already running/);
	assert.equal(listCalls, 1);
	releaseList();
	const started = await firstStart;
	assert.equal(started.active, true);
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);
});

test("runtime sanitizes unsafe Project ids before starting internal feature suggestor runs", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	await runtime.store.saveProject({ id: "team/../app", name: "Unsafe", path: linked });
	const calls = [];
	runtime.runner = {
		run: async (request) => {
			calls.push(request);
			return { text: `${FEATURE_SUGGESTIONS_START}\n[]\n${FEATURE_SUGGESTIONS_END}` };
		},
	};

	await runtime.createActions().startBacklogSuggestions();
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);

	assert.equal(calls.length, 1);
	assert.match(calls[0].issueId, /^feature-suggestor-team-app-[a-f0-9]{12}$/);
	assert.equal(calls[0].issueId.includes("/"), false);
	assert.equal(calls[0].issueId.includes("\\"), false);
});

test("runtime creates no backlog tickets for empty feature suggestion arrays", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	await runtime.store.saveProject({ name: "App", path: linked });
	runtime.runner = {
		run: async () => ({ text: `${FEATURE_SUGGESTIONS_START}\n[]\n${FEATURE_SUGGESTIONS_END}` }),
	};

	await runtime.createActions().startBacklogSuggestions();
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);

	const suggestionState = runtime.getBacklogSuggestionState();
	assert.equal(suggestionState.status, "completed");
	assert.equal(suggestionState.createdCount, 0);
	assert.equal(suggestionState.skippedCount, 0);
	const issues = (await runtime.store.getBoardState()).issues.filter((issue) => issue.lane === LANE.BACKLOG);
	assert.equal(issues.length, 0);
});

test("runtime skips exact existing backlog title duplicates for feature suggestions", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const project = (await runtime.store.saveProject({ name: "App", path: linked })).project;
	await runtime.store.createIssue({ title: "Existing idea", spec: "Already present.", projectId: project.id, backlog: true });
	runtime.runner = {
		run: async (request) => {
			assert.match(request.prompt, /Existing idea/);
			return {
				text: `${FEATURE_SUGGESTIONS_START}\n${JSON.stringify([
					{ title: "Existing idea", spec: "Duplicate should be skipped." },
					{ title: "New idea", spec: "Create new backlog work." },
				])}\n${FEATURE_SUGGESTIONS_END}`,
			};
		},
	};

	await runtime.createActions().startBacklogSuggestions();
	await waitFor(() => runtime.getBacklogSuggestionState().active === false);

	const suggestionState = runtime.getBacklogSuggestionState();
	assert.equal(suggestionState.createdCount, 1);
	assert.equal(suggestionState.skippedCount, 1);
	const titles = (await runtime.store.getBoardState()).issues.filter((issue) => issue.projectId === project.id && issue.lane === LANE.BACKLOG).map((issue) => issue.title).sort();
	assert.deepEqual(titles, ["Existing idea", "New idea"]);
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

test("issue store sanitizes persisted dashboard run events", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({ title: "Sanitize session", spec: "Persist less output.", linkedDirectory: linked });
	const ignored = await store.appendRunEvent(issue.metadata.id, "run-sanitize", { type: "tool_execution_update", output: "x".repeat(10000) });
	assert.equal(ignored, null);
	await store.appendRunEvent(issue.metadata.id, "run-sanitize", { type: "tool_execution_start", toolExecutionId: "t1", toolName: "bash", input: { command: "echo hi" }, stdout: "x".repeat(10000) });
	await store.appendRunEvent(issue.metadata.id, "run-sanitize", { type: "tool_execution_end", toolExecutionId: "t1", result: { content: [{ type: "text", text: "x".repeat(10000) }], isError: false } });
	const persisted = await fsp.readFile(store.runPath(issue.metadata.id, "run-sanitize"), "utf-8");
	assert.doesNotMatch(persisted, /xxxxx/);
	assert.doesNotMatch(persisted, /stdout/);
	assert.doesNotMatch(persisted, /result/);
	assert.match(persisted, /echo hi/);

	await fsp.appendFile(store.runPath(issue.metadata.id, "run-sanitize"), `${JSON.stringify({ type: "tool_execution_update", toolExecutionId: "t1", partialResult: { content: [{ type: "text", text: "legacy large output" }] } })}\n`, "utf-8");
	const session = await store.getAgentSession(issue.metadata.id, "run-sanitize");
	assert.equal(session.events.some((event) => JSON.stringify(event).includes("legacy large output")), false);
	const tool = session.session.tools[0];
	assert.equal(tool.name, "bash");
	assert.match(tool.input, /echo hi/);
	assert.equal("updates" in tool, false);
	assert.equal("output" in tool, false);
});

test("issue store creates and reuses Projects with default names", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const saved = await store.saveProject({ path: `${linked}/` });
	assert.equal(saved.reused, false);
	assert.equal(saved.project.name, path.basename(linked));
	assert.equal(saved.project.path, linked);
	assert.equal(saved.project.agentSettingsProfileId, null);

	const duplicate = await store.saveProject({ name: "Duplicate", path: linked });
	assert.equal(duplicate.reused, true);
	assert.equal(duplicate.project.id, saved.project.id);
	assert.equal(duplicate.project.agentSettingsProfileId, null);

	const issue = await store.createIssue({ title: "Use project", spec: "Work.", projectId: saved.project.id });
	assert.equal(issue.metadata.projectId, saved.project.id);
	assert.equal(issue.metadata.linkedDirectory, linked);
	assert.deepEqual(issue.metadata.project, { id: saved.project.id, name: saved.project.name, path: linked, isGitRepository: false });
});

test("issue store persists optional Project Agent Settings profiles and rejects missing profiles", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const duplicateDir = await tempDir();
	const missingProfileDir = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const profileResult = await store.saveProfile({
		name: "Project default",
		agentSettings: { worker: { model: "project-worker", thinking: "high" } },
	});
	const profileId = profileResult.profile.id;

	const withoutProfile = await store.saveProject({ name: "No preset", path: linked, agentSettingsProfileId: "  " });
	assert.equal(withoutProfile.project.agentSettingsProfileId, null);

	const withProfile = await store.saveProject({ name: "With preset", path: duplicateDir, agentSettingsProfileId: ` ${profileId} ` });
	assert.equal(withProfile.project.agentSettingsProfileId, profileId);
	assert.equal((await store.listProjects()).find((project) => project.id === withProfile.project.id).agentSettingsProfileId, profileId);

	await assert.rejects(
		() => store.saveProject({ name: "Missing preset", path: missingProfileDir, agentSettingsProfileId: "does-not-exist" }),
		/Agent settings profile does not exist\./,
	);

	const duplicate = await store.saveProject({ name: "Duplicate no overwrite", path: duplicateDir, agentSettingsProfileId: DEFAULT_PROFILE_ID });
	assert.equal(duplicate.reused, true);
	assert.equal(duplicate.project.id, withProfile.project.id);
	assert.equal(duplicate.project.agentSettingsProfileId, profileId);
});

test("issue store refreshes stale Project git branches when relinking", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await initGitRepoWithMain(repo);
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const saved = await store.saveProject({ path: repo });
	assert.deepEqual(saved.project.git.branches, ["main"]);

	await git(["branch", "feature/linked-after-save"], repo);
	const ensured = await store.ensureProjectForPath(`${repo}/`);
	assert.equal(ensured.reused, true);
	assert.equal(ensured.project.id, saved.project.id);
	assert.ok(ensured.project.git.branches.includes("feature/linked-after-save"));

	const duplicate = await store.saveProject({ name: "Duplicate", path: repo });
	assert.equal(duplicate.reused, true);
	assert.ok(duplicate.project.git.branches.includes("feature/linked-after-save"));
});

test("issue creation refreshes selected Project git metadata before storing git requests", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await initGitRepoWithMain(repo);
	const store = new IssueStore({ dataRoot: root });
	await store.init();

	const saved = await store.saveProject({ path: repo });
	assert.deepEqual(saved.project.git.branches, ["main"]);
	await git(["branch", "feature/new-base"], repo);

	const issue = await store.createIssue({
		title: "Use freshly linked base",
		spec: "Use the branch that was added after Project save.",
		projectId: saved.project.id,
		gitRequest: { mode: "existing", baseBranch: "feature/new-base" },
	});
	assert.equal(issue.metadata.gitRequest.baseBranch, "feature/new-base");
	const [refreshedProject] = await store.listProjects();
	assert.ok(refreshedProject.git.branches.includes("feature/new-base"));
});

test("issue store backfills Projects from legacy linked-directory tickets", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const first = await store.createIssue({ title: "Legacy one", spec: "One.", linkedDirectory: linked });
	const second = await store.createIssue({ title: "Legacy two", spec: "Two.", linkedDirectory: `${linked}/` });
	await fsp.rm(store.projectsPath, { force: true });
	await patchIssueMetadata(store, first.metadata.id, { projectId: undefined, project: undefined, linkedDirectory: linked });
	await patchIssueMetadata(store, second.metadata.id, { projectId: undefined, project: undefined, linkedDirectory: `${linked}/` });

	const state = await store.getBoardState();
	assert.equal(state.projects.length, 1);
	assert.equal(state.projects[0].name, path.basename(linked));
	const reloadedFirst = await store.loadIssue(first.metadata.id);
	const reloadedSecond = await store.loadIssue(second.metadata.id);
	assert.equal(reloadedFirst.metadata.projectId, state.projects[0].id);
	assert.equal(reloadedSecond.metadata.projectId, state.projects[0].id);
});

test("issue store blocks Project deletion with active tickets and cleans completed history", async () => {
	const root = await tempDir();
	const activeDir = await tempDir();
	const completedDir = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const activeProject = (await store.saveProject({ name: "Active", path: activeDir })).project;
	await store.createIssue({ title: "Active project ticket", spec: "Keep.", projectId: activeProject.id, backlog: true });
	await assert.rejects(() => store.deleteProject(activeProject.id), /active tickets/);

	const completedProject = (await store.saveProject({ name: "Done", path: completedDir })).project;
	const completed = await store.createIssue({ title: "Completed project ticket", spec: "Remove.", projectId: completedProject.id });
	await store.setLane(completed.metadata.id, LANE.COMPLETED, "test");
	await store.appendRunEvent(completed.metadata.id, "run-delete", { type: "message_update", delta: "delete me" });
	await fsp.mkdir(path.join(root, "sessions", completed.metadata.id), { recursive: true });
	await fsp.writeFile(path.join(root, "sessions", completed.metadata.id, "run.jsonl"), "{}\n", "utf-8");
	const result = await store.deleteProject(completedProject.id);
	assert.deepEqual(result.removedIssueIds, [completed.metadata.id]);
	assert.equal(await exists(store.issueDir(completed.metadata.id)), false);
	assert.equal(await exists(path.join(root, "sessions", completed.metadata.id)), false);
	assert.equal((await store.listProjects()).some((project) => project.id === completedProject.id), false);
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
	await store.appendRunEvent(oldCompleted.metadata.id, "run-clean", { type: "message_update", delta: "archived output" });
	await store.appendRunEvent(oldInProgress.metadata.id, "run-keep", { type: "message_update", delta: "active output" });
	await fsp.mkdir(path.join(root, "sessions", oldCompleted.metadata.id), { recursive: true });
	await fsp.writeFile(path.join(root, "sessions", oldCompleted.metadata.id, "run.jsonl"), "{}\n", "utf-8");
	await fsp.mkdir(path.join(root, "sessions", oldInProgress.metadata.id), { recursive: true });

	const result = await store.cleanCompletedTickets({ now: cleanupNow });
	assert.equal(result.cleanedCount, 1);
	assert.deepEqual(result.cleanedIds, [oldCompleted.metadata.id]);
	assert.equal(result.retentionDays, COMPLETED_TICKET_CLEANUP_RETENTION_DAYS);
	assert.equal(await exists(path.join(root, "issues", oldCompleted.metadata.id)), false);
	assert.equal(await exists(path.join(root, "issues", "__archived_completed__", oldCompleted.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", "__archived_completed__", oldCompleted.metadata.id, "runs")), false);
	assert.equal(await exists(path.join(root, "issues", oldInProgress.metadata.id, "metadata.json")), true);
	assert.equal(await exists(path.join(root, "issues", oldInProgress.metadata.id, "runs", "run-keep.jsonl")), true);
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

	assert.match(prompt, /git merge --squash <issue-worktree-branch>/);
	assert.match(prompt, /Conventional Commit/);
	assert.match(prompt, /final merge-target-branch commit must be a Conventional Commit/);
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

test("issue store deletes only backlog issues", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const events = [];
	store.onChange((event) => events.push(event));
	const backlog = await store.createIssue({ title: "Delete backlog idea", spec: "Remove later.", linkedDirectory: linked, backlog: true });
	await store.appendRunEvent(backlog.metadata.id, "run-delete-backlog", { type: "message_update", delta: "transient" });
	await fsp.mkdir(path.join(root, "sessions", backlog.metadata.id), { recursive: true });
	await fsp.writeFile(path.join(root, "sessions", backlog.metadata.id, "run.jsonl"), "{}\n", "utf-8");

	await assert.rejects(() => store.deleteBacklogIssue(`../issues/${backlog.metadata.id}`), /Invalid issue id/);
	assert.equal(await exists(store.issueDir(backlog.metadata.id)), true);
	assert.equal(await exists(path.join(root, "sessions", backlog.metadata.id)), true);
	assert.equal(events.some((event) => event.type === "backlog_issue_deleted"), false);

	const result = await store.deleteBacklogIssue(backlog.metadata.id);
	assert.deepEqual(result, { id: backlog.metadata.id, removed: true });
	assert.equal(await exists(store.issueDir(backlog.metadata.id)), false);
	assert.equal(await exists(path.join(root, "sessions", backlog.metadata.id)), false);
	const state = await store.getBoardState();
	assert.equal(state.issues.some((issue) => issue.id === backlog.metadata.id), false);
	assert.equal(state.lanes[LANE.BACKLOG].includes(backlog.metadata.id), false);
	assert.deepEqual(events.at(-1), { type: "backlog_issue_deleted", id: backlog.metadata.id });

	const active = await store.createIssue({ title: "Keep active issue", spec: "Do not delete.", linkedDirectory: linked });
	await assert.rejects(() => store.deleteBacklogIssue(active.metadata.id), /Only Backlog issues can be deleted this way/);
	assert.equal(await exists(store.issueDir(active.metadata.id)), true);
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

test("workspace manager bases generated worktree branches on selected existing branch without switching checkout", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "main\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const originalBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();
	await git(["branch", "base-for-ticket"], repo);

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Existing base branch",
		spec: "Use base branch.",
		linkedDirectory: repo,
		gitRequest: { mode: "existing", baseBranch: "base-for-ticket" },
	});
	const workspace = await ensureIssueWorkspace(store, issue);
	const prepared = await store.loadIssue(issue.metadata.id);

	assert.equal(workspace.kind, "git-worktree");
	assert.equal(prepared.metadata.git.baseBranch, "base-for-ticket");
	assert.equal((await git(["branch", "--show-current"], repo)).stdout.trim(), originalBranch);
	assert.equal((await git(["branch", "--show-current"], workspace.path)).stdout.trim(), prepared.metadata.git.branchName);
});

test("workspace manager fails invalid selected base branch without falling back to directory workspace", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "main\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const originalBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Missing base branch",
		spec: "Do not edit in place.",
		linkedDirectory: repo,
		gitRequest: { mode: "existing", baseBranch: "not-a-real-base" },
	});

	await assert.rejects(() => ensureIssueWorkspace(store, issue), /not-a-real-base\^\{commit\}|ambiguous argument|unknown revision/);
	const reloaded = await store.loadIssue(issue.metadata.id);
	assert.notEqual(reloaded.metadata.workspace?.kind, "directory");
	await assert.rejects(() => fsp.access(path.join(root, "worktrees", issue.metadata.id)), /ENOENT/);
	assert.equal((await git(["branch", "--show-current"], repo)).stdout.trim(), originalBranch);
});

test("workspace manager creates requested new branch without switching checkout", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "main\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const originalBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();

	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "New branch request",
		spec: "Create a named branch.",
		linkedDirectory: repo,
		gitRequest: { mode: "new", baseBranch: originalBranch, newBranchName: "feature/pi-requested" },
	});
	const workspace = await ensureIssueWorkspace(store, issue);
	const prepared = await store.loadIssue(issue.metadata.id);

	assert.equal(prepared.metadata.git.baseBranch, "feature/pi-requested");
	assert.equal(prepared.metadata.git.request.baseBranch, originalBranch);
	assert.equal(prepared.metadata.git.request.newBranchName, "feature/pi-requested");
	assert.match(prepared.metadata.git.branchName, /^pi-orchestrator\/pi-/);
	assert.notEqual(prepared.metadata.git.branchName, "feature/pi-requested");
	assert.equal((await git(["branch", "--show-current"], repo)).stdout.trim(), originalBranch);
	assert.equal((await git(["branch", "--show-current"], workspace.path)).stdout.trim(), prepared.metadata.git.branchName);
	assert.equal((await git(["rev-parse", "feature/pi-requested"], repo)).stdout.trim(), (await git(["rev-parse", originalBranch], repo)).stdout.trim());
	assert.equal((await git(["rev-parse", prepared.metadata.git.branchName], repo)).stdout.trim(), (await git(["rev-parse", "feature/pi-requested"], repo)).stdout.trim());

	const duplicate = await store.createIssue({
		title: "Duplicate branch request",
		spec: "Fail duplicate.",
		linkedDirectory: repo,
		gitRequest: { mode: "new", baseBranch: originalBranch, newBranchName: "feature/pi-requested" },
	});
	await assert.rejects(() => ensureIssueWorkspace(store, duplicate), /Branch already exists/);
	const invalid = await store.createIssue({
		title: "Invalid branch request",
		spec: "Fail invalid.",
		linkedDirectory: repo,
		gitRequest: { mode: "new", baseBranch: originalBranch, newBranchName: "bad branch name" },
	});
	await assert.rejects(() => ensureIssueWorkspace(store, invalid), /Invalid branch name/);
	assert.equal((await git(["branch", "--show-current"], repo)).stdout.trim(), originalBranch);
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

test("approve and merge targets requested new branch and leaves selected base unchanged", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();
	const baseSha = (await git(["rev-parse", baseBranch], repo)).stdout.trim();
	const requestedBranch = "feature/pi-requested-merge";

	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const issue = await runtime.store.createIssue({
		title: "Merge into requested branch",
		spec: "Update the readme and merge it into the requested feature branch.",
		linkedDirectory: repo,
		gitRequest: { mode: "new", baseBranch, newBranchName: requestedBranch },
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
			assert.match(prompt, new RegExp(`Merge target branch: ${escapeRegExp(requestedBranch)}`));
			assert.match(prompt, new RegExp(`Issue worktree branch: ${escapeRegExp(prepared.metadata.git.branchName)}`));
			assert.doesNotMatch(prompt, /Base branch:/);
			if (onRunStarted) await onRunStarted("new-branch-merge-run");
			await git(["add", "-A"], workspace.path);
			await git(["commit", "-m", "chore(orchestrator): complete requested branch merge"], workspace.path);
			await git(["checkout", requestedBranch], repo);
			await git(["merge", "--squash", prepared.metadata.git.branchName], repo);
			await git(["commit", "-m", "feat: update requested branch readme"], repo);
			return { runId: "new-branch-merge-run", text: "MERGE_RESULT: MERGED\nSquash commit created on the requested branch." };
		},
		stopAll: async () => {},
	};

	await runtime.createActions().approveReviewAndMerge(issue.metadata.id);
	await waitFor(async () => (await runtime.store.loadIssue(issue.metadata.id)).metadata.lane === LANE.COMPLETED);

	const completed = await runtime.store.loadIssue(issue.metadata.id);
	assert.equal(calls.length, 1);
	assert.equal(prepared.metadata.git.baseBranch, requestedBranch);
	assert.equal(completed.metadata.git.mergedToBranch, requestedBranch);
	assert.equal(completed.metadata.git.mergeCommitSha, (await git(["rev-parse", requestedBranch], repo)).stdout.trim());
	assert.equal((await git(["rev-parse", baseBranch], repo)).stdout.trim(), baseSha);
	assert.equal((await git(["show", `${requestedBranch}:README.md`], repo)).stdout, "after\n");
});

test("approve and merge rejects unsafe legacy new-branch metadata before starting merger", async () => {
	const root = await tempDir();
	const repo = await tempDir();
	await git(["init"], repo);
	await git(["config", "user.email", "test@example.local"], repo);
	await git(["config", "user.name", "Test User"], repo);
	await fsp.writeFile(path.join(repo, "README.md"), "before\n", "utf-8");
	await git(["add", "README.md"], repo);
	await git(["commit", "-m", "initial"], repo);
	const baseBranch = (await git(["branch", "--show-current"], repo)).stdout.trim();
	const baseSha = (await git(["rev-parse", baseBranch], repo)).stdout.trim();
	const requestedBranch = "feature/legacy-new-branch";

	const runtime = createOrchestratorRuntime({ dataRoot: root });
	await runtime.store.init();
	const issue = await runtime.store.createIssue({
		title: "Legacy unsafe branch",
		spec: "Reject unsafe legacy metadata.",
		linkedDirectory: repo,
	});
	await runtime.store.writeMetadata(issue.metadata.id, {
		...issue.metadata,
		lane: LANE.IN_REVIEW,
		workspace: { kind: "git-worktree", path: repo, editInPlace: false },
		git: {
			repoRoot: repo,
			baseBranch,
			baseSha,
			branchName: requestedBranch,
			worktreePath: repo,
			finalCommitSha: null,
			request: { mode: "new", baseBranch, newBranchName: requestedBranch },
		},
	});
	let calls = 0;
	runtime.runner = {
		run: async () => {
			calls += 1;
			return { runId: "should-not-run", text: "MERGE_RESULT: MERGED" };
		},
		stopAll: async () => {},
	};

	await assert.rejects(
		() => runtime.createActions().approveReviewAndMerge(issue.metadata.id),
		/matches the issue worktree branch/,
	);
	const unchanged = await runtime.store.loadIssue(issue.metadata.id);
	assert.equal(calls, 0);
	assert.equal(unchanged.metadata.lane, LANE.IN_REVIEW);
	assert.equal(unchanged.metadata.automation.activeRunId, null);
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
	for (const run of runs) {
		const log = await fsp.readFile(path.join(root, "issues", issue.metadata.id, "runs", run), "utf-8");
		assert.doesNotMatch(log, /"type":"process_exit"/);
	}
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

test("rpc runner sanitizes oversized tool events before dashboard compaction", async () => {
	const root = await tempDir();
	const linked = await tempDir();
	const store = new IssueStore({ dataRoot: root });
	await store.init();
	const issue = await store.createIssue({
		title: "Oversized tool event",
		spec: "Keep concise tool metadata.",
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
			"  await emit({ type: 'tool_execution_start', toolExecutionId: 'tool-big', toolName: 'bash', input: { command: 'echo start' } });",
			"  await emit({ type: 'tool_execution_end', toolExecutionId: 'tool-big', toolName: 'bash', input: { command: 'echo ' + 'a'.repeat(70 * 1024) }, status: 'complete', stdout: 'z'.repeat(70 * 1024), result: { content: [{ type: 'text', text: 'z'.repeat(70 * 1024) }], isError: false } });",
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
	await runner.run({
		issueId: issue.metadata.id,
		role: "worker",
		cwd: linked,
		prompt: "hello",
	});

	const runs = await fsp.readdir(path.join(root, "issues", issue.metadata.id, "runs"));
	const logPath = path.join(root, "issues", issue.metadata.id, "runs", runs[0]);
	const log = await fsp.readFile(logPath, "utf-8");
	const stats = await fsp.stat(logPath);
	const events = log.trim().split("\n").map((line) => JSON.parse(line));
	const endEvent = events.find((event) => event.type === "tool_execution_end");
	assert.ok(endEvent, "oversized tool end event should survive sanitization");
	assert.equal(endEvent.toolCallId, "tool-big");
	assert.equal(endEvent.toolName, "bash");
	assert.equal(endEvent.status, "complete");
	assert.match(endEvent.input, /echo aaa/);
	assert.equal(endEvent.input.length <= 4001, true);
	assert.equal("stdout" in endEvent, false);
	assert.equal("result" in endEvent, false);
	assert.doesNotMatch(log, /zzzzz/);
	assert.ok(stats.size < 16 * 1024, `dashboard run log should stay compact, got ${stats.size} bytes`);
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
