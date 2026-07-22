import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { COMPLETED_TICKET_CLEANUP_RETENTION_DAYS, DEFAULT_DATA_ROOT, DEFAULT_PROFILE_ID, LANE, LANES } from "./constants.js";
import {
	appendJsonLine,
	debounce,
	ensureDir,
	makeId,
	normalizePath,
	slugify,
	nowIso,
	readJson,
	readJsonLines,
	writeFileAtomic,
	writeJsonAtomic,
} from "./utils.js";
import { assembleAgentSession, sanitizeAgentStreamEvent } from "./agent-session.js";
import {
	createApprovalState,
	createAutomationState,
	getDependencyIssueId,
	isDependencyResolved,
	kickIssueReason,
	normalizeAgentSettings,
	normalizeMetadata,
	resumeBlockedReason,
} from "./workflow.js";
import { getGitProjectInfo, inspectIssueWorkspace } from "./workspace.js";

const MAX_DASHBOARD_RUN_EVENT_BYTES = 64 * 1024;

function compactDashboardRunEvent(event) {
	const serialized = JSON.stringify(event);
	if (Buffer.byteLength(serialized, "utf8") <= MAX_DASHBOARD_RUN_EVENT_BYTES) return event;
	return {
		type: event.type || "oversized_event",
		...(event.at ? { at: event.at } : {}),
		...(event.timestamp ? { timestamp: event.timestamp } : {}),
		truncated: true,
		originalBytes: Buffer.byteLength(serialized, "utf8"),
	};
}

export function assertSafeRunPathSegment(value, label = "run id") {
	const segment = String(value || "");
	if (!segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\")) {
		throw new Error(`Invalid ${label}.`);
	}
	return segment;
}

export function assertSafeIssueId(value) {
	return assertSafeRunPathSegment(value, "issue id");
}

export class IssueStore {
	constructor(options = {}) {
		this.dataRoot = options.dataRoot || DEFAULT_DATA_ROOT;
		this.issuesRoot = path.join(this.dataRoot, "issues");
		this.completedTicketArchiveRoot = path.join(this.issuesRoot, "__archived_completed__");
		this.worktreesRoot = path.join(this.dataRoot, "worktrees");
		this.sessionsRoot = path.join(this.dataRoot, "sessions");
		this.internalRunsRoot = path.join(this.dataRoot, "runs");
		this.profilesPath = path.join(this.dataRoot, "profiles.json");
		this.projectsPath = path.join(this.dataRoot, "projects.json");
		this.listeners = new Set();
		this.watchHandle = null;
		this.pollTimer = null;
		this.lastSnapshotFingerprint = "";
	}

	async init() {
		await ensureDir(this.issuesRoot);
		await ensureDir(this.worktreesRoot);
		await ensureDir(this.sessionsRoot);
		await ensureDir(this.internalRunsRoot);
	}

	normalizeProjectPath(pathInput) {
		if (!String(pathInput || "").trim()) throw new Error("Project path is required.");
		const normalized = normalizePath(pathInput);
		return normalized;
	}

	defaultProjectName(projectPath) {
		const base = path.basename(String(projectPath || "").replace(/[\\/]+$/, ""));
		return base || String(projectPath || "Project").trim() || "Project";
	}

	projectIdForPath(projectPath) {
		const digest = crypto.createHash("sha1").update(projectPath).digest("hex").slice(0, 12);
		return `project-${slugify(path.basename(projectPath), "project")}-${digest}`;
	}

	normalizeProject(raw = {}) {
		const normalizedPath = this.normalizeProjectPath(raw.path || raw.linkedDirectory || "");
		const now = nowIso();
		const id = String(raw.id || "").trim() || this.projectIdForPath(normalizedPath);
		const name = String(raw.name || raw.title || "").trim() || this.defaultProjectName(normalizedPath);
		const agentSettingsProfileId = String(raw.agentSettingsProfileId || "").trim() || null;
		return {
			id,
			name,
			path: normalizedPath,
			isGitRepository: !!raw.isGitRepository,
			git: raw.git || null,
			agentSettingsProfileId,
			createdAt: raw.createdAt || now,
			updatedAt: raw.updatedAt || raw.createdAt || now,
		};
	}

	async validateProjectPath(projectPath) {
		let stat;
		try {
			stat = await fsp.stat(projectPath);
		} catch (error) {
			throw new Error(`Project path is not accessible: ${projectPath}`);
		}
		if (!stat.isDirectory()) throw new Error(`Project path is not a directory: ${projectPath}`);
	}

	async projectGitMetadata(projectPath) {
		const info = await getGitProjectInfo(projectPath);
		return {
			isGitRepository: !!info.isGitRepository,
			git: info.isGitRepository
				? {
					repoRoot: info.repoRoot,
					currentBranch: info.currentBranch,
					defaultBranch: info.defaultBranch,
					branches: info.branches,
					error: info.error || null,
				}
				: {
					repoRoot: null,
					currentBranch: "",
					defaultBranch: "",
					branches: [],
					error: info.error || "Path is not a git repository.",
				},
		};
	}

	async readProjectsRaw() {
		await this.init();
		const raw = await readJson(this.projectsPath, []);
		const input = Array.isArray(raw) ? raw : Array.isArray(raw?.projects) ? raw.projects : [];
		const projects = [];
		const seenIds = new Set();
		const seenPaths = new Set();
		for (const item of input) {
			try {
				const project = this.normalizeProject(item);
				if (seenIds.has(project.id) || seenPaths.has(project.path)) continue;
				seenIds.add(project.id);
				seenPaths.add(project.path);
				projects.push(project);
			} catch {
				// Ignore malformed project records; callers should still get usable projects.
			}
		}
		return projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
	}

	async writeProjects(projects) {
		await writeJsonAtomic(this.projectsPath, projects);
	}

	async listProjects({ skipBackfill = false } = {}) {
		if (!skipBackfill) await this.backfillProjectsFromIssues();
		return this.readProjectsRaw();
	}

	async refreshProjectGitState(projectOrId) {
		await this.init();
		await this.backfillProjectsFromIssues();
		const requestedId = typeof projectOrId === "object" && projectOrId
			? String(projectOrId.id || "").trim()
			: String(projectOrId || "").trim();
		if (!requestedId) throw new Error("Project is required.");
		const projects = await this.readProjectsRaw();
		const project = projects.find((item) => item.id === requestedId);
		if (!project) throw new Error("Project is no longer configured.");
		await this.validateProjectPath(project.path);
		const gitMetadata = await this.projectGitMetadata(project.path);
		const refreshedProject = this.normalizeProject({
			...project,
			...gitMetadata,
			updatedAt: nowIso(),
		});
		const nextProjects = [refreshedProject, ...projects.filter((item) => item.id !== refreshedProject.id)].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
		await this.writeProjects(nextProjects);
		if (JSON.stringify(this.projectSnapshot(project)) !== JSON.stringify(this.projectSnapshot(refreshedProject))) {
			await this.updateIssueProjectSnapshots(refreshedProject);
		}
		this.emitChange({ type: "project_git_refreshed", id: refreshedProject.id });
		return { project: refreshedProject, projects: nextProjects };
	}

	async saveProject({ id, name, title, path: projectPath, linkedDirectory, agentSettingsProfileId } = {}) {
		await this.init();
		await this.backfillProjectsFromIssues();
		const normalizedPath = this.normalizeProjectPath(projectPath || linkedDirectory);
		await this.validateProjectPath(normalizedPath);
		const projects = await this.readProjectsRaw();
		const requestedId = String(id || "").trim();
		const duplicate = projects.find((project) => project.path === normalizedPath && project.id !== requestedId);
		if (duplicate) {
			const refreshed = await this.refreshProjectGitState(duplicate.id);
			return { ...refreshed, reused: true, message: `Using existing Project for ${normalizedPath}.` };
		}
		const now = nowIso();
		const existing = requestedId ? projects.find((project) => project.id === requestedId) : null;
		const nextAgentSettingsProfileId = agentSettingsProfileId === undefined
			? (existing?.agentSettingsProfileId || null)
			: (String(agentSettingsProfileId || "").trim() || null);
		if (nextAgentSettingsProfileId) {
			const profiles = await this.listProfiles();
			if (!profiles.some((profile) => profile.id === nextAgentSettingsProfileId)) throw new Error("Agent settings profile does not exist.");
		}
		const gitMetadata = await this.projectGitMetadata(normalizedPath);
		const project = this.normalizeProject({
			...(existing || {}),
			id: requestedId || existing?.id || this.projectIdForPath(normalizedPath),
			name: String(name ?? title ?? "").trim() || this.defaultProjectName(normalizedPath),
			path: normalizedPath,
			agentSettingsProfileId: nextAgentSettingsProfileId,
			...gitMetadata,
			createdAt: existing?.createdAt || now,
			updatedAt: now,
		});
		const nextProjects = [project, ...projects.filter((item) => item.id !== project.id)].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
		await this.writeProjects(nextProjects);
		if (existing) await this.updateIssueProjectSnapshots(project);
		this.emitChange({ type: "projects_updated", id: project.id });
		return { project, projects: nextProjects, reused: false };
	}

	async ensureProjectForPath(projectPath, { name, title } = {}) {
		const normalizedPath = this.normalizeProjectPath(projectPath);
		const projects = await this.readProjectsRaw();
		const existing = projects.find((project) => project.path === normalizedPath);
		if (existing) {
			const refreshed = await this.refreshProjectGitState(existing.id);
			return { ...refreshed, reused: true, message: `Using existing Project for ${normalizedPath}.` };
		}
		return this.saveProject({ name: name ?? title, path: normalizedPath });
	}

	async resolveProject(input = {}) {
		if (input.projectId) {
			try {
				const refreshed = await this.refreshProjectGitState(input.projectId);
				return { project: refreshed.project, reused: true };
			} catch (error) {
				if (String(error?.message || error).includes("no longer configured")) throw new Error("Selected Project is no longer configured.");
				throw error;
			}
		}
		if (input.projectPath || input.path || input.linkedDirectory) {
			return this.ensureProjectForPath(input.projectPath || input.path || input.linkedDirectory, { name: input.projectName || input.name });
		}
		throw new Error("Project is required.");
	}

	projectSnapshot(project) {
		return project ? { id: project.id, name: project.name, path: project.path, isGitRepository: !!project.isGitRepository } : null;
	}

	async projectTicketCounts(projectId) {
		const issues = await this.listIssues();
		let active = 0;
		let completed = 0;
		for (const issue of issues) {
			if (issue.metadata.projectId !== projectId) continue;
			if (issue.metadata.lane === LANE.COMPLETED) completed += 1;
			else active += 1;
		}
		return { active, completed };
	}

	async updateIssueProjectSnapshots(project) {
		const issues = await this.listIssues();
		for (const issue of issues) {
			if (issue.metadata.projectId !== project.id) continue;
			await this.writeMetadata(issue.metadata.id, {
				...issue.metadata,
				linkedDirectory: project.path,
				project: this.projectSnapshot(project),
			});
		}
	}

	async deleteProject(id) {
		await this.backfillProjectsFromIssues();
		const projectId = String(id || "").trim();
		const projects = await this.readProjectsRaw();
		const project = projects.find((item) => item.id === projectId);
		if (!project) throw new Error("Project is no longer configured.");
		const counts = await this.projectTicketCounts(projectId);
		if (counts.active > 0) throw new Error("Cannot delete a Project with active tickets.");
		const issues = await this.listIssues();
		const removedIds = [];
		for (const issue of issues) {
			if (issue.metadata.projectId === projectId && issue.metadata.lane === LANE.COMPLETED) {
				await fsp.rm(this.issueDir(issue.metadata.id), { recursive: true, force: true });
				await this.removeIssueAgentStreamData(issue.metadata.id);
				removedIds.push(issue.metadata.id);
			}
		}
		const nextProjects = projects.filter((item) => item.id !== projectId);
		await this.writeProjects(nextProjects);
		this.emitChange({ type: "project_deleted", id: projectId, removedIssueIds: removedIds });
		return { project, projects: nextProjects, removedIssueIds: removedIds, removedCount: removedIds.length };
	}

	async backfillProjectsFromIssues() {
		await this.init();
		const ids = await this.listIssueIds();
		if (!ids.length) return { projectsCreated: 0, issuesUpdated: 0 };
		let projects = await this.readProjectsRaw();
		let projectsChanged = false;
		let issuesUpdated = 0;
		for (const id of ids) {
			let issue;
			try {
				issue = await this.loadIssue(id);
			} catch {
				continue;
			}
			const metadata = issue.metadata;
			if (metadata.projectId || !metadata.linkedDirectory) continue;
			let project;
			try {
				const normalizedPath = this.normalizeProjectPath(metadata.linkedDirectory);
				project = projects.find((item) => item.path === normalizedPath);
				if (!project) {
					const gitMetadata = await this.projectGitMetadata(normalizedPath).catch(() => ({ isGitRepository: false, git: null }));
					project = this.normalizeProject({
						id: this.projectIdForPath(normalizedPath),
						name: this.defaultProjectName(normalizedPath),
						path: normalizedPath,
						...gitMetadata,
					});
					projects.push(project);
					projectsChanged = true;
				}
			} catch {
				continue;
			}
			await this.writeMetadata(id, {
				...metadata,
				linkedDirectory: project.path,
				projectId: project.id,
				project: this.projectSnapshot(project),
			});
			issuesUpdated += 1;
		}
		if (projectsChanged) {
			projects = projects.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
			await this.writeProjects(projects);
			this.emitChange({ type: "projects_backfilled" });
		}
		return { projectsCreated: projectsChanged ? projects.length : 0, issuesUpdated };
	}

	defaultProfile() {
		return {
			id: DEFAULT_PROFILE_ID,
			name: "Default",
			agentSettings: normalizeAgentSettings({}),
		};
	}

	normalizeProfile(profile = {}) {
		const id = String(profile.id || "").trim();
		const name = String(profile.name || "").trim();
		return {
			id: id || DEFAULT_PROFILE_ID,
			name: name || (id === DEFAULT_PROFILE_ID ? "Default" : "Untitled Profile"),
			agentSettings: normalizeAgentSettings(profile.agentSettings || {}),
		};
	}

	async listProfiles() {
		await this.init();
		const raw = await readJson(this.profilesPath, []);
		const input = Array.isArray(raw) ? raw : Array.isArray(raw?.profiles) ? raw.profiles : [];
		const profiles = [];
		const seen = new Set();
		for (const item of input) {
			const profile = this.normalizeProfile(item);
			if (!profile.id || seen.has(profile.id)) continue;
			seen.add(profile.id);
			profiles.push(profile);
		}
		if (!seen.has(DEFAULT_PROFILE_ID)) profiles.unshift(this.defaultProfile());
		return profiles.sort((a, b) => {
			if (a.id === DEFAULT_PROFILE_ID) return -1;
			if (b.id === DEFAULT_PROFILE_ID) return 1;
			return a.name.localeCompare(b.name);
		});
	}

	async saveProfile({ id, name, agentSettings } = {}) {
		await this.init();
		const profiles = await this.listProfiles();
		const requestedId = String(id || "").trim();
		const profileName = String(name || "").trim();
		if (!requestedId && !profileName) throw new Error("Profile name is required.");
		let nextId = requestedId || slugify(profileName, "profile");
		if (requestedId) {
			nextId = requestedId;
		} else {
			const used = new Set(profiles.map((profile) => profile.id));
			let suffix = 2;
			const baseId = nextId;
			while (used.has(nextId)) nextId = `${baseId}-${suffix++}`;
		}
		const existing = profiles.find((profile) => profile.id === nextId);
		const saved = this.normalizeProfile({
			id: nextId,
			name: profileName || existing?.name || (nextId === DEFAULT_PROFILE_ID ? "Default" : "Untitled Profile"),
			agentSettings,
		});
		const nextProfiles = [saved, ...profiles.filter((profile) => profile.id !== saved.id)].sort((a, b) => {
			if (a.id === DEFAULT_PROFILE_ID) return -1;
			if (b.id === DEFAULT_PROFILE_ID) return 1;
			return a.name.localeCompare(b.name);
		});
		await writeJsonAtomic(this.profilesPath, nextProfiles);
		this.emitChange({ type: "profiles_updated", id: saved.id });
		return { profile: saved, profiles: nextProfiles };
	}

	issueDir(id) {
		return path.join(this.issuesRoot, id);
	}

	issuePath(id, file) {
		return path.join(this.issueDir(id), file);
	}

	runPath(id, runId) {
		return path.join(this.issueDir(assertSafeRunPathSegment(id, "issue id")), "runs", `${assertSafeRunPathSegment(runId)}.jsonl`);
	}

	async removeIssueAgentStreamData(id, { issueDir = this.issueDir(id) } = {}) {
		const safeId = assertSafeRunPathSegment(id, "issue id");
		await Promise.all([
			fsp.rm(path.join(issueDir, "runs"), { recursive: true, force: true }),
			fsp.rm(path.join(this.sessionsRoot, safeId), { recursive: true, force: true }),
		]);
	}

	internalRunPath(scope, runId) {
		return path.join(this.internalRunsRoot, scope, `${runId}.jsonl`);
	}

	onChange(listener) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emitChange(event = { type: "change" }) {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				/* ignore listener errors */
			}
		}
	}

	async validateDependency(dependencyIssueId, { selfId = null } = {}) {
		const dependencyId = String(dependencyIssueId || "").trim() || null;
		if (!dependencyId) return { dependencyId: null, dependency: null };
		if (selfId && dependencyId === selfId) throw new Error("An issue cannot depend on itself.");
		let dependency = null;
		try {
			await fsp.access(this.issuePath(dependencyId, "metadata.json"));
			dependency = await this.loadIssue(dependencyId);
		} catch {
			throw new Error(`Dependency issue does not exist: ${dependencyId}`);
		}
		if (isDependencyResolved(dependency.metadata)) {
			throw new Error(`Dependency issue is already resolved: ${dependencyId}`);
		}
		return { dependencyId, dependency };
	}

	async createIssue({ title, spec, linkedDirectory, projectId, projectName, projectPath, gitRequest, agentSettings, dependencyIssueId, backlog = false }) {
		if (!title || !String(title).trim()) throw new Error("Title is required.");
		const { project } = await this.resolveProject({ projectId, projectName, projectPath, linkedDirectory });
		const linkedPath = project.path;
		const id = makeId(title);
		const { dependencyId, dependency } = await this.validateDependency(dependencyIssueId);
		const initialLane = backlog ? LANE.BACKLOG : LANE.CREATED;
		const createdAt = nowIso();
		const metadata = normalizeMetadata({
			id,
			title: String(title).trim(),
			lane: initialLane,
			linkedDirectory: linkedPath,
			projectId: project.id,
			project: this.projectSnapshot(project),
			gitRequest: gitRequest || null,
			createdAt,
			updatedAt: createdAt,
			automation: createAutomationState(),
			approvals: createApprovalState(),
			agentSettings,
			dependencies: { issueId: dependencyId, resolvedAt: null },
			workspace: null,
			git: null,
		});
		await ensureDir(path.join(this.issueDir(id), "runs"));
		await writeJsonAtomic(this.issuePath(id, "metadata.json"), metadata);
		await writeFileAtomic(this.issuePath(id, "spec.md"), `${String(spec || "").trim()}\n`);
		await writeFileAtomic(this.issuePath(id, "plan.md"), "");
		await writeFileAtomic(this.issuePath(id, "plan-report.md"), "");
		await writeFileAtomic(this.issuePath(id, "review-report.md"), "");
		await writeFileAtomic(this.issuePath(id, "comments.jsonl"), "");
		await writeFileAtomic(this.issuePath(id, "events.jsonl"), "");
		await this.appendEvent(id, {
			type: "issue_created",
			title: metadata.title,
			lane: metadata.lane,
			backlog: metadata.lane === LANE.BACKLOG,
			linkedDirectory: linkedPath,
			dependencyIssueId: dependencyId,
			dependencyTitle: dependency?.metadata?.title || null,
		});
		this.emitChange({ type: "issue_created", id, lane: metadata.lane, backlog: metadata.lane === LANE.BACKLOG });
		return this.loadIssue(id);
	}

	async updateBacklogIssue(id, { title, spec, linkedDirectory, projectId, projectName, projectPath, gitRequest, agentSettings, dependencyIssueId } = {}) {
		const issue = await this.loadIssue(id);
		if (issue.metadata.lane !== LANE.BACKLOG) throw new Error("Only Backlog issues can be edited this way.");
		if (!title || !String(title).trim()) throw new Error("Title is required.");
		const { project } = await this.resolveProject({ projectId, projectName, projectPath, linkedDirectory });
		const linkedPath = project.path;
		const { dependencyId, dependency } = await this.validateDependency(dependencyIssueId, { selfId: id });
		const metadata = await this.writeMetadata(id, {
			...issue.metadata,
			title: String(title).trim(),
			linkedDirectory: linkedPath,
			projectId: project.id,
			project: this.projectSnapshot(project),
			gitRequest: gitRequest || null,
			agentSettings,
			dependencies: { issueId: dependencyId, resolvedAt: null },
		});
		await writeFileAtomic(this.issuePath(id, "spec.md"), `${String(spec || "").trim()}\n`);
		await this.appendEvent(id, {
			type: "backlog_issue_updated",
			title: metadata.title,
			linkedDirectory: linkedPath,
			dependencyIssueId: dependencyId,
			dependencyTitle: dependency?.metadata?.title || null,
		});
		this.emitChange({ type: "backlog_issue_updated", id });
		return this.loadIssue(id);
	}

	async deleteBacklogIssue(id) {
		const safeId = assertSafeRunPathSegment(id, "issue id");
		const issue = await this.loadIssue(safeId);
		if (issue.metadata.lane !== LANE.BACKLOG) throw new Error("Only Backlog issues can be deleted this way.");
		await fsp.rm(this.issueDir(safeId), { recursive: true, force: true });
		await this.removeIssueAgentStreamData(safeId);
		this.emitChange({ type: "backlog_issue_deleted", id: safeId });
		return { id: safeId, removed: true };
	}

	async sendBacklogIssueToAgent(id) {
		const issue = await this.loadIssue(id);
		if (issue.metadata.lane !== LANE.BACKLOG) throw new Error("Only Backlog issues can be sent to the agent.");
		const dependencyId = String(issue.metadata.dependencies?.issueId || "").trim() || null;
		if (dependencyId) {
			const dependency = await this.loadIssue(dependencyId).catch(() => null);
			if (dependency?.metadata?.lane === LANE.BACKLOG && !isDependencyResolved(dependency.metadata)) {
				throw new Error(`Cannot send to agent while dependency ${dependencyId} is still in Backlog.`);
			}
		}
		await this.writeMetadata(id, {
			...issue.metadata,
			lane: LANE.CREATED,
			automation: {
				...issue.metadata.automation,
				paused: false,
				error: null,
				activeRunId: null,
				activeRole: null,
			},
		});
		await this.appendEvent(id, { type: "backlog_issue_sent_to_agent" });
		this.emitChange({ type: "backlog_issue_sent_to_agent", id });
		return this.loadIssue(id);
	}

	async listIssueIds() {
		await this.init();
		const entries = await fsp.readdir(this.issuesRoot, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("__"))
			.map((entry) => entry.name)
			.sort();
	}

	async loadIssue(id) {
		const metadata = normalizeMetadata(await readJson(this.issuePath(id, "metadata.json")));
		const [spec, plan, planReport, reviewReport, comments, events] = await Promise.all([
			fsp.readFile(this.issuePath(id, "spec.md"), "utf-8").catch((error) => {
				if (error.code === "ENOENT") return "";
				throw error;
			}),
			fsp.readFile(this.issuePath(id, "plan.md"), "utf-8").catch((error) => {
				if (error.code === "ENOENT") return "";
				throw error;
			}),
			fsp.readFile(this.issuePath(id, "plan-report.md"), "utf-8").catch((error) => {
				if (error.code === "ENOENT") return "";
				throw error;
			}),
			fsp.readFile(this.issuePath(id, "review-report.md"), "utf-8").catch((error) => {
				if (error.code === "ENOENT") return "";
				throw error;
			}),
			readJsonLines(this.issuePath(id, "comments.jsonl")),
			readJsonLines(this.issuePath(id, "events.jsonl")),
		]);
		return { metadata, spec, plan, planReport, reviewReport, comments, events };
	}

	async listIssues() {
		const ids = await this.listIssueIds();
		const issues = [];
		for (const id of ids) {
			try {
				issues.push(await this.loadIssue(id));
			} catch (error) {
				await this.appendSystemError(id, error);
			}
		}
		return issues.sort((a, b) => String(a.metadata.createdAt).localeCompare(String(b.metadata.createdAt)));
	}

	isCompletedTicketCleanupEligible(metadata, { now = new Date() } = {}) {
		if (metadata?.lane !== LANE.COMPLETED) return false;
		const updatedAtMs = Date.parse(metadata.updatedAt || "");
		if (!Number.isFinite(updatedAtMs)) return false;
		const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
		if (!Number.isFinite(nowMs)) return false;
		const retentionMs = COMPLETED_TICKET_CLEANUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		return updatedAtMs < nowMs - retentionMs;
	}

	async uniqueCompletedArchiveDir(id, { now = new Date() } = {}) {
		const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, "-");
		const candidates = [id, `${id}--${stamp}`];
		let suffix = 2;
		while (true) {
			const name = candidates.shift() || `${id}--${stamp}-${suffix++}`;
			const archiveDir = path.join(this.completedTicketArchiveRoot, name);
			try {
				await fsp.access(archiveDir);
			} catch (error) {
				if (error.code === "ENOENT") return archiveDir;
				throw error;
			}
		}
	}

	async cleanCompletedTickets({ now = new Date() } = {}) {
		const cleanupNow = now instanceof Date ? now : new Date(now);
		await this.init();
		const issues = await this.listIssues();
		const eligible = issues.filter((issue) => this.isCompletedTicketCleanupEligible(issue.metadata, { now: cleanupNow }));
		if (!eligible.length) {
			return { cleanedCount: 0, cleanedIds: [], retentionDays: COMPLETED_TICKET_CLEANUP_RETENTION_DAYS };
		}
		await ensureDir(this.completedTicketArchiveRoot);
		const cleanedIds = [];
		const moved = [];
		try {
			for (const issue of eligible) {
				const id = issue.metadata.id;
				const sourceDir = this.issueDir(id);
				const archiveDir = await this.uniqueCompletedArchiveDir(id, { now: cleanupNow });
				await fsp.rename(sourceDir, archiveDir);
				moved.push({ sourceDir, archiveDir });
				cleanedIds.push(id);
			}
		} catch (error) {
			for (const move of moved.reverse()) {
				await fsp.rename(move.archiveDir, move.sourceDir).catch(() => {});
			}
			throw error;
		}
		await Promise.all(moved.map((move, index) => this.removeIssueAgentStreamData(cleanedIds[index], { issueDir: move.archiveDir })));
		this.emitChange({ type: "completed_tickets_cleaned", cleanedIds, cleanedCount: cleanedIds.length, retentionDays: COMPLETED_TICKET_CLEANUP_RETENTION_DAYS });
		return { cleanedCount: cleanedIds.length, cleanedIds, retentionDays: COMPLETED_TICKET_CLEANUP_RETENTION_DAYS };
	}

	async writeMetadata(id, metadata) {
		const normalized = normalizeMetadata(metadata);
		normalized.updatedAt = nowIso();
		await writeJsonAtomic(this.issuePath(id, "metadata.json"), normalized);
		this.emitChange({ type: "metadata_updated", id });
		return normalized;
	}

	async updateMetadata(id, updater) {
		const issue = await this.loadIssue(id);
		const next = typeof updater === "function" ? updater(issue.metadata, issue) : { ...issue.metadata, ...updater };
		return this.writeMetadata(id, next);
	}

	async setLane(id, lane, reason, extra = {}) {
		if (!LANES.includes(lane)) throw new Error(`Unknown lane: ${lane}`);
		const metadata = await this.updateMetadata(id, (current) => ({
			...current,
			...extra,
			lane,
		}));
		await this.appendEvent(id, { type: "lane_changed", lane, reason });
		return metadata;
	}

	async writePlan(id, plan) {
		await writeFileAtomic(this.issuePath(id, "plan.md"), `${String(plan || "").trim()}\n`);
		await this.appendEvent(id, { type: "plan_written" });
		this.emitChange({ type: "plan_written", id });
	}

	async writePlanReport(id, report) {
		await writeFileAtomic(this.issuePath(id, "plan-report.md"), `${String(report || "").trim()}\n`);
		await this.appendEvent(id, { type: "plan_report_written" });
		this.emitChange({ type: "plan_report_written", id });
	}

	async writeReviewReport(id, report) {
		await writeFileAtomic(this.issuePath(id, "review-report.md"), `${String(report || "").trim()}\n`);
		await this.appendEvent(id, { type: "review_report_written" });
		this.emitChange({ type: "review_report_written", id });
	}

	async appendComment(id, { author = "human", phase = "general", text }) {
		if (!text || !String(text).trim()) throw new Error("Comment text is required.");
		const comment = {
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			author,
			phase,
			text: String(text).trim(),
			createdAt: nowIso(),
		};
		await appendJsonLine(this.issuePath(id, "comments.jsonl"), comment);
		await this.appendEvent(id, { type: "comment_added", phase, author });
		this.emitChange({ type: "comment_added", id });
		return comment;
	}

	async appendEvent(id, event) {
		const payload = {
			...event,
			at: nowIso(),
		};
		await appendJsonLine(this.issuePath(id, "events.jsonl"), payload);
		this.emitChange({ type: "event_appended", id, event: payload });
		return payload;
	}

	async appendRunEvent(id, runId, event) {
		const sanitized = sanitizeAgentStreamEvent({
			...event,
			at: nowIso(),
		});
		if (!sanitized) return null;
		const payload = compactDashboardRunEvent(sanitized);
		await appendJsonLine(this.runPath(id, runId), payload);
		this.emitChange({ type: "run_event", id, runId, event: payload });
		return payload;
	}

	async readRunEvents(id, runId) {
		return readJsonLines(this.runPath(id, runId));
	}

	async getAgentSession(id, runId) {
		const events = (await this.readRunEvents(id, runId)).map((event) => sanitizeAgentStreamEvent(event)).filter(Boolean);
		return { issueId: id, runId, events, session: assembleAgentSession(events) };
	}

	async findSessionForRun(id, runId, events = null) {
		const normalizedRunId = String(runId || "").trim();
		if (!normalizedRunId || normalizedRunId === "starting") return { sessionFile: null, sessionAvailable: false };
		const defaultSessionFile = path.join(this.sessionsRoot, id, `${normalizedRunId}.jsonl`);
		try {
			await fsp.access(defaultSessionFile);
			return { sessionFile: defaultSessionFile, sessionAvailable: true };
		} catch {
			// Resumed runs keep writing to their source session file instead of a run-id-derived file.
		}
		const issueEvents = events || await readJsonLines(this.issuePath(id, "events.jsonl"));
		for (let index = issueEvents.length - 1; index >= 0; index -= 1) {
			const event = issueEvents[index];
			const mapped =
				(event?.type === "agent_session_resumed" && String(event.runId || "") === normalizedRunId) ||
				(event?.type === "implementation_resume_started" && String(event.runId || "") === normalizedRunId);
			if (!mapped) continue;
			const sessionFile = String(event.sessionFile || event.resumeSessionFile || "").trim() || null;
			if (!sessionFile) break;
			try {
				await fsp.access(sessionFile);
				return { sessionFile, sessionAvailable: true };
			} catch {
				break;
			}
		}
		return { sessionFile: null, sessionAvailable: false };
	}

	async findRecoveryTarget(issue) {
		const { metadata, events = [] } = issue;
		const checkpoint = metadata.automation?.recovery;
		if (checkpoint) {
			if (checkpoint.mode !== "resume" || !checkpoint.sessionFile) {
				return { role: checkpoint.role, runId: checkpoint.sourceRunId, sessionFile: null, sessionAvailable: false };
			}
			let session = await this.findSessionForRun(metadata.id, checkpoint.sourceRunId, events);
			if (!session.sessionAvailable && checkpoint.sessionFile) {
				try {
					await fsp.access(checkpoint.sessionFile);
					session = { sessionFile: checkpoint.sessionFile, sessionAvailable: true };
				} catch {
					session = { sessionFile: null, sessionAvailable: false };
				}
			}
			return { role: checkpoint.role, runId: checkpoint.sourceRunId, ...session };
		}

		const allowedRoles = metadata.lane === LANE.PLANNING
			? new Set(["planner"])
			: new Set(["worker", "reviewer", "final-reviewer"]);
		let role = metadata.lane === LANE.PLANNING ? "planner" : "worker";
		let runId = null;
		for (const event of events) {
			if (event?.type === "agent_run_started" && allowedRoles.has(event.role)) {
				role = event.role;
				runId = String(event.runId || "").trim() || null;
				continue;
			}
			if (metadata.lane === LANE.PLANNING && event?.type === "planning_finished") {
				role = "planner";
				runId = null;
				continue;
			}
			if (metadata.lane !== LANE.IN_PROGRESS) continue;
			if (event?.type === "implementation_attempt_started" || event?.type === "implementation_resume_attempt_started") {
				role = "worker";
				runId = null;
			} else if (event?.type === "worker_finished") {
				role = "reviewer";
				runId = null;
			} else if (event?.type === "reviewer_finished") {
				role = event.decision === "PASS" ? "final-reviewer" : "worker";
				runId = null;
			} else if (event?.type === "final_reviewer_finished") {
				role = event.decision === "PASS" ? "final-reviewer" : "worker";
				runId = event.decision === "PASS" ? String(event.runId || "").trim() || null : null;
			}
		}
		if (allowedRoles.has(metadata.automation?.activeRole)) {
			role = metadata.automation.activeRole;
			runId = String(metadata.automation.activeRunId || "").trim() || null;
		}
		const session = await this.findSessionForRun(metadata.id, runId, events);
		return { role, runId: runId === "starting" ? null : runId, ...session };
	}

	async findLatestRoleOutput(id, role) {
		const finishType = {
			worker: "worker_finished",
			reviewer: "reviewer_finished",
			"final-reviewer": "final_reviewer_finished",
		}[role];
		if (!finishType) return "";
		const events = await readJsonLines(this.issuePath(id, "events.jsonl"));
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== finishType || !event.runId) continue;
			try {
				const payload = await this.getAgentSession(id, String(event.runId));
				for (let messageIndex = payload.session.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
					const content = String(payload.session.messages[messageIndex]?.content || "").trim();
					if (content) return content;
				}
			} catch {
				return "";
			}
		}
		return "";
	}

	async findLatestResumableWorkerSession(id) {
		const events = await readJsonLines(this.issuePath(id, "events.jsonl"));
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index];
			if (event?.type !== "agent_run_started" || event.role !== "worker" || !event.runId) continue;
			const runId = String(event.runId);
			const sessionFile = path.join(this.sessionsRoot, id, `${runId}.jsonl`);
			try {
				await fsp.access(sessionFile);
				return { canResume: true, runId, sessionFile, reason: "" };
			} catch {
				const resumedSession = await this.findMappedResumeSession(events, index, id, runId);
				if (resumedSession) return resumedSession;
				return {
					canResume: false,
					runId: null,
					sessionFile: null,
					reason: "The last worker session file is unavailable.",
				};
			}
		}
		return {
			canResume: false,
			runId: null,
			sessionFile: null,
			reason: "No worker session is available for this ticket.",
		};
	}

	async findMappedResumeSession(events, workerEventIndex, id, workerRunId) {
		for (let index = workerEventIndex + 1; index < events.length; index += 1) {
			const event = events[index];
			if (event?.type !== "implementation_resume_started" || String(event.runId || "") !== workerRunId) continue;
			const resumeRunId = event.resumeRunId ? String(event.resumeRunId) : null;
			const sessionFile = event.resumeSessionFile
				? String(event.resumeSessionFile)
				: (resumeRunId ? path.join(this.sessionsRoot, id, `${resumeRunId}.jsonl`) : null);
			if (!sessionFile) return null;
			try {
				await fsp.access(sessionFile);
				return { canResume: true, runId: resumeRunId || workerRunId, sessionFile, reason: "" };
			} catch {
				return null;
			}
		}
		return null;
	}

	async appendSystemError(id, error) {
		try {
			await this.appendEvent(id, {
				type: "store_error",
				error: error instanceof Error ? error.message : String(error),
			});
		} catch {
			/* ignore */
		}
	}

	async getBoardState() {
		await this.backfillProjectsFromIssues();
		const issues = await this.listIssues();
		const issuesById = new Map(issues.map((issue) => [issue.metadata.id, issue]));
		const lanes = Object.fromEntries(LANES.map((lane) => [lane, []]));
		for (const issue of issues) {
			const lane = LANES.includes(issue.metadata.lane) ? issue.metadata.lane : LANE.CREATED;
			lanes[lane].push(issue.metadata.id);
		}
		const boardIssues = [];
		for (const issue of issues) {
			const dependencyId = getDependencyIssueId(issue.metadata);
			const dependency = dependencyId ? issuesById.get(dependencyId) : null;
			const hasUnresolvedDependency = !!dependencyId && !issue.metadata.dependencies?.resolvedAt && (!dependency || !isDependencyResolved(dependency.metadata));
			const statusReason = resumeBlockedReason(issue.metadata, { hasUnresolvedDependency });
			const session = statusReason ? { canResume: false, runId: null, sessionFile: null, reason: statusReason } : await this.findLatestResumableWorkerSession(issue.metadata.id);
			const recoveryTarget = [LANE.PLANNING, LANE.IN_PROGRESS].includes(issue.metadata.lane)
				? await this.findRecoveryTarget(issue)
				: null;
			const workspace = recoveryTarget ? await inspectIssueWorkspace(issue.metadata) : { canRecover: true, reason: "" };
			const kickReason = kickIssueReason(issue.metadata, {
				hasUnresolvedDependency,
				workspaceReason: workspace.canRecover ? "" : workspace.reason,
			});
			boardIssues.push({
				...issue.metadata,
				spec: issue.spec,
				plan: issue.plan,
				planReport: issue.planReport,
				reviewReport: issue.reviewReport,
				comments: issue.comments,
				recentEvents: issue.events.slice(-50),
				resume: session,
				kick: {
					visible: [LANE.PLANNING, LANE.IN_PROGRESS].includes(issue.metadata.lane),
					canKick: !kickReason,
					role: recoveryTarget?.role || null,
					sessionAvailable: !!recoveryTarget?.sessionAvailable,
					reason: kickReason,
				},
			});
		}
		const projects = await this.listProjects({ skipBackfill: true });
		const projectCounts = Object.fromEntries(await Promise.all(projects.map(async (project) => [project.id, await this.projectTicketCounts(project.id)])));
		return {
			dataRoot: this.dataRoot,
			lanes,
			issues: boardIssues,
			projects,
			projectCounts,
		};
	}

	startWatcher() {
		if (this.watchHandle || this.pollTimer) return;
		const notify = debounce(() => this.emitChange({ type: "filesystem_changed" }), 200);
		try {
			this.watchHandle = fs.watch(this.issuesRoot, { recursive: true }, notify);
			this.watchHandle.on("error", () => {
				this.stopWatcher();
				this.startPollingWatcher(notify);
			});
		} catch {
			this.startPollingWatcher(notify);
		}
	}

	startPollingWatcher(notify) {
		this.pollTimer = setInterval(async () => {
			try {
				const state = await this.getBoardState();
				const fingerprint = JSON.stringify(state.issues.map((issue) => [issue.id, issue.updatedAt, issue.lane, issue.comments.length]));
				if (fingerprint !== this.lastSnapshotFingerprint) {
					this.lastSnapshotFingerprint = fingerprint;
					notify();
				}
			} catch {
				/* ignore polling errors */
			}
		}, 2000);
	}

	stopWatcher() {
		if (this.watchHandle) {
			this.watchHandle.close();
			this.watchHandle = null;
		}
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}
}
