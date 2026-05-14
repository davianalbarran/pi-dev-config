import * as os from "node:os";
import * as path from "node:path";

export const KANBAN_LANES = Object.freeze([
	"Created",
	"Planning",
	"Plan in review",
	"In Progress",
	"In Review",
	"Completed",
]);

export const LANES = Object.freeze([
	...KANBAN_LANES,
	"Backlog",
]);

export const LANE = Object.freeze({
	CREATED: "Created",
	PLANNING: "Planning",
	PLAN_REVIEW: "Plan in review",
	IN_PROGRESS: "In Progress",
	IN_REVIEW: "In Review",
	COMPLETED: "Completed",
	BACKLOG: "Backlog",
});

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), ".pi", "agent", "orchestrator");
export const DEFAULT_PROFILE_ID = "default";
export const MAX_PLANNING_ATTEMPTS = 3;
export const MAX_IMPLEMENTATION_ATTEMPTS = 3;
export const ISSUE_AGENT_ROLES = Object.freeze(["planner", "worker", "reviewer"]);
export const THINKING_LEVELS = Object.freeze(["low", "medium", "high", "xhigh"]);

// Conservative cleanup retention for completed tickets when no project-specific
// policy exists. Eligibility uses updatedAt as the completion-age proxy, so
// editing a completed ticket refreshes its retention window.
export const COMPLETED_TICKET_CLEANUP_RETENTION_DAYS = 30;

export const DEFAULT_CONFIG = Object.freeze({
	// Keep the dashboard loopback-only by default. Use PI_ORCHESTRATOR_BIND_LAN=1
	// or host: "0.0.0.0" to opt in to local-network access.
	host: "127.0.0.1",
	port: 0,
	planningConcurrency: 1,
	implementationConcurrency: 1,
	tickMs: 1500,
	agentTimeoutMs: 60 * 60 * 1000,
	agentIdleTimeoutMs: 10 * 60 * 1000,
});

export const ROLE_TOOLS = Object.freeze({
	planner: "read,grep,find,ls",
	"spec-writer": "read,grep,find,ls",
	"feature-suggestor": "read,grep,find,ls",
	worker: "read,bash,edit,write,grep,find,ls",
	reviewer: "read,bash,grep,find,ls",
	"final-reviewer": "read,bash,grep,find,ls",
	merger: "read,bash,edit,grep,find,ls",
});

export const ROLE_DEFAULTS = Object.freeze({
	planner: {
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
	},
	"spec-writer": {
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
	},
	"feature-suggestor": {
		model: "openai-codex/gpt-5.5",
		thinking: "medium",
	},
	worker: {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	},
	reviewer: {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	},
	"final-reviewer": {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	},
	merger: {
		model: "openai-codex/gpt-5.5",
		thinking: "high",
	},
});
