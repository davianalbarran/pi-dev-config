import { DEFAULT_CONFIG, LANE, MAX_IMPLEMENTATION_ATTEMPTS, MAX_PLANNING_ATTEMPTS } from "./constants.js";
import {
	buildFinalReviewerPrompt,
	buildPlannerPrompt,
	buildReviewerPrompt,
	buildWorkerPrompt,
	parseFinalReviewerOutput,
	parsePlannerOutput,
} from "./prompts.js";
import { nowIso } from "./utils.js";
import { recoverIssueWorkspace } from "./workspace.js";
import { dependencyLabel, getDependencyIssueId, isDependencyResolved, parseDecision } from "./workflow.js";

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
		this.kicking = new Set();
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
		this.kicking.clear();
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
				if (this.kicking.has(metadata.id)) continue;
				if (this.running.has(metadata.id)) continue;
				if (metadata.automation?.paused || metadata.automation?.activeRunId) continue;

				if (
					(metadata.lane === LANE.CREATED || metadata.lane === LANE.PLANNING) &&
					this.countRunning("planning") < this.config.planningConcurrency &&
					(await this.ensureDependenciesResolved(issue))
				) {
					this.startIssueRun(metadata.id, "planning", (signal) => this.runPlanning(metadata.id, signal));
				}

				if (
					metadata.lane === LANE.IN_PROGRESS &&
					this.countRunning("implementation") < this.config.implementationConcurrency &&
					(await this.ensureDependenciesResolved(issue))
				) {
					this.startIssueRun(metadata.id, "implementation", (signal) => this.runImplementation(metadata.id, signal));
				}
			}
		} finally {
			this.ticking = false;
		}
	}

	async ensureDependenciesResolved(issue) {
		const dependencyIssueId = getDependencyIssueId(issue.metadata);
		if (!dependencyIssueId || issue.metadata.dependencies?.resolvedAt) return true;
		let dependency = null;
		try {
			dependency = await this.store.loadIssue(dependencyIssueId);
		} catch {
			return false;
		}
		if (dependency.metadata.id !== dependencyIssueId || !isDependencyResolved(dependency.metadata)) return false;

		const resolvedAt = nowIso();
		await this.store.updateMetadata(issue.metadata.id, (metadata) => {
			if (metadata.dependencies?.resolvedAt) return metadata;
			return {
				...metadata,
				dependencies: {
					...metadata.dependencies,
					issueId: dependencyIssueId,
					resolvedAt,
				},
			};
		});
		await this.store.appendEvent(issue.metadata.id, {
			type: "dependency_resolved",
			dependencyIssueId,
			dependencyTitle: dependency.metadata.title,
			message: `${dependencyLabel(issue.metadata)} resolved.`,
		});
		return true;
	}

	startIssueRun(issueId, group, fn) {
		const controller = new AbortController();
		const record = { group, controller, done: null };
		this.running.set(issueId, record);
		record.done = Promise.resolve()
			.then(() => fn(controller.signal))
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

	async coordinateKick(issueId, operation) {
		if (this.kicking.has(issueId)) throw new Error("A kick request is already in flight for this ticket.");
		this.kicking.add(issueId);
		let interrupted = false;
		const interrupt = async () => {
			if (interrupted) return;
			interrupted = true;
			const run = this.running.get(issueId);
			if (!run) return;
			run.controller.abort();
			await run.done;
		};
		let completed = false;
		try {
			const result = await operation({ interrupt });
			completed = true;
			return result;
		} finally {
			this.kicking.delete(issueId);
			if (completed && !this.stopping) this.queueTick();
		}
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
			const supportsStageRecovery = metadata.lane === LANE.PLANNING || metadata.lane === LANE.IN_PROGRESS;
			if (!supportsStageRecovery) {
				await this.store.updateMetadata(metadata.id, (current) => ({
					...current,
					automation: {
						...current.automation,
						activeRunId: null,
						activeRole: null,
					},
				}));
				await this.store.appendEvent(metadata.id, { type: "interrupted_run_recovered", role: activeRole, runId: activeRunId });
				continue;
			}

			const target = await this.store.findRecoveryTarget(issue);
			let recoveryError = null;
			try {
				await recoverIssueWorkspace(this.store, issue);
			} catch (error) {
				recoveryError = error instanceof Error ? error.message : String(error);
			}
			await this.store.updateMetadata(metadata.id, (current) => ({
				...current,
				automation: {
					...current.automation,
					activeRunId: null,
					activeRole: null,
					paused: !!recoveryError,
					error: recoveryError,
					recovery: recoveryError ? current.automation?.recovery || null : {
						role: target.role,
						sourceRunId: target.runId,
						sessionFile: target.sessionFile,
						mode: target.sessionAvailable ? "resume" : "restart",
						requestedAt: nowIso(),
					},
				},
			}));
			await this.store.appendEvent(metadata.id, {
				type: "interrupted_run_recovered",
				role: activeRole,
				runId: activeRunId,
				recoveryRole: target.role,
				mode: target.sessionAvailable ? "resume" : "restart",
				...(recoveryError ? { error: recoveryError } : {}),
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

	async runAgentStage(issueId, role, prompt, signal, recovery = null) {
		let issue = await this.store.loadIssue(issueId);
		const stageRecovery = recovery?.role === role ? recovery : null;
		const sessionFile = stageRecovery?.mode === "resume" ? stageRecovery.sessionFile : null;
		await this.markActive(issueId, role, "starting");
		return this.runner.run({
			issueId,
			role,
			cwd: issue.metadata.workspace.path,
			prompt,
			signal,
			agentSettings: this.agentSettingsFor(issue, role),
			...(sessionFile ? { sessionFile } : {}),
			onRunStarted: async (runId) => {
				await this.markRunStarted(issueId, role, runId);
				if (!stageRecovery) return;
				await this.store.updateMetadata(issueId, (metadata) => ({
					...metadata,
					automation: {
						...metadata.automation,
						recovery: null,
						resumeSessionFile: null,
						resumeRunId: null,
					},
				}));
				await this.store.appendEvent(issueId, {
					type: "agent_recovery_started",
					role,
					runId,
					sourceRunId: stageRecovery.sourceRunId,
					mode: stageRecovery.mode,
				});
				if (sessionFile) {
					await this.store.appendEvent(issueId, {
						type: "agent_session_resumed",
						role,
						runId,
						sourceRunId: stageRecovery.sourceRunId,
						sessionFile,
					});
					if (role === "worker") {
						await this.store.appendEvent(issueId, {
							type: "implementation_resume_started",
							runId,
							resumeRunId: stageRecovery.sourceRunId,
							resumeSessionFile: sessionFile,
						});
					}
				}
			},
		});
	}

	async runPlanning(issueId, signal) {
		let issue = await this.store.loadIssue(issueId);
		if (!(await this.ensureDependenciesResolved(issue))) return;
		issue = await this.store.loadIssue(issueId);
		const storedRecovery = issue.metadata.automation?.recovery?.role === "planner" ? issue.metadata.automation.recovery : null;
		const recoveryTarget = storedRecovery ? await this.store.findRecoveryTarget(issue) : null;
		const recovery = storedRecovery ? {
			...storedRecovery,
			mode: recoveryTarget.sessionAvailable ? "resume" : "restart",
			sessionFile: recoveryTarget.sessionFile,
		} : null;
		if (!recovery && (issue.metadata.automation?.planningAttempts || 0) >= MAX_PLANNING_ATTEMPTS && issue.metadata.lane !== LANE.CREATED) {
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
				planningAttempts: recovery
					? Math.max(metadata.automation?.planningAttempts || 0, 1)
					: (metadata.automation?.planningAttempts || 0) + 1,
				paused: false,
				error: null,
			},
		}));
		await this.store.appendEvent(issueId, {
			type: recovery ? "planning_recovery_attempt_started" : "planning_started",
			mode: recovery?.mode,
			sourceRunId: recovery?.sourceRunId,
		});

		issue = await this.store.loadIssue(issueId);
		await recoverIssueWorkspace(this.store, issue);
		issue = await this.store.loadIssue(issueId);

		const result = await this.runAgentStage(issueId, "planner", buildPlannerPrompt(issue), signal, recovery);
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
		let issue = await this.store.loadIssue(issueId);
		if (!(await this.ensureDependenciesResolved(issue))) return;
		issue = await this.store.loadIssue(issueId);
		const storedRecovery = issue.metadata.automation?.recovery || null;
		const recoveryTarget = storedRecovery ? await this.store.findRecoveryTarget(issue) : null;
		let recovery = storedRecovery ? {
			...storedRecovery,
			mode: recoveryTarget.sessionAvailable ? "resume" : "restart",
			sessionFile: recoveryTarget.sessionFile,
		} : null;
		if (recovery && !(issue.metadata.automation?.implementationAttempts > 0)) {
			await this.store.updateMetadata(issueId, (metadata) => ({
				...metadata,
				automation: { ...metadata.automation, implementationAttempts: 1 },
			}));
			issue = await this.store.loadIssue(issueId);
		}
		let stage = ["worker", "reviewer", "final-reviewer"].includes(recovery?.role) ? recovery.role : "worker";
		let feedback = "";
		let workerOutput = stage === "worker" ? "" : await this.store.findLatestRoleOutput(issueId, "worker");
		let reviewOutput = stage === "final-reviewer" ? await this.store.findLatestRoleOutput(issueId, "reviewer") : "";
		while (true) {
			if (stage === "worker") {
				issue = await this.store.loadIssue(issueId);
				const recoveringWorker = recovery?.role === "worker";
				const currentAttempts = issue.metadata.automation?.implementationAttempts || 0;
				const nextAttempt = recoveringWorker ? Math.max(currentAttempts, 1) : currentAttempts + 1;
				if (!recoveringWorker && nextAttempt > MAX_IMPLEMENTATION_ATTEMPTS) {
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
				await this.store.appendEvent(issueId, {
					type: recoveringWorker
						? (recovery.mode === "resume" ? "implementation_resume_attempt_started" : "implementation_recovery_attempt_started")
						: "implementation_attempt_started",
					attempt: nextAttempt,
					resumeRunId: recovery?.sourceRunId,
				});
				issue = await this.store.loadIssue(issueId);
				await recoverIssueWorkspace(this.store, issue);
				issue = await this.store.loadIssue(issueId);
				const worker = await this.runAgentStage(issueId, "worker", buildWorkerPrompt(issue, feedback), signal, recoveringWorker ? recovery : null);
				workerOutput = worker.text;
				await this.store.appendEvent(issueId, { type: "worker_finished", runId: worker.runId });
				recovery = null;
				stage = "reviewer";
			}

			if (stage === "reviewer") {
				issue = await this.store.loadIssue(issueId);
				await recoverIssueWorkspace(this.store, issue);
				issue = await this.store.loadIssue(issueId);
				const recoveringReviewer = recovery?.role === "reviewer";
				const review = await this.runAgentStage(issueId, "reviewer", buildReviewerPrompt(issue, workerOutput), signal, recoveringReviewer ? recovery : null);
				reviewOutput = review.text;
				const reviewDecision = parseDecision(review.text);
				await this.store.appendEvent(issueId, { type: "reviewer_finished", runId: review.runId, decision: reviewDecision });
				recovery = null;
				if (reviewDecision !== "PASS") {
					feedback = review.text;
					stage = "worker";
					continue;
				}
				stage = "final-reviewer";
			}

			issue = await this.store.loadIssue(issueId);
			await recoverIssueWorkspace(this.store, issue);
			issue = await this.store.loadIssue(issueId);
			const recoveringFinalReviewer = recovery?.role === "final-reviewer";
			const finalReview = await this.runAgentStage(
				issueId,
				"final-reviewer",
				buildFinalReviewerPrompt(issue, `${workerOutput}\n\n${reviewOutput}`),
				signal,
				recoveringFinalReviewer ? recovery : null,
			);
			recovery = null;
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
			stage = "worker";
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
