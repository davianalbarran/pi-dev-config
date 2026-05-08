import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { LANE } from "./constants.js";
import { ensureDir, isDirectorySync, pathExists, sanitizeForBranch } from "./utils.js";

const execFileAsync = promisify(execFile);

export async function execGit(args, cwd, options = {}) {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 10 * 1024 * 1024,
			...options,
		});
		return {
			code: 0,
			stdout: String(result.stdout || ""),
			stderr: String(result.stderr || ""),
		};
	} catch (error) {
		if (typeof error?.code === "number" && options.allowExitCodes?.includes(error.code)) {
			return {
				code: error.code,
				stdout: String(error.stdout || ""),
				stderr: String(error.stderr || ""),
			};
		}
		const message = String(error?.stderr || error?.message || error);
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${message.trim()}`);
	}
}

export function branchNameForIssue(issueId, title) {
	const slug = sanitizeForBranch(`${issueId}-${title}`).slice(0, 96);
	return `pi-orchestrator/${slug}`;
}

export async function getGitRepositoryInfo(linkedDirectory) {
	const root = (await execGit(["-C", linkedDirectory, "rev-parse", "--show-toplevel"], linkedDirectory)).stdout.trim();
	const branchResult = await execGit(["-C", root, "branch", "--show-current"], root);
	let baseBranch = branchResult.stdout.trim();
	if (!baseBranch) {
		baseBranch = (await execGit(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
	}
	const baseSha = (await execGit(["-C", root, "rev-parse", "HEAD"], root)).stdout.trim();
	return { repoRoot: root, baseBranch, baseSha };
}

export async function detectWorkspace(linkedDirectory) {
	if (!isDirectorySync(linkedDirectory)) {
		throw new Error(`Linked directory does not exist or is not a directory: ${linkedDirectory}`);
	}
	try {
		const git = await getGitRepositoryInfo(linkedDirectory);
		return { kind: "git", git };
	} catch {
		return { kind: "directory" };
	}
}

export async function ensureIssueWorkspace(store, issue) {
	const metadata = issue.metadata;
	if (metadata.workspace?.path) return metadata.workspace;

	const detected = await detectWorkspace(metadata.linkedDirectory);
	if (detected.kind === "directory") {
		const workspace = {
			kind: "directory",
			path: metadata.linkedDirectory,
			editInPlace: true,
			warning: "Non-git linked directory; agents edit this directory in place.",
		};
		await store.updateMetadata(metadata.id, (current) => ({
			...current,
			workspace,
			git: null,
		}));
		await store.appendEvent(metadata.id, { type: "workspace_ready", workspace });
		return workspace;
	}

	const branchName = metadata.git?.branchName || branchNameForIssue(metadata.id, metadata.title);
	const worktreePath = metadata.git?.worktreePath || path.join(store.worktreesRoot, metadata.id);
	const git = {
		repoRoot: detected.git.repoRoot,
		baseBranch: detected.git.baseBranch,
		baseSha: detected.git.baseSha,
		branchName,
		worktreePath,
		finalCommitSha: metadata.git?.finalCommitSha || null,
	};

	await ensureDir(store.worktreesRoot);
	if (!(await pathExists(worktreePath))) {
		const ref = `refs/heads/${branchName}`;
		const branchCheck = await execGit(["-C", git.repoRoot, "show-ref", "--verify", "--quiet", ref], git.repoRoot, {
			allowExitCodes: [0, 1],
		});
		if (branchCheck.code === 0) {
			await execGit(["-C", git.repoRoot, "worktree", "add", worktreePath, branchName], git.repoRoot);
		} else {
			await execGit(["-C", git.repoRoot, "worktree", "add", "-b", branchName, worktreePath, git.baseSha], git.repoRoot);
		}
	}

	const workspace = {
		kind: "git-worktree",
		path: worktreePath,
		editInPlace: false,
	};
	await store.updateMetadata(metadata.id, (current) => ({
		...current,
		workspace,
		git,
	}));
	await store.appendEvent(metadata.id, { type: "workspace_ready", workspace, git });
	return workspace;
}

export async function commitIssueWorktree(store, id) {
	const issue = await store.loadIssue(id);
	const metadata = issue.metadata;
	if (!metadata.git || !metadata.git.worktreePath) {
		return { kind: "non-git", commitSha: null };
	}
	if (metadata.lane !== LANE.IN_REVIEW) {
		throw new Error("Git completion commits are only allowed from In Review.");
	}
	const cwd = metadata.git.worktreePath;
	await execGit(["add", "-A"], cwd);
	const diff = await execGit(["diff", "--cached", "--quiet"], cwd, { allowExitCodes: [0, 1] });
	if (diff.code === 0) {
		throw new Error("No staged changes to commit in the issue worktree.");
	}
	const subject = `chore(orchestrator): complete ${metadata.title}`.slice(0, 180);
	await execGit(["commit", "-m", subject], cwd);
	const commitSha = (await execGit(["rev-parse", "HEAD"], cwd)).stdout.trim();
	await store.updateMetadata(id, (current) => ({
		...current,
		git: {
			...current.git,
			finalCommitSha: commitSha,
		},
	}));
	await store.appendEvent(id, { type: "completion_commit_created", commitSha });
	return { kind: "git", commitSha };
}
