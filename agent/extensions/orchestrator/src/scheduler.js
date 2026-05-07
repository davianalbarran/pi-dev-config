import { DEFAULT_CONFIG, LANE, MAX_IMPLEMENTATION_ATTEMPTS, MAX_PLANNING_ATTEMPTS } from "./constants.js";
import {
	buildFinalReviewerPrompt,
	buildPlannerPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
	parseFinalReviewerOutput,
	parsePlannerOutput,
} from "./prompts.js";
import { ensureIssueWorkspace } from "./workspace.js";
import { parseDecision } from "./workflow.js";

function buildPlanningExhaustedReport(issue, message) {
	return [
		"# Plan Review Requires Human Attention",
		"",
		`**Issue:** ${issue.metadata.title}`,
		`**Status:** ${message}`,
		`**Planning attempts:** ${issue.metadata.automation?.planningAttempts || 0}`,
		"",
		"## What Happened",
		"The planning loop reached its configured limit before producing a new approved plan.",
		"",
		"## Review Focus",
		"- Read the current plan and comments before deciding whether to approve or request changes.",
		"- If the plan is incomplete, add specific feedback and request plan changes.",
		"- If the plan is usable despite the automation limit, approve it to continue implementation.",
	].join("\n");
}

function buildImplementationExhaustedReport(issue, message, feedback) {
	return [
		"# Implementation Review Requires Human Attention",
		"",
		`**Issue:** ${issue.metadata.title}`,
		`**Status:** ${message}`,
		`**Implementation attempts:** ${issue.metadata.automation?.implementationAttempts || MAX_IMPLEMENTATION_ATTEMPTS}`,
		"",
		"## What Happened",
		"The worker/reviewer loop reached its configured limit and moved the issue to human review.",
		"",
		"## Latest Automated Feedback",
		feedback && String(feedback).trim() ? String(feedback).trim() : "No reviewer feedback was captured for the final attempt.",
		"",
		"## Review Focus",
		"- Inspect the workspace changes and recent events before approval.",
		"- Approve and merge only if the work is ready to integrate into its base branch.",
		"- Approve and leave in worktree if the work is acceptable but should remain isolated.",
		"- Request changes with concrete feedback if another implementation pass is needed.",
	].join("\n");
}

export class OrchestratorScheduler {
	constructor({ store, runner, config = {}, onEvent = () => {} }) {
		this.store = store;
		this.runner = runner;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.onEvent = onEvent;
		this.running = new Map();
		this.timer = null;
		this.unsubscribe = null;
		this.tickQueued = false;
		this.ticking = false;
		this.stopping = false;
	}

	start() {
		if (this.timer) return;
		this.stopping = false;
		this.unsubscribe = this.store.onChange(() => this.queueTick());
		this.timer = setInterval(() => this.queueTick(), this.config.tickMs);
		void this.recoverInterruptedRuns().finally(() => this.queueTick());
	}

	async stop() {
		this.stopping = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		if (this.unsubscribe) this.unsubscribe();
		this.unsubscribe = null;
		for (const run of this.running.values()) run.controller.abort();
		this.running.clear();
		await this.runner.stopAll();
	}

	queueTick() {
		if (this.tickQueued) return;
		this.tickQueued = true;
		setTimeout(() => {
			this.tickQueued = false;
			void this.tick();
		}, 50).unref?.();
	}

	countRunning(group) {
		let count = 0;
		for (const run of this.running.values()) {
			if (run.group === group) count++;
		}
		return count;
	}

	async tick() {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const issues = await this.store.listIssues();
			for (const issue of issues) {
				const metadata = issue.metadata;
				if (this.running.has(metadata.id)) continue;
				if (metadata.automation?.paused || metadata.automation?.activeRunId) continue;

				if (
					(metadata.lane === LANE.CREATED || metadata.lane === LANE.PLANNING) &&
					this.countRunning("planning") < this.config.planningConcurrency
				) {
					this.startIssueRun(metadata.id, "planning", (signal) => this.runPlanning(metadata.id, signal));
				}

				if (
					metadata.lane === LANE.IN_PROGRESS &&
					this.countRunning("implementation") < this.config.implementationConcurrency
				) {
					this.startIssueRun(metadata.id, "implementation", (signal) => this.runImplementation(metadata.id, signal));
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	startIssueRun(issueId, group, fn) {
		const controller = new AbortController();
		this.running.set(issueId, { group, controller });
		void fn(controller.signal)
			.catch((error) => {
				if (!this.stopping) return this.failIssue(issueId, error);
				return this.store.appendEvent(issueId, {
					type: "automation_interrupted",
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				this.running.delete(issueId);
				if (!this.stopping) this.queueTick();
			});
	}

	agentSettingsFor(issue, role) {
		const key = role === "final-reviewer" ? "reviewer" : role;
		return issue.metadata.agentSettings?.[key] || null;
	}

	async markActive(issueId, role, runId) {
		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			automation: {
				...metadata.automation,
				activeRunId: runId,
				activeRole: role,
				paused: false,
				error: null,
			},
		}));
	}

	async markRunStarted(issueId, role, runId) {
		await this.markActive(issueId, role, runId);
		await this.store.appendEvent(issueId, { type: "agent_run_started", role, runId });
	}

	async recoverInterruptedRuns() {
		const issues = await this.store.listIssues();
		for (const issue of issues) {
			const { metadata } = issue;
			if (metadata.lane === LANE.COMPLETED) continue;
			const activeRunId = metadata.automation?.activeRunId;
			const activeRole = metadata.automation?.activeRole;
			const pausedError = metadata.automation?.error || "";
			const recoverableAbort =
				metadata.automation?.paused &&
				(metadata.lane === LANE.PLANNING || metadata.lane === LANE.IN_PROGRESS) &&
				/Agent run aborted|automation_interrupted/i.test(pausedError);
			if (!activeRunId && !recoverableAbort) continue;

			await this.store.updateMetadata(metadata.id, (current) => ({
				...current,
				automation: {
					...current.automation,
					activeRunId: null,
					activeRole: null,
					paused: false,
					error: null,
				},
			}));
			await this.store.appendEvent(metadata.id, {
				type: "interrupted_run_recovered",
				role: activeRole,
				runId: activeRunId,
			});
		}
	}

	async clearActive(issueId, patch = {}) {
		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			...patch,
			automation: {
				...metadata.automation,
				...(patch.automation || {}),
				activeRunId: null,
				activeRole: null,
			},
		}));
	}

	async failIssue(issueId, error) {
		const message = error instanceof Error ? error.message : String(error);
		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			automation: {
				...metadata.automation,
				activeRunId: null,
				activeRole: null,
				paused: true,
				error: message,
			},
		}));
		await this.store.appendEvent(issueId, { type: "automation_failed", error: message });
		this.onEvent({ type: "automation_failed", issueId, error: message });
	}

	async runPlanning(issueId, signal) {
		let issue = await this.store.loadIssue(issueId);
		if ((issue.metadata.automation?.planningAttempts || 0) >= MAX_PLANNING_ATTEMPTS && issue.metadata.lane !== LANE.CREATED) {
			const message = `Planning loop limit reached after ${MAX_PLANNING_ATTEMPTS} attempts.`;
			await this.store.writePlanReport(issueId, buildPlanningExhaustedReport(issue, message));
			await this.clearActive(issueId, {
				lane: LANE.PLAN_REVIEW,
				automation: {
					...issue.metadata.automation,
					paused: true,
					error: message,
				},
			});
			return;
		}

		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			lane: LANE.PLANNING,
			automation: {
				...metadata.automation,
				planningAttempts: (metadata.automation?.planningAttempts || 0) + 1,
				paused: false,
				error: null,
			},
		}));
		await this.store.appendEvent(issueId, { type: "planning_started" });

		issue = await this.store.loadIssue(issueId);
		await ensureIssueWorkspace(this.store, issue);
		issue = await this.store.loadIssue(issueId);

		await this.markActive(issueId, "planner", "starting");
		const result = await this.runner.run({
			issueId,
			role: "planner",
			cwd: issue.metadata.workspace.path,
			prompt: buildPlannerPrompt(issue),
			signal,
			agentSettings: this.agentSettingsFor(issue, "planner"),
			onRunStarted: (runId) => this.markRunStarted(issueId, "planner", runId),
		});
		const parsed = parsePlannerOutput(result.text);
		await this.store.writePlan(issueId, parsed.plan);
		await this.store.writePlanReport(issueId, parsed.report);
		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			lane: LANE.PLAN_REVIEW,
			automation: {
				...metadata.automation,
				activeRunId: null,
				activeRole: null,
				paused: false,
				error: null,
			},
		}));
		await this.store.appendEvent(issueId, { type: "planning_finished", runId: result.runId });
		this.onEvent({ type: "planning_finished", issueId });
	}

	async runImplementation(issueId, signal) {
		let feedback = "";
		while (true) {
			let issue = await this.store.loadIssue(issueId);
			const nextAttempt = (issue.metadata.automation?.implementationAttempts || 0) + 1;
			if (nextAttempt > MAX_IMPLEMENTATION_ATTEMPTS) {
				await this.pauseImplementationExhausted(issueId, feedback);
				return;
			}

			await this.store.updateMetadata(issueId, (metadata) => ({
				...metadata,
				lane: LANE.IN_PROGRESS,
				automation: {
					...metadata.automation,
					implementationAttempts: nextAttempt,
					paused: false,
					error: null,
				},
			}));
			await this.store.appendEvent(issueId, { type: "implementation_attempt_started", attempt: nextAttempt });

			issue = await this.store.loadIssue(issueId);
			await ensureIssueWorkspace(this.store, issue);
			issue = await this.store.loadIssue(issueId);

			await this.markActive(issueId, "worker", "starting");
			const worker = await this.runner.run({
				issueId,
				role: "worker",
				cwd: issue.metadata.workspace.path,
				prompt: buildWorkerPrompt(issue, feedback),
				signal,
				agentSettings: this.agentSettingsFor(issue, "worker"),
				onRunStarted: (runId) => this.markRunStarted(issueId, "worker", runId),
			});
			await this.store.appendEvent(issueId, { type: "worker_finished", runId: worker.runId });

			issue = await this.store.loadIssue(issueId);
			await this.markActive(issueId, "reviewer", "starting");
			const review = await this.runner.run({
				issueId,
				role: "reviewer",
				cwd: issue.metadata.workspace.path,
				prompt: buildReviewerPrompt(issue, worker.text),
				signal,
				agentSettings: this.agentSettingsFor(issue, "reviewer"),
				onRunStarted: (runId) => this.markRunStarted(issueId, "reviewer", runId),
			});
			await this.store.appendEvent(issueId, {
				type: "reviewer_finished",
				runId: review.runId,
				decision: parseDecision(review.text),
			});

			if (parseDecision(review.text) !== "PASS") {
				feedback = review.text;
				continue;
			}

			issue = await this.store.loadIssue(issueId);
			await this.markActive(issueId, "final-reviewer", "starting");
			const finalReview = await this.runner.run({
				issueId,
				role: "final-reviewer",
				cwd: issue.metadata.workspace.path,
				prompt: buildFinalReviewerPrompt(issue, `${worker.text}\n\n${review.text}`),
				signal,
				agentSettings: this.agentSettingsFor(issue, "final-reviewer"),
				onRunStarted: (runId) => this.markRunStarted(issueId, "final-reviewer", runId),
			});
			const finalDecision = parseDecision(finalReview.text);
			await this.store.appendEvent(issueId, {
				type: "final_reviewer_finished",
				runId: finalReview.runId,
				decision: finalDecision,
			});

			if (finalDecision === "PASS") {
				const parsed = parseFinalReviewerOutput(finalReview.text);
				await this.store.writeReviewReport(issueId, parsed.report);
				await this.store.updateMetadata(issueId, (metadata) => ({
					...metadata,
					lane: LANE.IN_REVIEW,
					automation: {
						...metadata.automation,
						activeRunId: null,
						activeRole: null,
						paused: false,
						error: null,
					},
				}));
				await this.store.appendEvent(issueId, { type: "ready_for_human_review" });
				this.onEvent({ type: "ready_for_human_review", issueId });
				return;
			}

			feedback = finalReview.text;
		}
	}

	async pauseImplementationExhausted(issueId, feedback) {
		const message = `Implementation loop limit reached after ${MAX_IMPLEMENTATION_ATTEMPTS} attempts.`;
		const issue = await this.store.loadIssue(issueId);
		await this.store.writeReviewReport(issueId, buildImplementationExhaustedReport(issue, message, feedback));
		await this.store.updateMetadata(issueId, (metadata) => ({
			...metadata,
			lane: LANE.IN_REVIEW,
			automation: {
				...metadata.automation,
				activeRunId: null,
				activeRole: null,
				paused: true,
				error: message,
			},
		}));
		await this.store.appendEvent(issueId, { type: "implementation_exhausted", error: message, feedback });
		this.onEvent({ type: "implementation_exhausted", issueId, error: message });
	}
}
