import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_DATA_ROOT, DEFAULT_PROFILE_ID, LANE, LANES } from "./constants.js";
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
import {
	createApprovalState,
	createAutomationState,
	isDependencyResolved,
	normalizeAgentSettings,
	normalizeMetadata,
} from "./workflow.js";

export class IssueStore {
	constructor(options = {}) {
		this.dataRoot = options.dataRoot || DEFAULT_DATA_ROOT;
		this.issuesRoot = path.join(this.dataRoot, "issues");
		this.worktreesRoot = path.join(this.dataRoot, "worktrees");
		this.sessionsRoot = path.join(this.dataRoot, "sessions");
		this.profilesPath = path.join(this.dataRoot, "profiles.json");
		this.listeners = new Set();
		this.watchHandle = null;
		this.pollTimer = null;
		this.lastSnapshotFingerprint = "";
	}

	async init() {
		await ensureDir(this.issuesRoot);
		await ensureDir(this.worktreesRoot);
		await ensureDir(this.sessionsRoot);
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
		return path.join(this.issueDir(id), "runs", `${runId}.jsonl`);
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

	async createIssue({ title, spec, linkedDirectory, agentSettings, dependencyIssueId, backlog = false }) {
		if (!title || !String(title).trim()) throw new Error("Title is required.");
		if (!linkedDirectory || !String(linkedDirectory).trim()) throw new Error("Linked directory is required.");
		const linkedPath = normalizePath(linkedDirectory);
		const id = makeId(title);
		const { dependencyId, dependency } = await this.validateDependency(dependencyIssueId);
		const initialLane = backlog ? LANE.BACKLOG : LANE.CREATED;
		const createdAt = nowIso();
		const metadata = normalizeMetadata({
			id,
			title: String(title).trim(),
			lane: initialLane,
			linkedDirectory: linkedPath,
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

	async updateBacklogIssue(id, { title, spec, linkedDirectory, agentSettings, dependencyIssueId } = {}) {
		const issue = await this.loadIssue(id);
		if (issue.metadata.lane !== LANE.BACKLOG) throw new Error("Only Backlog issues can be edited this way.");
		if (!title || !String(title).trim()) throw new Error("Title is required.");
		if (!linkedDirectory || !String(linkedDirectory).trim()) throw new Error("Linked directory is required.");
		const linkedPath = normalizePath(linkedDirectory);
		const { dependencyId, dependency } = await this.validateDependency(dependencyIssueId, { selfId: id });
		const metadata = await this.writeMetadata(id, {
			...issue.metadata,
			title: String(title).trim(),
			linkedDirectory: linkedPath,
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
		return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
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
		const payload = {
			...event,
			at: nowIso(),
		};
		await appendJsonLine(this.runPath(id, runId), payload);
		this.emitChange({ type: "run_event", id, runId, event: payload });
		return payload;
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
		const issues = await this.listIssues();
		const lanes = Object.fromEntries(LANES.map((lane) => [lane, []]));
		for (const issue of issues) {
			const lane = LANES.includes(issue.metadata.lane) ? issue.metadata.lane : LANE.CREATED;
			lanes[lane].push(issue.metadata.id);
		}
		return {
			dataRoot: this.dataRoot,
			lanes,
			issues: issues.map((issue) => ({
				...issue.metadata,
				spec: issue.spec,
				plan: issue.plan,
				planReport: issue.planReport,
				reviewReport: issue.reviewReport,
				comments: issue.comments,
				recentEvents: issue.events.slice(-50),
			})),
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
