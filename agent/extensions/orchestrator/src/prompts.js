export function formatComments(comments, phase = null) {
	const filtered = phase ? comments.filter((comment) => comment.phase === phase || comment.phase === "general") : comments;
	if (filtered.length === 0) return "(none)";
	return filtered
		.map((comment) => `- ${comment.createdAt} ${comment.author} [${comment.phase}]: ${comment.text}`)
		.join("\n");
}

export function workspaceSummary(metadata) {
	const lines = [
		`Issue ID: ${metadata.id}`,
		`Title: ${metadata.title}`,
		`Linked directory: ${metadata.linkedDirectory}`,
		`Workspace: ${metadata.workspace?.path || "(not prepared)"}`,
		`Workspace kind: ${metadata.workspace?.kind || "(unknown)"}`,
	];
	if (metadata.git) {
		lines.push(`Git repo: ${metadata.git.repoRoot}`);
		lines.push(`Base branch: ${metadata.git.baseBranch}`);
		lines.push(`Base SHA: ${metadata.git.baseSha}`);
		lines.push(`Issue branch: ${metadata.git.branchName}`);
		lines.push(`Worktree: ${metadata.git.worktreePath}`);
	}
	if (metadata.dependencies?.issueId) {
		lines.push(`Depends on issue: ${metadata.dependencies.issueId}`);
		lines.push(`Dependency resolved at: ${metadata.dependencies.resolvedAt || "(unresolved)"}`);
	}
	if (metadata.workspace?.warning) lines.push(`Warning: ${metadata.workspace.warning}`);
	return lines.join("\n");
}

export const PLAN_START = "BEGIN_IMPLEMENTATION_PLAN";
export const PLAN_END = "END_IMPLEMENTATION_PLAN";
export const PLAN_REPORT_START = "BEGIN_PLAN_REVIEW_REPORT";
export const PLAN_REPORT_END = "END_PLAN_REVIEW_REPORT";
export const REVIEW_REPORT_START = "BEGIN_REVIEW_REPORT";
export const REVIEW_REPORT_END = "END_REVIEW_REPORT";

export function parseMergerOutput(text) {
	const source = String(text || "").trim();
	const match = source.match(/^\s*MERGE_RESULT:\s*([A-Z_ -]+)/im);
	const value = match ? match[1].trim().replace(/[\s-]+/g, "_") : "BLOCKED";
	return {
		result: value === "MERGED" ? "MERGED" : "BLOCKED",
		summary: source,
	};
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractDelimitedBlock(text, start, end) {
	const source = String(text || "");
	const pattern = new RegExp(`^\\s*${escapeRegExp(start)}\\s*$([\\s\\S]*?)^\\s*${escapeRegExp(end)}\\s*$`, "m");
	const match = source.match(pattern);
	if (!match) return { found: false, content: "" };
	return { found: true, content: match[1].trim() };
}

export function parsePlannerOutput(text) {
	const source = String(text || "").trim();
	const plan = extractDelimitedBlock(source, PLAN_START, PLAN_END);
	const report = extractDelimitedBlock(source, PLAN_REPORT_START, PLAN_REPORT_END);
	return {
		plan: (plan.found ? plan.content : source).trim(),
		report: (report.found ? report.content : source).trim(),
	};
}

export function parseFinalReviewerOutput(text) {
	const source = String(text || "").trim();
	const report = extractDelimitedBlock(source, REVIEW_REPORT_START, REVIEW_REPORT_END);
	return {
		report: (report.found ? report.content : source).trim(),
	};
}

export function buildSpecWriterPrompt({ spec, suggestions } = {}) {
	const currentSpec = String(spec || "").trim();
	const humanSuggestions = String(suggestions || "").trim();
	return [
		"You are the spec writer for a local Pi orchestrator issue.",
		"Rewrite the user's draft into a strong implementation spec that another agent can plan and work from.",
		"Preserve the user's intent. Add clarity, acceptance criteria, constraints, edge cases, and test expectations when they can be inferred.",
		"Do not invent project facts. If important context is missing, phrase assumptions explicitly inside the spec instead of asking questions.",
		"Return only the improved spec text. Do not include commentary, preambles, code fences, or labels.",
		"",
		"Current spec draft:",
		currentSpec || "(empty spec)",
		"",
		"Human suggestions for this rewrite:",
		humanSuggestions || "(none)",
		"",
		"Output the improved spec only.",
	].join("\n");
}

export function buildPlannerPrompt(issue) {
	return [
		"You are the planning agent for a local Pi orchestrator issue.",
		"Do not modify files. Read the linked directory as needed and produce an implementation plan plus a human review report.",
		"Ask no interactive questions. If something is ambiguous, document the assumption in the plan.",
		"The implementation plan is consumed by a worker agent. The review report is read by a human approving the plan.",
		"",
		"Return exactly this structure:",
		PLAN_START,
		"Concise Markdown plan with sections: Goal, Implementation Steps, Tests, Risks.",
		PLAN_END,
		PLAN_REPORT_START,
		"Polished Markdown report for the human reviewer. Include a short executive summary, review checklist, important assumptions, risk notes, and the approval decision needed.",
		PLAN_REPORT_END,
		"",
		"Workspace metadata:",
		workspaceSummary(issue.metadata),
		"",
		"Issue spec:",
		issue.spec.trim() || "(empty spec)",
		"",
		"Human feedback comments:",
		formatComments(issue.comments, "plan"),
	].join("\n");
}

export function buildWorkerPrompt(issue, feedback) {
	return [
		"You are the worker agent for a local Pi orchestrator issue.",
		"Implement the approved plan in the workspace. Add or update focused unit tests for code you change.",
		"Do not move the ticket lanes yourself. Do not commit, merge, or push.",
		"",
		"Workspace metadata:",
		workspaceSummary(issue.metadata),
		"",
		"Issue spec:",
		issue.spec.trim() || "(empty spec)",
		"",
		"Approved plan:",
		issue.plan.trim() || "(no approved plan found)",
		"",
		"Human feedback comments:",
		formatComments(issue.comments, "review"),
		"",
		"Automated reviewer feedback to address:",
		feedback || "(none)",
		"",
		"Finish with a summary of files changed, tests added or run, and any remaining concerns.",
	].join("\n");
}

export function buildReviewerPrompt(issue, workerOutput) {
	return [
		"You are the code reviewer in a local Pi orchestrator worker-reviewer loop.",
		"Use read-only inspection. Do not modify files.",
		"Review whether the worker's changes satisfy the approved plan and whether tests are adequate.",
		"",
		"Your first non-empty line must be exactly one of:",
		"DECISION: PASS",
		"DECISION: CHANGES_REQUESTED",
		"",
		"Workspace metadata:",
		workspaceSummary(issue.metadata),
		"",
		"Issue spec:",
		issue.spec.trim() || "(empty spec)",
		"",
		"Approved plan:",
		issue.plan.trim() || "(no approved plan found)",
		"",
		"Latest worker output:",
		workerOutput || "(none)",
		"",
		"If changes are needed, list concrete file-level feedback. If the work passes, keep the review concise.",
	].join("\n");
}

export function buildFinalReviewerPrompt(issue, priorOutput) {
	return [
		"You are the final reviewer for a local Pi orchestrator issue.",
		"Use read-only inspection. Do not modify files.",
		"Decide whether the completed work fulfills the issue spec and approved plan well enough for human review.",
		"If the decision is PASS, also write a polished human review report after the decision line.",
		"",
		"Your first non-empty line must be exactly one of:",
		"DECISION: PASS",
		"DECISION: CHANGES_REQUESTED",
		"",
		"When passing, use this exact report structure after the decision line:",
		REVIEW_REPORT_START,
		"Polished Markdown report for the human reviewer. Include summary, what changed, verification performed, residual risks, and the approval decision needed.",
		REVIEW_REPORT_END,
		"",
		"Workspace metadata:",
		workspaceSummary(issue.metadata),
		"",
		"Issue spec:",
		issue.spec.trim() || "(empty spec)",
		"",
		"Approved plan:",
		issue.plan.trim() || "(no approved plan found)",
		"",
		"Human feedback comments:",
		formatComments(issue.comments),
		"",
		"Latest worker/reviewer loop output:",
		priorOutput || "(none)",
	].join("\n");
}

export function buildMergerPrompt(issue) {
	const events = (issue.events || [])
		.slice(-20)
		.map((event) => `- ${event.at} ${event.type}: ${JSON.stringify(event)}`)
		.join("\n");
	return [
		"You are the merger agent for a local Pi orchestrator issue.",
		"The user selected Approve and merge. Integrate the reviewed worktree branch into the base branch recorded below.",
		"Do not push. Do not delete branches or worktrees. Keep any edits limited to resolving merge conflicts created by this merge.",
		"",
		"Required merge workflow:",
		"1. Inspect the issue worktree and base repository status before changing anything.",
		"2. If the issue worktree has uncommitted changes, stage and commit them on the issue branch with a concise issue-specific message.",
		"3. Switch the base repository to the recorded base branch if needed, and ensure its working tree is clean before merging.",
		"4. Pull the base branch with --ff-only when it has a configured upstream. If no upstream exists, continue with the local base branch and note that.",
		"5. Merge the issue branch into the recorded base branch. Resolve conflicts carefully if they occur.",
		"6. Run the most relevant available verification command if it is obvious and reasonably scoped.",
		"",
		"Your first non-empty line must be exactly one of:",
		"MERGE_RESULT: MERGED",
		"MERGE_RESULT: BLOCKED",
		"",
		"Use MERGED only after the issue branch is integrated into the base branch. Use BLOCKED if the merge cannot be completed safely.",
		"After that line, include a concise Markdown summary with commits merged, verification run, and any follow-up needed.",
		"",
		"Workspace metadata:",
		workspaceSummary(issue.metadata),
		"",
		"Issue spec:",
		issue.spec.trim() || "(empty spec)",
		"",
		"Approved plan:",
		issue.plan.trim() || "(no approved plan found)",
		"",
		"Human review report:",
		issue.reviewReport.trim() || "(no review report found)",
		"",
		"Human comments:",
		formatComments(issue.comments),
		"",
		"Recent orchestrator events:",
		events || "(none)",
	].join("\n");
}
