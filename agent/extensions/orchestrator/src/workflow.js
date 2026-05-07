import {
	ISSUE_AGENT_ROLES,
	LANE,
	LANES,
	MAX_PLANNING_ATTEMPTS,
	ROLE_DEFAULTS,
	THINKING_LEVELS,
} from "./constants.js";
import { nowIso } from "./utils.js";

export function isValidLane(lane) {
	return LANES.includes(lane);
}

export function createAutomationState() {
	return {
		planningAttempts: 0,
		implementationAttempts: 0,
		paused: false,
		error: null,
		activeRunId: null,
		activeRole: null,
	};
}

export function createApprovalState() {
	return {
		planApprovedAt: null,
		reviewApprovedAt: null,
	};
}

export function normalizeAgentSettings(settings = {}) {
	const normalized = {};
	for (const role of ISSUE_AGENT_ROLES) {
		const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.worker;
		const value = settings?.[role] || {};
		const model = String(value.model || "").trim() || defaults.model;
		const thinking = String(value.thinking || value.thinkingLevel || "").trim().toLowerCase();
		normalized[role] = {
			model,
			thinking: THINKING_LEVELS.includes(thinking) ? thinking : defaults.thinking,
		};
	}
	return normalized;
}

export function normalizeMetadata(metadata) {
	const normalized = { ...metadata };
	if (!isValidLane(normalized.lane)) normalized.lane = LANE.CREATED;
	normalized.automation = {
		...createAutomationState(),
		...(normalized.automation || {}),
	};
	normalized.approvals = {
		...createApprovalState(),
		...(normalized.approvals || {}),
	};
	const dependencyIssueId = String(normalized.dependencies?.issueId || "").trim() || null;
	normalized.dependencies = {
		issueId: dependencyIssueId,
		resolvedAt: normalized.dependencies?.resolvedAt || null,
	};
	normalized.git = normalized.git || null;
	normalized.workspace = normalized.workspace || null;
	normalized.agentSettings = normalizeAgentSettings(normalized.agentSettings);
	normalized.updatedAt = normalized.updatedAt || normalized.createdAt || nowIso();
	return normalized;
}

export function getDependencyIssueId(metadata) {
	return String(metadata?.dependencies?.issueId || "").trim() || null;
}

export function isDependencyResolved(metadata) {
	if (metadata?.lane !== LANE.COMPLETED) return false;
	const isGitBacked = !!metadata.git || metadata.workspace?.kind === "git-worktree";
	if (!isGitBacked) return true;
	return !!(metadata.git?.mergedAt || metadata.git?.mergeCommitSha);
}

export function dependencyLabel(metadata) {
	const id = getDependencyIssueId(metadata);
	if (!id) return "no dependency";
	return `dependency ${id}`;
}

export function canRequestPlanChanges(metadata) {
	return metadata.lane === LANE.PLAN_REVIEW;
}

export function canApprovePlan(metadata) {
	return metadata.lane === LANE.PLAN_REVIEW && !metadata.automation?.activeRunId;
}

export function canRequestReviewChanges(metadata) {
	return metadata.lane === LANE.IN_REVIEW && !(metadata.automation?.activeRunId && !metadata.automation?.paused);
}

export function canApproveReview(metadata) {
	return metadata.lane === LANE.IN_REVIEW && !metadata.automation?.activeRunId;
}

export function approvePlan(metadata, at = nowIso()) {
	if (!canApprovePlan(metadata)) {
		throw new Error("Plan can only be approved from Plan in review when no run is active.");
	}
	return normalizeMetadata({
		...metadata,
		lane: LANE.IN_PROGRESS,
		updatedAt: at,
		automation: {
			...metadata.automation,
			paused: false,
			error: null,
		},
		approvals: {
			...metadata.approvals,
			planApprovedAt: at,
		},
	});
}

export function requestPlanChanges(metadata, at = nowIso()) {
	if (!canRequestPlanChanges(metadata)) {
		throw new Error("Plan changes can only be requested from Plan in review.");
	}
	const attempts = metadata.automation?.planningAttempts || 0;
	const exhausted = attempts >= MAX_PLANNING_ATTEMPTS;
	return normalizeMetadata({
		...metadata,
		lane: exhausted ? LANE.PLAN_REVIEW : LANE.PLANNING,
		updatedAt: at,
		automation: {
			...metadata.automation,
			paused: exhausted,
			error: exhausted ? `Planning loop limit reached after ${MAX_PLANNING_ATTEMPTS} attempts.` : null,
		},
		approvals: {
			...metadata.approvals,
			planApprovedAt: null,
		},
	});
}

export function requestReviewChanges(metadata, at = nowIso()) {
	if (!canRequestReviewChanges(metadata)) {
		throw new Error("Review changes can only be requested from In Review when no run is active.");
	}
	return normalizeMetadata({
		...metadata,
		lane: LANE.IN_PROGRESS,
		updatedAt: at,
		automation: {
			...metadata.automation,
			implementationAttempts: 0,
			paused: false,
			error: null,
			activeRunId: null,
			activeRole: null,
		},
		approvals: {
			...metadata.approvals,
			reviewApprovedAt: null,
		},
	});
}

export function approveReview(metadata, at = nowIso()) {
	if (!canApproveReview(metadata)) {
		throw new Error("Review can only be approved from In Review when no run is active.");
	}
	return normalizeMetadata({
		...metadata,
		lane: LANE.COMPLETED,
		updatedAt: at,
		automation: {
			...metadata.automation,
			paused: false,
			error: null,
		},
		approvals: {
			...metadata.approvals,
			reviewApprovedAt: at,
		},
	});
}

export function parseDecision(text) {
	const match = String(text || "").match(/^\s*(?:REVIEW_)?DECISION:\s*([A-Z_ -]+)/im);
	if (!match) return "CHANGES_REQUESTED";
	const value = match[1].trim().replace(/[\s-]+/g, "_");
	if (value === "PASS" || value === "APPROVED") return "PASS";
	return "CHANGES_REQUESTED";
}
