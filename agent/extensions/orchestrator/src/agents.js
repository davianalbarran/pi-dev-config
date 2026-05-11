import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { ROLE_DEFAULTS } from "./constants.js";
import { ensureDir, writeFileAtomic } from "./utils.js";

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT_DIR = path.join(os.homedir(), ".pi", "agent", "agents");

function parseFrontmatter(raw) {
	if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
	const end = raw.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: raw };
	const yaml = raw.slice(3, end).trim();
	const body = raw.slice(end + 4).trim();
	const frontmatter = {};
	for (const line of yaml.split("\n")) {
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (!match) continue;
		frontmatter[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
	}
	return { frontmatter, body };
}

async function readIfExists(filePath) {
	try {
		return await fsp.readFile(filePath, "utf-8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

export async function loadRoleConfig(role) {
	const defaults = ROLE_DEFAULTS[role] || ROLE_DEFAULTS.worker;
	const localPath = path.join(EXT_DIR, "agents", `${role}.md`);
	const userPath = path.join(USER_AGENT_DIR, `${role}.md`);
	const raw = (await readIfExists(localPath)) || (await readIfExists(userPath)) || "";
	const parsed = parseFrontmatter(raw);
	return {
		role,
		model: parsed.frontmatter.model || defaults.model,
		thinking: parsed.frontmatter.thinking || parsed.frontmatter.thinkingLevel || defaults.thinking,
		systemPrompt: parsed.body || fallbackPrompt(role),
	};
}

export async function writeSystemPromptTemp(role, prompt) {
	const dir = path.join(os.tmpdir(), "pi-orchestrator-prompts");
	await ensureDir(dir);
	const filePath = path.join(dir, `${process.pid}-${Date.now()}-${role}.md`);
	await writeFileAtomic(filePath, prompt);
	return filePath;
}

function fallbackPrompt(role) {
	if (role === "final-reviewer") {
		return [
			"You are a final reviewer for an autonomous coding workflow.",
			"Review the full ticket chronology and judge the completed work against the latest applicable requirements.",
			"For conflicting guidance, prioritize: 1. most recent explicit human comments or decisions, 2. current ticket state and phase instructions, 3. accepted implementation plan, 4. original ticket description.",
			"Later human feedback, especially In Review comments, supersedes conflicting plan details; do not request changes solely for following newer human direction over an older plan.",
			"Do not modify files. Return DECISION: PASS only when the implementation is correct, complete, regression-free, and aligned with the latest requirements.",
		].join("\n");
	}
	return "You are a focused coding agent. Follow the user task exactly and report your result clearly.";
}
