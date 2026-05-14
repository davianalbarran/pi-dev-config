import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import { DEFAULT_CONFIG, LANE } from "./constants.js";
import { buildFeatureSuggestorPrompt, buildMergerPrompt, buildSpecWriterPrompt, parseFeatureSuggestorOutput, parseMergerOutput } from "./prompts.js";
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

function gitRequestFor(metadata) {
	return metadata?.git?.request || metadata?.gitRequest || null;
}

function mergeTargetBranch(metadata) {
	const request = gitRequestFor(metadata);
	const requestedNewBranch = String(request?.newBranchName || "").trim();
	if (request?.mode === "new" && requestedNewBranch) return requestedNewBranch;
	return String(metadata?.git?.baseBranch || "").trim();
}

function mergeTargetKey(metadata) {
	const repoRoot = String(metadata?.git?.repoRoot || "").trim();
	const targetBranch = mergeTargetBranch(metadata);
	if (!repoRoot || !targetBranch) return null;
	return JSON.stringify([repoRoot, targetBranch]);
}

function mergeTargetError(metadata) {
	return new Error(`Another merge is already active for ${mergeTargetBranch(metadata)} in ${metadata.git.repoRoot}.`);
}

function safeFeatureSuggestorScope(projectId) {
	const raw = String(projectId || "project").trim() || "project";
	if (/^[A-Za-z0-9_-]+$/.test(raw)) return raw;
	const slug = raw
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "project";
	const digest = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12);
	return `${slug}-${digest}`;
}

function featureSuggestorIssueId(projectId) {
	return `feature-suggestor-${safeFeatureSuggestorScope(projectId)}`;
}

function isActiveMerger(metadata) {
	return metadata?.automation?.activeRole === "merger" && !!metadata?.automation?.activeRunId;
}

function unsafeNewBranchMergeTopology(metadata) {
	const request = gitRequestFor(metadata);
	if (request?.mode !== "new") return false;
	const targetBranch = mergeTargetBranch(metadata);
	const issueBranch = String(metadata?.git?.branchName || "").trim();
	return !!targetBranch && !!issueBranch && targetBranch === issueBranch;
}

function assertSafeMergeTopology(metadata) {
	if (!unsafeNewBranchMergeTopology(metadata)) return;
	throw new Error(
		`New-branch merge target ${mergeTargetBranch(metadata)} matches the issue worktree branch. ` +
		"Recreate the ticket so the worktree uses an isolated orchestrator branch before approving and merging.",
	);
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
	const targetBranch = mergeTargetBranch(metadata);
	if (!metadata.git?.repoRoot || !metadata.git?.branchName || !targetBranch) return null;
	const branchHead = (
		await execGit(["rev-parse", "--verify", `refs/heads/${metadata.git.branchName}^{commit}`], metadata.git.repoRoot)
	).stdout.trim();
	const targetHead = (
		await execGit(["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`], metadata.git.repoRoot)
	).stdout.trim();
	return {
		finalCommitSha: branchHead,
		mergedToBranch: targetBranch,
		mergeCommitSha: targetHead,
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
		this.backlogSuggestionRun = null;
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
		if (!issue.metadata.git?.repoRoot || !issue.metadata.git?.branchName || !mergeTargetBranch(issue.metadata)) {
			throw new Error("Approve and merge requires a git-backed issue worktree.");
		}
		assertSafeMergeTopology(issue.metadata);
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

	backlogSuggestionProjectState(project) {
		return {
			projectId: project.id,
			projectName: project.name,
			projectPath: project.path,
			status: "pending",
			runId: null,
			createdCount: 0,
			skippedCount: 0,
			error: null,
		};
	}

	copyBacklogSuggestionRun() {
		const run = this.backlogSuggestionRun;
		if (!run) return { active: false, status: "idle", projects: [] };
		return {
			id: run.id,
			active: run.status === "running",
			status: run.status,
			startedAt: run.startedAt,
			completedAt: run.completedAt || null,
			error: run.error || null,
			totalProjects: run.totalProjects,
			createdCount: run.projects.reduce((total, project) => total + (project.createdCount || 0), 0),
			skippedCount: run.projects.reduce((total, project) => total + (project.skippedCount || 0), 0),
			failedCount: run.projects.filter((project) => project.status === "failed").length,
			projects: run.projects.map((project) => ({ ...project })),
		};
	}

	getBacklogSuggestionState() {
		return this.copyBacklogSuggestionRun();
	}

	broadcastBacklogSuggestionRun() {
		this.server?.broadcast({ type: "backlog_suggestions", backlogSuggestions: this.getBacklogSuggestionState() });
	}

	async startBacklogSuggestions() {
		if (this.backlogSuggestionRun?.status === "running") {
			throw new Error("Backlog suggestion generation is already running.");
		}
		const runId = `backlog-suggestions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		this.backlogSuggestionRun = {
			id: runId,
			status: "running",
			startedAt: nowIso(),
			completedAt: null,
			error: null,
			totalProjects: 0,
			projects: [],
		};
		this.broadcastBacklogSuggestionRun();

		let projects;
		try {
			projects = await this.store.listProjects();
		} catch (error) {
			if (this.backlogSuggestionRun?.id === runId) {
				this.backlogSuggestionRun.status = "failed";
				this.backlogSuggestionRun.completedAt = nowIso();
				this.backlogSuggestionRun.error = errorMessage(error);
				this.broadcastBacklogSuggestionRun();
			}
			throw error;
		}
		if (!projects.length) {
			if (this.backlogSuggestionRun?.id === runId) {
				this.backlogSuggestionRun = null;
				this.broadcastBacklogSuggestionRun();
			}
			throw new Error("No projects configured. Add a Project before suggesting backlog items.");
		}
		if (this.backlogSuggestionRun?.id !== runId) throw new Error("Backlog suggestion generation was interrupted.");
		this.backlogSuggestionRun.totalProjects = projects.length;
		this.backlogSuggestionRun.projects = projects.map((project) => this.backlogSuggestionProjectState(project));
		this.broadcastBacklogSuggestionRun();
		void this.runBacklogSuggestions(runId, projects);
		return this.getBacklogSuggestionState();
	}

	backlogSuggestionProjectEntry(runId, projectId) {
		if (this.backlogSuggestionRun?.id !== runId) return null;
		return this.backlogSuggestionRun.projects.find((entry) => entry.projectId === projectId) || null;
	}

	updateBacklogSuggestionProject(runId, projectId, updates) {
		const entry = this.backlogSuggestionProjectEntry(runId, projectId);
		if (!entry) return;
		Object.assign(entry, updates);
		this.broadcastBacklogSuggestionRun();
	}

	async existingBacklogIssuesForProject(projectId) {
		const issues = await this.store.listIssues();
		return issues.filter((issue) => issue.metadata.projectId === projectId && issue.metadata.lane === LANE.BACKLOG);
	}

	async runBacklogSuggestionsForProject(runId, project, seenSuggestions) {
		this.updateBacklogSuggestionProject(runId, project.id, { status: "running", error: null });
		const existingBefore = await this.existingBacklogIssuesForProject(project.id);
		const result = await this.runner.run({
			issueId: featureSuggestorIssueId(project.id),
			role: "feature-suggestor",
			cwd: project.path,
			prompt: buildFeatureSuggestorPrompt({ project, existingBacklogIssues: existingBefore }),
			agentSettings: null,
			internal: true,
			onRunStarted: (startedRunId) => {
				this.updateBacklogSuggestionProject(runId, project.id, { runId: startedRunId });
			},
		});
		const suggestions = parseFeatureSuggestorOutput(result?.text || "");
		const existingNow = await this.existingBacklogIssuesForProject(project.id);
		const existingTitles = new Set(existingNow.map((issue) => String(issue.metadata.title || "").trim()).filter(Boolean));
		let createdCount = 0;
		let skippedCount = 0;
		for (const suggestion of suggestions) {
			const duplicateKey = `${project.id}\0${suggestion.title}\0${suggestion.spec}`;
			if (seenSuggestions.has(duplicateKey) || existingTitles.has(suggestion.title)) {
				skippedCount += 1;
				continue;
			}
			seenSuggestions.add(duplicateKey);
			await this.store.createIssue({
				title: suggestion.title,
				spec: suggestion.spec,
				projectId: project.id,
				backlog: true,
			});
			existingTitles.add(suggestion.title);
			createdCount += 1;
		}
		this.updateBacklogSuggestionProject(runId, project.id, {
			status: "completed",
			runId: result?.runId || this.backlogSuggestionProjectEntry(runId, project.id)?.runId || null,
			createdCount,
			skippedCount,
			error: null,
		});
	}

	async runBacklogSuggestions(runId, projects) {
		const seenSuggestions = new Set();
		await Promise.all(projects.map(async (project) => {
			try {
				await this.runBacklogSuggestionsForProject(runId, project, seenSuggestions);
			} catch (error) {
				this.updateBacklogSuggestionProject(runId, project.id, {
					status: "failed",
					error: errorMessage(error),
				});
			}
		}));
		if (this.backlogSuggestionRun?.id !== runId) return;
		const failedCount = this.backlogSuggestionRun.projects.filter((project) => project.status === "failed").length;
		this.backlogSuggestionRun.status = failedCount === 0 ? "completed" : failedCount === projects.length ? "failed" : "partial-failed";
		this.backlogSuggestionRun.completedAt = nowIso();
		this.backlogSuggestionRun.error = failedCount ? `${failedCount} project${failedCount === 1 ? "" : "s"} failed during backlog suggestion generation.` : null;
		this.broadcastBacklogSuggestionRun();
	}

	async runReviewMerge(id) {
		let runId = null;
		let mergeKey = null;
		try {
			let issue = await this.store.loadIssue(id);
			mergeKey = mergeTargetKey(issue.metadata);
			assertSafeMergeTopology(issue.metadata);
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
			getBacklogSuggestionState: async () => this.getBacklogSuggestionState(),
			startBacklogSuggestions: async () => this.startBacklogSuggestions(),
			improveSpec: async (body = {}) => {
				const spec = String(body.spec || "").trim();
				if (!spec) throw new Error("Spec is required to improve it.");
				let projectPath = body.linkedDirectory;
				if (body.projectId) {
					const { project } = await this.store.resolveProject({ projectId: body.projectId });
					projectPath = project.path;
				}
				const cwd = (await validDirectoryOrNull(projectPath)) || process.cwd();
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
					projectId: body.projectId,
					projectName: body.projectName,
					projectPath: body.projectPath,
					gitRequest: body.gitRequest,
					agentSettings: body.agentSettings,
					dependencyIssueId: body.dependencyIssueId,
					backlog: body.backlog,
				});
				if (!body.backlog) this.scheduler.queueTick();
				return issue;
			},
			updateBacklogIssue: async (id, body) => this.store.updateBacklogIssue(id, body),
			deleteBacklogIssue: async (id) => this.store.deleteBacklogIssue(id),
			saveProject: async (body) => this.store.saveProject(body),
			deleteProject: async (id) => this.store.deleteProject(id),
			resolveProjectPath: async (body) => this.store.ensureProjectForPath(body.path || body.linkedDirectory, { name: body.name || body.title }),
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
