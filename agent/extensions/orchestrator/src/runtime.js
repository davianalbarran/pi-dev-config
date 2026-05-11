import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import { DEFAULT_CONFIG } from "./constants.js";
import { buildMergerPrompt, buildSpecWriterPrompt, parseMergerOutput } from "./prompts.js";
import { RpcAgentRunner } from "./rpc-runner.js";
import { OrchestratorScheduler } from "./scheduler.js";
import { OrchestratorServer } from "./server.js";
import { IssueStore } from "./store.js";
import { commitIssueWorktree, execGit } from "./workspace.js";
import { nowIso } from "./utils.js";
import {
	approvePlan,
	approveReview,
	getDependencyIssueId,
	isDependencyResolved,
	requestPlanChanges,
	requestReviewChanges,
	resumeBlockedReason,
} from "./workflow.js";

export function createOrchestratorRuntime(options = {}) {
	return new OrchestratorRuntime(options);
}

function isTruthyEnv(value) {
	return /^(1|true|yes)$/i.test(String(value || "").trim());
}

export function parseOrchestratorEnv(env = process.env) {
	const config = {};
	if (isTruthyEnv(env.PI_ORCHESTRATOR_BIND_LAN)) config.host = "0.0.0.0";
	const host = String(env.PI_ORCHESTRATOR_HOST || "").trim();
	if (host) config.host = host;
	if (!config.host) config.host = DEFAULT_CONFIG.host;

	const portRaw = String(env.PI_ORCHESTRATOR_PORT || "").trim();
	if (portRaw) {
		const port = Number(portRaw);
		if (Number.isInteger(port) && port >= 0 && port <= 65535) config.port = port;
	}
	return config;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function mergeTargetKey(metadata) {
	const repoRoot = String(metadata?.git?.repoRoot || "").trim();
	const baseBranch = String(metadata?.git?.baseBranch || "").trim();
	if (!repoRoot || !baseBranch) return null;
	return JSON.stringify([repoRoot, baseBranch]);
}

function mergeTargetError(metadata) {
	return new Error(`Another merge is already active for ${metadata.git.baseBranch} in ${metadata.git.repoRoot}.`);
}

function isActiveMerger(metadata) {
	return metadata?.automation?.activeRole === "merger" && !!metadata?.automation?.activeRunId;
}

async function validDirectoryOrNull(value) {
	const dir = String(value || "").trim();
	if (!dir) return null;
	try {
		const stat = await fsp.stat(dir);
		return stat.isDirectory() ? dir : null;
	} catch {
		return null;
	}
}

async function verifyIssueBranchMerged(metadata) {
	if (!metadata.git?.repoRoot || !metadata.git?.branchName || !metadata.git?.baseBranch) return null;
	const branchHead = (
		await execGit(["rev-parse", "--verify", `refs/heads/${metadata.git.branchName}^{commit}`], metadata.git.repoRoot)
	).stdout.trim();
	const baseHead = (
		await execGit(["rev-parse", "--verify", `refs/heads/${metadata.git.baseBranch}^{commit}`], metadata.git.repoRoot)
	).stdout.trim();
	return {
		finalCommitSha: branchHead,
		mergedToBranch: metadata.git.baseBranch,
		mergeCommitSha: baseHead,
		mergedAt: nowIso(),
	};
}

export class OrchestratorRuntime {
	constructor(options = {}) {
		this.config = { ...DEFAULT_CONFIG, ...(options.config || {}) };
		this.store = new IssueStore({ dataRoot: options.dataRoot });
		this.runner = new RpcAgentRunner({
			store: this.store,
			timeoutMs: this.config.agentTimeoutMs,
			idleTimeoutMs: this.config.agentIdleTimeoutMs,
		});
		this.scheduler = new OrchestratorScheduler({
			store: this.store,
			runner: this.runner,
			config: this.config,
			onEvent: (event) => this.server?.broadcast({ type: "scheduler", event }),
		});
		this.server = null;
		this.token = options.token || crypto.randomBytes(24).toString("hex");
		this.url = null;
		this.shareInfo = null;
		this.started = false;
		this.issueCount = 0;
		this.unsubscribe = null;
		this.activeMergeKeys = new Set();
	}

	async start(ctx = null) {
		if (this.started) return this.url;
		await this.store.init();
		this.unsubscribe = this.store.onChange(() => {
			void this.refreshIssueCount();
		});
		await this.refreshIssueCount();

		this.server = new OrchestratorServer({
			store: this.store,
			token: this.token,
			config: this.config,
			actions: this.createActions(),
		});
		this.url = await this.server.start();
		this.shareInfo = this.server.getShareInfo();
		this.store.startWatcher();
		this.scheduler.start();
		this.started = true;

		if (ctx?.hasUI) {
			const lines = this.statusLines();
			ctx.ui.notify(`Pi orchestrator board: ${this.url}${this.shareInfo?.networkUrl ? `\nNetwork: ${this.shareInfo.networkUrl}` : ""}`, "info");
			ctx.ui.setStatus("pi-orchestrator", "orchestrator running");
			ctx.ui.setWidget("pi-orchestrator", [
				"Pi orchestrator",
				...lines,
				`Data: ${this.store.dataRoot}`,
			]);
		}
		return this.url;
	}

	async stop() {
		if (!this.started) return;
		await this.scheduler.stop();
		this.store.stopWatcher();
		if (this.server) await this.server.stop();
		if (this.unsubscribe) this.unsubscribe();
		this.unsubscribe = null;
		this.server = null;
		this.shareInfo = null;
		this.started = false;
	}

	getStatus() {
		return {
			started: this.started,
			url: this.url,
			localUrl: this.shareInfo?.localUrl || this.url,
			networkUrl: this.shareInfo?.networkUrl || null,
			shareUrl: this.shareInfo?.shareUrl || this.url,
			dataRoot: this.store.dataRoot,
			issueCount: this.issueCount,
		};
	}

	statusLines() {
		const lines = [`Local: ${this.shareInfo?.localUrl || this.url}`];
		if (this.shareInfo?.networkUrl) lines.push(`Network: ${this.shareInfo.networkUrl}`);
		return lines;
	}

	async refreshIssueCount() {
		try {
			this.issueCount = (await this.store.listIssueIds()).length;
		} catch {
			this.issueCount = 0;
		}
	}

	async activeMergeForTarget(mergeKey, currentIssueId) {
		const issues = await this.store.listIssues();
		return issues.find(
			(issue) =>
				issue.metadata.id !== currentIssueId &&
				mergeTargetKey(issue.metadata) === mergeKey &&
				isActiveMerger(issue.metadata),
		);
	}

	async approveReviewAndMerge(id) {
		const issue = await this.store.loadIssue(id);
		approveReview(issue.metadata);
		if (!issue.metadata.git?.repoRoot || !issue.metadata.git?.branchName || !issue.metadata.git?.baseBranch) {
			throw new Error("Approve and merge requires a git-backed issue worktree.");
		}
		const mergeKey = mergeTargetKey(issue.metadata);
		if ((await this.activeMergeForTarget(mergeKey, id)) || this.activeMergeKeys.has(mergeKey)) {
			throw mergeTargetError(issue.metadata);
		}
		this.activeMergeKeys.add(mergeKey);
		try {
			await this.store.updateMetadata(id, (metadata) => ({
				...metadata,
				automation: {
					...metadata.automation,
					activeRunId: "starting",
					activeRole: "merger",
					paused: false,
					error: null,
				},
			}));
			await this.store.appendEvent(id, { type: "review_merge_requested" });
		} catch (error) {
			this.activeMergeKeys.delete(mergeKey);
			throw error;
		}
		void this.runReviewMerge(id);
		return this.store.loadIssue(id);
	}

	async hasUnresolvedDependency(issue) {
		const dependencyId = getDependencyIssueId(issue.metadata);
		if (!dependencyId || issue.metadata.dependencies?.resolvedAt) return false;
		const dependency = await this.store.loadIssue(dependencyId).catch(() => null);
		return !dependency || !isDependencyResolved(dependency.metadata);
	}

	async resumeBlockedIssue(id) {
		const issue = await this.store.loadIssue(id);
		const hasUnresolvedDependency = await this.hasUnresolvedDependency(issue);
		const reason = resumeBlockedReason(issue.metadata, { hasUnresolvedDependency });
		if (reason) throw new Error(reason);

		const resume = await this.store.findLatestResumableWorkerSession(id);
		if (!resume.canResume) throw new Error(resume.reason || "No resumable worker session is available for this ticket.");

		await this.store.updateMetadata(id, (metadata) => {
			const currentReason = resumeBlockedReason(metadata, { hasUnresolvedDependency });
			if (currentReason) throw new Error(currentReason);
			return {
				...metadata,
				automation: {
					...metadata.automation,
					paused: false,
					error: null,
					activeRunId: null,
					activeRole: null,
					resumeSessionFile: resume.sessionFile,
					resumeRunId: resume.runId,
				},
			};
		});
		await this.store.appendEvent(id, {
			type: "blocked_issue_resume_requested",
			resumeRunId: resume.runId,
		});
		this.scheduler.queueTick();
		return this.store.loadIssue(id);
	}

	async runReviewMerge(id) {
		let runId = null;
		let mergeKey = null;
		try {
			let issue = await this.store.loadIssue(id);
			mergeKey = mergeTargetKey(issue.metadata);
			const result = await this.runner.run({
				issueId: id,
				role: "merger",
				cwd: issue.metadata.git.repoRoot,
				prompt: buildMergerPrompt(issue),
				agentSettings: null,
				onRunStarted: async (startedRunId) => {
					runId = startedRunId;
					await this.store.updateMetadata(id, (metadata) => ({
						...metadata,
						automation: {
							...metadata.automation,
							activeRunId: startedRunId,
							activeRole: "merger",
							paused: false,
							error: null,
						},
					}));
					await this.store.appendEvent(id, { type: "agent_run_started", role: "merger", runId: startedRunId });
				},
			});
			runId = result.runId;
			const parsed = parseMergerOutput(result.text);
			await this.store.appendEvent(id, {
				type: "merger_finished",
				runId: result.runId,
				result: parsed.result,
			});
			if (parsed.result !== "MERGED") {
				throw new Error(parsed.summary || "Merger reported BLOCKED.");
			}

			issue = await this.store.loadIssue(id);
			const mergedGit = await verifyIssueBranchMerged(issue.metadata);
			await this.store.updateMetadata(id, (metadata) => ({
				...metadata,
				git: mergedGit
					? {
							...metadata.git,
							...mergedGit,
						}
					: metadata.git,
				automation: {
					...metadata.automation,
					activeRunId: null,
					activeRole: null,
					paused: false,
					error: null,
				},
			}));
			issue = await this.store.loadIssue(id);
			await this.store.writeMetadata(id, approveReview(issue.metadata));
			await this.store.appendEvent(id, {
				type: "review_approved_and_merged",
				runId: result.runId,
				mergeCommitSha: mergedGit?.mergeCommitSha || null,
				mergedToBranch: mergedGit?.mergedToBranch || null,
			});
		} catch (error) {
			const message = errorMessage(error);
			await this.store.updateMetadata(id, (metadata) => ({
				...metadata,
				automation: {
					...metadata.automation,
					activeRunId: null,
					activeRole: null,
					paused: true,
					error: message,
				},
			}));
			await this.store.appendEvent(id, { type: "review_merge_failed", runId, error: message });
		} finally {
			if (mergeKey) this.activeMergeKeys.delete(mergeKey);
		}
	}

	createActions() {
		return {
			improveSpec: async (body = {}) => {
				const spec = String(body.spec || "").trim();
				if (!spec) throw new Error("Spec is required to improve it.");
				const cwd = (await validDirectoryOrNull(body.linkedDirectory)) || process.cwd();
				const result = await this.runner.run({
					issueId: "spec-writer",
					role: "spec-writer",
					cwd,
					prompt: buildSpecWriterPrompt({ spec, suggestions: body.suggestions }),
					agentSettings: null,
					internal: true,
				});
				const improvedSpec = String(result?.text || "").trim();
				if (!improvedSpec) throw new Error("Spec writer returned an empty spec.");
				return { spec: improvedSpec };
			},
			createIssue: async (body) => {
				const issue = await this.store.createIssue({
					title: body.title,
					spec: body.spec,
					linkedDirectory: body.linkedDirectory,
					agentSettings: body.agentSettings,
					dependencyIssueId: body.dependencyIssueId,
					backlog: body.backlog,
				});
				if (!body.backlog) this.scheduler.queueTick();
				return issue;
			},
			updateBacklogIssue: async (id, body) => this.store.updateBacklogIssue(id, body),
			sendBacklogIssueToAgent: async (id) => {
				const issue = await this.store.sendBacklogIssueToAgent(id);
				this.scheduler.queueTick();
				return issue;
			},
			comment: async (id, body) => {
				const comment = await this.store.appendComment(id, {
					author: "human",
					phase: body.phase || "general",
					text: body.text,
				});
				return { comment, issue: await this.store.loadIssue(id) };
			},
			approvePlan: async (id) => {
				const issue = await this.store.loadIssue(id);
				await this.store.writeMetadata(id, approvePlan(issue.metadata));
				await this.store.appendEvent(id, { type: "plan_approved" });
				this.scheduler.queueTick();
				return this.store.loadIssue(id);
			},
			requestPlanChanges: async (id, body) => {
				const issue = await this.store.loadIssue(id);
				const next = requestPlanChanges(issue.metadata);
				await this.store.appendComment(id, { author: "human", phase: "plan", text: body.text });
				await this.store.writeMetadata(id, next);
				await this.store.appendEvent(id, { type: "plan_changes_requested" });
				this.scheduler.queueTick();
				return this.store.loadIssue(id);
			},
			approveReview: async (id) => {
				const before = await this.store.loadIssue(id);
				approveReview(before.metadata);
				const commit = await commitIssueWorktree(this.store, id);
				const issue = await this.store.loadIssue(id);
				await this.store.writeMetadata(id, approveReview(issue.metadata));
				await this.store.appendEvent(id, { type: "review_approved", commit });
				return this.store.loadIssue(id);
			},
			approveReviewAndMerge: async (id) => this.approveReviewAndMerge(id),
			requestReviewChanges: async (id, body) => {
				const issue = await this.store.loadIssue(id);
				const next = requestReviewChanges(issue.metadata);
				await this.store.appendComment(id, { author: "human", phase: "review", text: body.text });
				await this.store.writeMetadata(id, next);
				await this.store.appendEvent(id, { type: "review_changes_requested" });
				this.scheduler.queueTick();
				return this.store.loadIssue(id);
			},
			resumeBlockedIssue: async (id) => this.resumeBlockedIssue(id),
		};
	}
}
