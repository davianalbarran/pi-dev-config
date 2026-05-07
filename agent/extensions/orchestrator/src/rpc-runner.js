import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { ROLE_TOOLS } from "./constants.js";
import { loadRoleConfig, writeSystemPromptTemp } from "./agents.js";
import { ensureDir, nowIso } from "./utils.js";

function getTextFromMessage(message) {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part && part.type === "text")
		.map((part) => part.text || "")
		.join("\n")
		.trim();
}

function getLastAssistantTextFromMessages(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const text = getTextFromMessage(messages[i]);
		if (text) return text;
	}
	return "";
}

export class RpcAgentRunner {
	constructor({ store, command = "pi", timeoutMs = 60 * 60 * 1000, idleTimeoutMs = 10 * 60 * 1000 } = {}) {
		this.store = store;
		this.command = command;
		this.timeoutMs = timeoutMs;
		this.idleTimeoutMs = idleTimeoutMs;
		this.running = new Map();
	}

	async run({ issueId, role, cwd, prompt, signal, agentSettings = null, onRunStarted = null }) {
		const runId = `${Date.now()}-${role}-${Math.random().toString(36).slice(2, 8)}`;
		const runLogPath = this.store.runPath(issueId, runId);
		await ensureDir(path.dirname(runLogPath));

		const roleConfig = await loadRoleConfig(role);
		const effectiveConfig = {
			...roleConfig,
			model: agentSettings?.model || roleConfig.model,
			thinking: agentSettings?.thinking || roleConfig.thinking,
		};
		await this.store.appendRunEvent(issueId, runId, {
			type: "run_started",
			role,
			cwd,
			model: effectiveConfig.model,
			thinking: effectiveConfig.thinking,
		});
		if (onRunStarted) await onRunStarted(runId);
		const systemPromptPath = await writeSystemPromptTemp(role, effectiveConfig.systemPrompt);
		const sessionFile = path.join(this.store.sessionsRoot, issueId, `${runId}.jsonl`);
		await ensureDir(path.dirname(sessionFile));

		const args = [
			"--mode",
			"rpc",
			"--session",
			sessionFile,
			"--no-extensions",
			"--tools",
			ROLE_TOOLS[role] || ROLE_TOOLS.worker,
			"--append-system-prompt",
			systemPromptPath,
		];
		if (effectiveConfig.model) args.push("--model", effectiveConfig.model);
		if (effectiveConfig.thinking) args.push("--thinking", effectiveConfig.thinking);

		const child = spawn(this.command, args, {
			cwd,
			env: { ...process.env, PI_ORCHESTRATOR_CHILD: "1" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.running.set(runId, child);

		let nextRequestId = 1;
		let stdoutBuffer = "";
		let stderr = "";
		let lastAssistantText = "";
		let agentEnded = false;
		let agentEndSettled = false;
		const messages = [];
		const pending = new Map();

		const appendRaw = async (event) => {
			await fsp.appendFile(runLogPath, `${JSON.stringify({ ...event, at: nowIso() })}\n`, "utf-8");
		};

		const send = (command) => {
			const id = `req-${nextRequestId++}`;
			const payload = { id, ...command };
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject, command: command.type });
				child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
					if (error) {
						pending.delete(id);
						reject(error);
					}
				});
			});
		};

		const respondToExtensionUi = (request) => {
			if (!request.id) return;
			if (request.method === "select" || request.method === "input" || request.method === "editor") {
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, cancelled: true })}\n`);
			} else if (request.method === "confirm") {
				child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: request.id, confirmed: false })}\n`);
			}
		};

		let resolveAgentEnd;
		let rejectAgentEnd;
		const agentEndPromise = new Promise((resolve, reject) => {
			resolveAgentEnd = resolve;
			rejectAgentEnd = reject;
		});
		const settleAgentEnd = (event) => {
			if (agentEndSettled) return;
			agentEndSettled = true;
			resolveAgentEnd(event);
		};
		const settleAgentError = (error) => {
			if (agentEndSettled) return;
			agentEndSettled = true;
			rejectAgentEnd(error);
		};

		const handleLine = (line) => {
			if (!line.trim()) return;
			let event;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			void appendRaw(event);

			if (event.type === "response" && event.id && pending.has(event.id)) {
				const request = pending.get(event.id);
				pending.delete(event.id);
				if (event.success) request.resolve(event);
				else request.reject(new Error(event.error || `${request.command} failed`));
				return;
			}

			if (event.type === "extension_ui_request") {
				respondToExtensionUi(event);
				return;
			}

			if (event.type === "message_end" && event.message) {
				messages.push(event.message);
				const text = getTextFromMessage(event.message);
				if (text) lastAssistantText = text;
			}
			if (event.type === "agent_end") {
				agentEnded = true;
				if (Array.isArray(event.messages)) {
					lastAssistantText = getLastAssistantTextFromMessages(event.messages) || lastAssistantText;
				}
				settleAgentEnd(event);
			}
		};

		const cleanup = async () => {
			this.running.delete(runId);
			try {
				await fsp.unlink(systemPromptPath);
			} catch {
				/* ignore */
			}
		};

		const kill = () => {
			if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			}, 5000).unref?.();
		};

		const abortHandler = () => {
			kill();
			settleAgentError(new Error("Agent run aborted."));
		};

		let idleTimer = null;
		const touchIdleTimer = () => {
			if (!this.idleTimeoutMs || this.idleTimeoutMs <= 0 || agentEndSettled) return;
			if (idleTimer) clearTimeout(idleTimer);
			idleTimer = setTimeout(() => {
				void appendRaw({ type: "idle_timeout", idleTimeoutMs: this.idleTimeoutMs });
				kill();
				settleAgentError(new Error(`Agent run produced no RPC events for ${this.idleTimeoutMs}ms.`));
			}, this.idleTimeoutMs);
			idleTimer.unref?.();
		};

		child.stdout.on("data", (data) => {
			touchIdleTimer();
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) handleLine(line);
		});
		child.stderr.on("data", (data) => {
			touchIdleTimer();
			stderr += data.toString();
			void appendRaw({ type: "stderr", text: data.toString() });
		});
		child.on("exit", (code, signalCode) => {
			if (stdoutBuffer.trim()) handleLine(stdoutBuffer);
			void appendRaw({ type: "process_exit", code, signal: signalCode });
			for (const request of pending.values()) {
				request.reject(new Error(`Agent process exited before ${request.command} completed.`));
			}
			pending.clear();
			if (!agentEnded) {
				const exitReason = signalCode ? `signal ${signalCode}` : `code ${code}`;
				settleAgentError(new Error(`Agent process exited with ${exitReason} before agent_end. ${stderr}`.trim()));
			} else if (code !== 0) {
				settleAgentError(new Error(`Agent process exited with code ${code}. ${stderr}`.trim()));
			}
		});
		child.on("error", (error) => {
			settleAgentError(error);
		});
		if (signal) {
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}

		const timeout = setTimeout(() => {
			kill();
			settleAgentError(new Error(`Agent run timed out after ${this.timeoutMs}ms.`));
		}, this.timeoutMs);
		timeout.unref?.();

		try {
			await new Promise((resolve) => setTimeout(resolve, 150));
			if (child.exitCode !== null) throw new Error(`Agent process exited immediately. ${stderr}`.trim());
			touchIdleTimer();
			await send({ type: "prompt", message: prompt });
			await agentEndPromise;
			await this.store.appendRunEvent(issueId, runId, { type: "run_finished", role });
			return {
				runId,
				role,
				text: lastAssistantText,
				sessionFile,
				runLogPath,
				stderr,
			};
		} finally {
			clearTimeout(timeout);
			if (idleTimer) clearTimeout(idleTimer);
			if (signal) signal.removeEventListener?.("abort", abortHandler);
			kill();
			await cleanup();
		}
	}

	async stopAll() {
		for (const child of this.running.values()) {
			if (child.exitCode === null) child.kill("SIGTERM");
		}
		this.running.clear();
	}
}
