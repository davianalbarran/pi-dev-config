import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 256 * 1024;
const MAX_GIT_BUFFER_BYTES = 24 * 1024 * 1024;

function emptyPayload(issue, reason, extra = {}) {
	const metadata = issue?.metadata || issue || {};
	return {
		issueId: metadata.id || null,
		available: false,
		reason,
		baseSha: metadata.git?.baseSha || null,
		generatedAt: new Date().toISOString(),
		files: [],
		...extra,
	};
}

async function git(args, cwd, options = {}) {
	try {
		const result = await execFileAsync("git", args, {
			cwd,
			maxBuffer: options.maxBuffer || MAX_GIT_BUFFER_BYTES,
		});
		return { code: 0, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
	} catch (error) {
		if (typeof error?.code === "number" && options.allowExitCodes?.includes(error.code)) {
			return {
				code: error.code,
				stdout: String(error.stdout || ""),
				stderr: String(error.stderr || ""),
			};
		}
		throw error;
	}
}

function splitNul(value) {
	const parts = String(value || "").split("\0");
	if (parts.at(-1) === "") parts.pop();
	return parts;
}

function normalizeStatus(token) {
	const code = String(token || "").charAt(0);
	return {
		A: "added",
		C: "copied",
		D: "deleted",
		M: "modified",
		R: "renamed",
		T: "typechange",
		U: "unmerged",
	}[code] || "modified";
}

function parseNameStatusZ(output) {
	const parts = splitNul(output);
	const entries = [];
	for (let index = 0; index < parts.length; ) {
		const token = parts[index++];
		if (!token) continue;
		const statusCode = token.charAt(0);
		if (statusCode === "R" || statusCode === "C") {
			const oldPath = parts[index++];
			const filePath = parts[index++];
			if (filePath) entries.push({ path: filePath, oldPath, status: normalizeStatus(token), statusCode: token });
		} else {
			const filePath = parts[index++];
			if (filePath) entries.push({ path: filePath, oldPath: null, status: normalizeStatus(token), statusCode: token });
		}
	}
	return entries;
}

function parseNumstatZ(output) {
	const parts = splitNul(output);
	const stats = new Map();
	for (let index = 0; index < parts.length; ) {
		const record = parts[index++];
		if (!record) continue;
		const fields = record.split("\t");
		const rawAdditions = fields[0] || "0";
		const rawDeletions = fields[1] || "0";
		let filePath = fields.slice(2).join("\t");
		let oldPath = null;
		if (!filePath) {
			oldPath = parts[index++] || null;
			filePath = parts[index++] || "";
		}
		if (!filePath) continue;
		const binary = rawAdditions === "-" || rawDeletions === "-";
		stats.set(filePath, {
			path: filePath,
			oldPath,
			additions: binary ? 0 : Number.parseInt(rawAdditions, 10) || 0,
			deletions: binary ? 0 : Number.parseInt(rawDeletions, 10) || 0,
			binary,
		});
	}
	return stats;
}

function parseSingleNumstat(output, filePath) {
	const line = String(output || "").split(/\r?\n/).find(Boolean);
	if (!line) return { additions: 0, deletions: 0, binary: false };
	const [rawAdditions = "0", rawDeletions = "0"] = line.split("\t");
	const binary = rawAdditions === "-" || rawDeletions === "-";
	return {
		path: filePath,
		additions: binary ? 0 : Number.parseInt(rawAdditions, 10) || 0,
		deletions: binary ? 0 : Number.parseInt(rawDeletions, 10) || 0,
		binary,
	};
}

function capPatch(patch) {
	const text = String(patch || "");
	if (Buffer.byteLength(text, "utf8") <= MAX_PATCH_BYTES) return { patch: text, truncated: false };
	const truncated = Buffer.from(text, "utf8").subarray(0, MAX_PATCH_BYTES).toString("utf8");
	return {
		patch: `${truncated}\n… diff truncated after ${MAX_PATCH_BYTES} bytes …\n`,
		truncated: true,
	};
}

async function trackedPatch(cwd, baseSha, entry) {
	const pathspecs = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
	try {
		const result = await git(["diff", "--find-renames", "--no-ext-diff", baseSha, "--", ...pathspecs], cwd, {
			maxBuffer: MAX_PATCH_BYTES + 64 * 1024,
		});
		return capPatch(result.stdout);
	} catch (error) {
		if (error?.stdout) {
			const capped = capPatch(String(error.stdout));
			return { ...capped, truncated: true };
		}
		throw error;
	}
}

async function untrackedPatch(cwd, filePath) {
	try {
		const result = await git(["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", filePath], cwd, {
			allowExitCodes: [0, 1],
			maxBuffer: MAX_PATCH_BYTES + 64 * 1024,
		});
		return capPatch(result.stdout);
	} catch (error) {
		if (error?.stdout) {
			const capped = capPatch(String(error.stdout));
			return { ...capped, truncated: true };
		}
		throw error;
	}
}

export async function getIssueDiffs(issue) {
	const metadata = issue?.metadata || issue || {};
	const workspace = metadata.workspace || {};
	const gitMetadata = metadata.git || null;
	const isGitBacked = !!gitMetadata || workspace.kind === "git-worktree";
	if (!isGitBacked) return emptyPayload(issue, "not_git_backed");
	if (!gitMetadata?.baseSha) return emptyPayload(issue, "missing_base_sha");
	if (!workspace.path) return emptyPayload(issue, "missing_workspace_path");

	const cwd = workspace.path;
	const baseSha = gitMetadata.baseSha;
	const payload = {
		issueId: metadata.id || null,
		available: true,
		reason: null,
		baseSha,
		generatedAt: new Date().toISOString(),
		files: [],
	};

	try {
		await git(["rev-parse", "--is-inside-work-tree"], cwd);
		const [nameStatusResult, numstatResult, untrackedResult] = await Promise.all([
			git(["diff", "--find-renames", "--name-status", "-z", baseSha, "--"], cwd),
			git(["diff", "--find-renames", "--numstat", "-z", baseSha, "--"], cwd),
			git(["ls-files", "--others", "--exclude-standard", "-z"], cwd),
		]);
		const stats = parseNumstatZ(numstatResult.stdout);
		for (const entry of parseNameStatusZ(nameStatusResult.stdout)) {
			const stat = stats.get(entry.path) || {};
			const patch = await trackedPatch(cwd, baseSha, entry);
			payload.files.push({
				path: entry.path,
				oldPath: entry.oldPath || stat.oldPath || null,
				status: entry.status,
				additions: stat.additions || 0,
				deletions: stat.deletions || 0,
				binary: !!stat.binary,
				patch: patch.patch,
				...(patch.truncated ? { truncated: true } : {}),
			});
		}

		for (const filePath of splitNul(untrackedResult.stdout)) {
			const statResult = await git(["diff", "--no-index", "--numstat", "--", "/dev/null", filePath], cwd, {
				allowExitCodes: [0, 1],
			});
			const stat = parseSingleNumstat(statResult.stdout, filePath);
			const patch = await untrackedPatch(cwd, filePath);
			payload.files.push({
				path: filePath,
				oldPath: null,
				status: "untracked",
				additions: stat.additions,
				deletions: stat.deletions,
				binary: stat.binary,
				patch: patch.patch,
				...(patch.truncated ? { truncated: true } : {}),
			});
		}
	} catch (error) {
		return {
			...payload,
			available: false,
			reason: `git_error: ${error instanceof Error ? error.message : String(error)}`,
			files: [],
		};
	}

	return payload;
}
