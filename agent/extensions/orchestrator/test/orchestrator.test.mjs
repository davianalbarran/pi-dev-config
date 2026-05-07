import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LANE, ROLE_DEFAULTS } from "../src/constants.js";
import {
	PLAN_END,
	PLAN_REPORT_END,
	PLAN_REPORT_START,
	PLAN_START,
	REVIEW_REPORT_END,
	REVIEW_REPORT_START,
	parseFinalReviewerOutput,
	parseMergerOutput,
	parsePlannerOutput,
} from "../src/prompts.js";
import { RpcAgentRunner } from "../src/rpc-runner.js";
import { createOrchestratorRuntime } from "../src/runtime.js";
import { OrchestratorScheduler } from "../src/scheduler.js";
import { OrchestratorServer, isAuthorized } from "../src/server.js";
import { IssueStore } from "../src/store.js";
import { renderDashboardHtml } from "../src/ui.js";
import { branchNameForIssue, commitIssueWorktree, ensureIssueWorkspace } from "../src/workspace.js";
import {
	approvePlan,
	approveReview,
	isDependencyResolved,
	normalizeMetadata,
	requestPlanChanges,
	requestReviewChanges,
} from "../src/workflow.js";

const execFileAsync = promisify(execFile);

async function tempDir() {
	return fsp.mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-test-"));
}

async function git(args, cwd) {
	return execFileAsync("git", args, { cwd, maxBuffer: 1024 * 1024 });
}

test("token authorization accepts query, header, and bearer token", () => {
	assert.equal(isAuthorized("/?token=abc", {}, "abc"), true);
	assert.equal(isAuthorized("/", { "x-orchestrator-token": "abc" }, "abc"), true);
	assert.equal(isAuthorized("/", { authorization: "Bearer abc" }, "abc"), true);
	assert.equal(isAuthorized("/?token=wrong", {}, "abc"), false);
});

test("dashboard renderer injects runtime data", async () => {
	const html = await renderDashboardHtml("test-token");

	assert.match(html, /const TOKEN = "test-token";/);
	assert.match(html, /const LANES = \["Created","Planning"/);
	assert.match(html, /const LANE = \{"CREATED":"Created"/);
	assert.match(html, /const ROLE_DEFAULTS = \{"planner":/);
	assert.match(html, /const THINKING_LEVELS = \["low","medium","high","xhigh"\];/);
	assert.match(html, /id="create-drawer"/);
	assert.match(html, /const minimizedIssueIds = new Set\(\);/);
	assert.match(html, /function minimizedTitle\(title\)/);
	assert.match(html, /data-minimize-toggle/);
	assert.match(html, /aria-expanded='/);
	assert.doesNotMatch(html, /__(TOKEN|LANES|LANE|ROLE_DEFAULTS|THINKING_LEVELS)_JSON__/);
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
		assert.match(html, /\.app-shell \{[\s\S]*min-height: calc\(100vh - 64px\);/);
		assert.match(html, /\.board \{[\s\S]*align-items: start;[\s\S]*overflow-x: auto;/);
		assert.match(html, /\.lane \{[\s\S]*min-height: 430px;[\s\S]*height: fit-content;/);
		assert.equal(html.includes("body { overflow: hidden; }"), false);
		assert.match(html, /Approve and merge/);
		assert.match(html, /Approve and leave in worktree/);
		assert.match(html, /Request Changes/);
		assert.match(html, /Depends on issue/);
		assert.match(html, /dependencyIssueId/);
		assert.match(html, /minimizedIssueIds\.has\(id\)/);
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

	const reloaded = await store.loadIssue(issue.metadata.id);
	const completed = approveReview(reloaded.metadata);
	assert.equal(completed.lane, LANE.COMPLETED);
});

test("approve and merge starts merger rpc role and completes after branch is merged", async () => {
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
			if (onRunStarted) await onRunStarted("merge-run");
			await git(["add", "-A"], workspace.path);
			await git(["commit", "-m", "test completion"], workspace.path);
			await git(["merge", prepared.metadata.git.branchName], repo);
			return { runId: "merge-run", text: "MERGE_RESULT: MERGED\nMerged into the base branch." };
		},
		stopAll: async () => {},
	};

	await runtime.createActions().approveReviewAndMerge(issue.metadata.id);
	await waitFor(async () => (await runtime.store.loadIssue(issue.metadata.id)).metadata.lane === LANE.COMPLETED);

	const completed = await runtime.store.loadIssue(issue.metadata.id);
	assert.equal(calls.length, 1);
	assert.equal(completed.metadata.git.mergedToBranch, baseBranch);
	assert.match(completed.metadata.git.mergeCommitSha, /^[a-f0-9]{40}$/);
	assert.equal(await fsp.readFile(path.join(repo, "README.md"), "utf-8"), "after\n");
	assert.equal(completed.events.some((event) => event.type === "review_approved_and_merged"), true);
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
