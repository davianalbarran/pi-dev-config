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

export async function getGitBranches(projectPath) {
	const root = (await execGit(["-C", projectPath, "rev-parse", "--show-toplevel"], projectPath)).stdout.trim();
	const result = await execGit(["-C", root, "for-each-ref", "--format=%(refname:short)", "refs/heads"], root);
	return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function getGitProjectInfo(projectPath) {
	let root = "";
	try {
		root = (await execGit(["-C", projectPath, "rev-parse", "--show-toplevel"], projectPath)).stdout.trim();
	} catch (error) {
		return {
			isGitRepository: false,
			repoRoot: null,
			currentBranch: "",
			defaultBranch: "",
			branches: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
	let currentBranch = "";
	try {
		currentBranch = (await execGit(["-C", root, "branch", "--show-current"], root)).stdout.trim();
		const branches = await getGitBranches(root);
		let defaultBranch = currentBranch || branches[0] || "";
		try {
			const originHead = (await execGit(["-C", root, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], root)).stdout.trim();
			if (originHead) defaultBranch = originHead.replace(/^origin\//, "");
		} catch {
			// A repository may not have an origin/HEAD; current or first local branch is the safe fallback.
		}
		return {
			isGitRepository: true,
			repoRoot: root,
			currentBranch,
			defaultBranch,
			branches,
			error: branches.length ? null : "No local git branches were detected.",
		};
	} catch (error) {
		return {
			isGitRepository: true,
			repoRoot: root,
			currentBranch,
			defaultBranch: currentBranch,
			branches: [],
			error: `Git branch listing failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export async function getGitRepositoryInfo(linkedDirectory, { baseRef = null } = {}) {
	const root = (await execGit(["-C", linkedDirectory, "rev-parse", "--show-toplevel"], linkedDirectory)).stdout.trim();
	const branchResult = await execGit(["-C", root, "branch", "--show-current"], root);
	let baseBranch = String(baseRef || "").trim() || branchResult.stdout.trim();
	if (!baseBranch) {
		baseBranch = (await execGit(["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
	}
	const baseSha = (await execGit(["-C", root, "rev-parse", `${baseBranch}^{commit}`], root)).stdout.trim();
	return { repoRoot: root, baseBranch, baseSha };
}

export async function validateBranchName(repoRoot, branchName) {
	const name = String(branchName || "").trim();
	if (!name) return { valid: false, error: "Branch name is required." };
	const result = await execGit(["-C", repoRoot, "check-ref-format", "--branch", name], repoRoot, { allowExitCodes: [0, 1, 128] });
	return result.code === 0 ? { valid: true, error: "" } : { valid: false, error: `Invalid branch name: ${name}` };
}

export async function branchExists(repoRoot, branchName) {
	const result = await execGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repoRoot, { allowExitCodes: [0, 1] });
	return result.code === 0;
}

export async function createBranchWithoutCheckout(repoRoot, branchName, baseRef) {
	const validation = await validateBranchName(repoRoot, branchName);
	if (!validation.valid) throw new Error(validation.error);
	if (await branchExists(repoRoot, branchName)) throw new Error(`Branch already exists: ${branchName}`);
	await execGit(["-C", repoRoot, "branch", branchName, baseRef], repoRoot);
}

export async function detectWorkspace(linkedDirectory, { baseRef = null } = {}) {
	if (!isDirectorySync(linkedDirectory)) {
		throw new Error(`Linked directory does not exist or is not a directory: ${linkedDirectory}`);
	}
	const repoCheck = await execGit(["-C", linkedDirectory, "rev-parse", "--show-toplevel"], linkedDirectory, { allowExitCodes: [0, 1, 128] });
	if (repoCheck.code !== 0) return { kind: "directory" };
	const git = await getGitRepositoryInfo(linkedDirectory, { baseRef });
	return { kind: "git", git };
}

export async function ensureIssueWorkspace(store, issue) {
	const metadata = issue.metadata;
	if (metadata.workspace?.path) return metadata.workspace;

	const gitRequest = metadata.gitRequest || metadata.git?.request || null;
	const requestedBaseBranch = String(gitRequest?.baseBranch || "").trim() || null;
	const detected = await detectWorkspace(metadata.linkedDirectory, { baseRef: requestedBaseBranch });
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

	const isNewBranchMode = gitRequest?.mode === "new";
	const requestedNewBranch = String(gitRequest?.newBranchName || "").trim();
	const mergeTargetBranch = isNewBranchMode ? requestedNewBranch : detected.git.baseBranch;
	const branchName = metadata.git?.branchName || branchNameForIssue(metadata.id, metadata.title);
	if (isNewBranchMode && !requestedNewBranch) throw new Error("New branch name is required.");
	if (!branchName) throw new Error("New branch name is required.");
	const worktreePath = metadata.git?.worktreePath || path.join(store.worktreesRoot, metadata.id);
	const git = {
		repoRoot: detected.git.repoRoot,
		baseBranch: mergeTargetBranch,
		baseSha: detected.git.baseSha,
		branchName,
		worktreePath,
		finalCommitSha: metadata.git?.finalCommitSha || null,
		request: gitRequest || { mode: "existing", baseBranch: detected.git.baseBranch },
	};

	await ensureDir(store.worktreesRoot);
	if (!(await pathExists(worktreePath))) {
		if (isNewBranchMode) {
			const worktreeBranchValidation = await validateBranchName(git.repoRoot, branchName);
			if (!worktreeBranchValidation.valid) throw new Error(worktreeBranchValidation.error);
			if (mergeTargetBranch === branchName) throw new Error(`New branch name conflicts with generated worktree branch: ${branchName}`);
			if (await branchExists(git.repoRoot, branchName)) throw new Error(`Branch already exists: ${branchName}`);
			await createBranchWithoutCheckout(git.repoRoot, mergeTargetBranch, git.baseSha);
			await execGit(["-C", git.repoRoot, "worktree", "add", "-b", branchName, worktreePath, mergeTargetBranch], git.repoRoot);
		} else if (await branchExists(git.repoRoot, branchName)) {
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
