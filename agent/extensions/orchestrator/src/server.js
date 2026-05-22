import { readFile } from "node:fs/promises";
import * as http from "node:http";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { URL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "./constants.js";
import { getIssueDiffs } from "./diffs.js";
import { renderQrSvg } from "./qr.js";
import { renderDashboardHtml } from "./ui.js";
import { assertSafeIssueId, assertSafeRunPathSegment } from "./store.js";

const execFileAsync = promisify(execFile);
const dashboardCssUrl = new URL("./ui/dashboard.css", import.meta.url);
const dashboardJsUrl = new URL("./ui/dashboard.js", import.meta.url);

export function isAuthorized(reqUrl, headers, token) {
	const url = new URL(reqUrl, "http://127.0.0.1");
	return (
		url.searchParams.get("token") === token ||
		headers["x-orchestrator-token"] === token ||
		headers.authorization === `Bearer ${token}`
	);
}

export function selectLanIpv4Address(interfaces = os.networkInterfaces()) {
	for (const entries of Object.values(interfaces || {})) {
		for (const entry of entries || []) {
			const family = typeof entry.family === "string" ? entry.family : String(entry.family);
			if ((family === "IPv4" || family === "4") && !entry.internal && entry.address) return entry.address;
		}
	}
	return null;
}

function isWildcardHost(host) {
	return host === "0.0.0.0" || host === "::" || host === "";
}

function isLoopbackHost(host) {
	const normalized = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

function hostForUrl(host) {
	const normalized = String(host || "127.0.0.1").replace(/^\[|\]$/g, "");
	return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function rawPathnameFromRequestUrl(reqUrl = "/") {
	const raw = String(reqUrl || "/");
	const queryIndex = raw.indexOf("?");
	const hashIndex = raw.indexOf("#");
	const endIndexes = [queryIndex, hashIndex].filter((index) => index >= 0);
	const endIndex = endIndexes.length ? Math.min(...endIndexes) : raw.length;
	return raw.slice(0, endIndex) || "/";
}

function dashboardUrl(host, port, token) {
	return `http://${hostForUrl(host)}:${port}/?token=${encodeURIComponent(token)}`;
}

function buildShareInfo({ host, port, token, lanAddress = selectLanIpv4Address() }) {
	const listenHost = String(host || DEFAULT_CONFIG.host).trim();
	const localHost = isWildcardHost(listenHost) ? "127.0.0.1" : listenHost;
	const localUrl = dashboardUrl(localHost, port, token);
	const lanEnabled = isWildcardHost(listenHost) || !isLoopbackHost(listenHost);
	let networkHost = null;
	if (isWildcardHost(listenHost)) networkHost = lanAddress;
	else if (!isLoopbackHost(listenHost)) networkHost = listenHost;
	const networkUrl = networkHost ? dashboardUrl(networkHost, port, token) : null;
	return {
		localUrl,
		networkUrl,
		shareUrl: networkUrl || localUrl,
		host: listenHost,
		port,
		lanEnabled,
	};
}

async function readJsonBody(req) {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 1024 * 1024) throw new Error("Request body too large.");
	}
	if (!raw.trim()) return {};
	return JSON.parse(raw);
}

const DIRECTORY_PICKER_TITLE = "Choose linked directory for Pi Orchestrator";
const DIRECTORY_PICKER_TIMEOUT_MS = 5 * 60 * 1000;
const DIRECTORY_PICKER_MAX_BUFFER = 64 * 1024;

const MACOS_DIRECTORY_PICKER_SCRIPT = `POSIX path of (choose folder with prompt "${DIRECTORY_PICKER_TITLE}")`;
const WINDOWS_DIRECTORY_PICKER_SCRIPT = [
	"Add-Type -AssemblyName System.Windows.Forms",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	`$dialog.Description = '${DIRECTORY_PICKER_TITLE.replaceAll("'", "''")}'`,
	"$dialog.ShowNewFolderButton = $true",
	"$result = $dialog.ShowDialog()",
	"if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.SelectedPath) } else { exit 1223 }",
].join("; ");

function isFilesystemRoot(value) {
	if (/^[\\/]+$/.test(value)) return true;
	if (/^[A-Za-z]:[\\/]$/.test(value)) return true;
	return /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]?$/.test(value);
}

export function normalizePickedDirectory(value) {
	let selected = String(value || "").trim();
	if (!selected) throw new Error("Directory selection cancelled.");
	while (/[\\/]$/.test(selected) && !isFilesystemRoot(selected)) {
		selected = selected.slice(0, -1);
	}
	return selected;
}

export function directoryPickerCommandsForPlatform(platform) {
	if (platform === "darwin") {
		return [
			{
				id: "macos-osascript",
				command: "osascript",
				args: ["-e", MACOS_DIRECTORY_PICKER_SCRIPT],
				cancelMessagePattern: /User canceled/i,
			},
		];
	}
	if (platform === "win32") {
		return [
			{
				id: "windows-powershell",
				command: "powershell.exe",
				args: ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_DIRECTORY_PICKER_SCRIPT],
				cancelExitCodes: [1223],
			},
		];
	}
	if (platform === "linux") {
		return [
			{
				id: "linux-zenity",
				command: "zenity",
				args: ["--file-selection", "--directory", `--title=${DIRECTORY_PICKER_TITLE}`],
				cancelExitCodes: [1],
			},
			{
				id: "linux-kdialog",
				command: "kdialog",
				args: ["--getexistingdirectory", ".", DIRECTORY_PICKER_TITLE],
				cancelExitCodes: [1],
			},
		];
	}
	return [];
}

export function directoryPickerUnavailableMessage(platform, commands = directoryPickerCommandsForPlatform(platform)) {
	if (platform === "linux") {
		const toolNames = commands.length ? commands.map((command) => command.command).join(" or ") : "zenity or kdialog";
		return `No supported Linux directory picker was found (tried ${toolNames}). Paste an absolute path instead.`;
	}
	if (commands.length) {
		const toolNames = commands.map((command) => command.command).join(" or ");
		return `No supported directory picker command was found for ${platform} (tried ${toolNames}). Paste an absolute path instead.`;
	}
	return `Native directory picking is not supported on ${platform}. Paste an absolute path instead.`;
}

function isMissingDirectoryPickerCommand(error) {
	return error && typeof error === "object" && error.code === "ENOENT";
}

function isDirectoryPickerCancel(error, command) {
	if (error instanceof Error && error.message === "Directory selection cancelled.") return true;
	const exitCode = error && typeof error === "object" ? error.code : null;
	if (command.cancelExitCodes?.includes(exitCode)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return !!command.cancelMessagePattern?.test(message);
}

async function chooseDirectory() {
	const platform = process.platform;
	const commands = directoryPickerCommandsForPlatform(platform);
	if (!commands.length) throw new Error(directoryPickerUnavailableMessage(platform, commands));

	let missingCommandCount = 0;
	for (const command of commands) {
		try {
			const { stdout } = await execFileAsync(command.command, command.args, {
				timeout: DIRECTORY_PICKER_TIMEOUT_MS,
				maxBuffer: DIRECTORY_PICKER_MAX_BUFFER,
			});
			return normalizePickedDirectory(stdout);
		} catch (error) {
			if (isMissingDirectoryPickerCommand(error)) {
				missingCommandCount += 1;
				continue;
			}
			if (isDirectoryPickerCancel(error, command)) throw new Error("Directory selection cancelled.");
			throw error;
		}
	}

	if (missingCommandCount === commands.length) throw new Error(directoryPickerUnavailableMessage(platform, commands));
	throw new Error("Directory picker failed. Paste an absolute path instead.");
}

function sendJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(`${JSON.stringify(body)}\n`);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
	res.writeHead(status, {
		"content-type": contentType,
		"cache-control": "no-store",
	});
	res.end(text);
}

function decodeIssueIdPathSegment(value) {
	let decoded;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new Error("Invalid issue id.");
	}
	return assertSafeIssueId(decoded);
}

function decodeRunIdPathSegment(value) {
	let decoded;
	try {
		decoded = decodeURIComponent(value);
	} catch {
		throw new Error("Invalid run id.");
	}
	return assertSafeRunPathSegment(decoded);
}

export class OrchestratorServer {
	constructor({ store, token, actions, config = {} }) {
		this.store = store;
		this.token = token;
		this.actions = actions;
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.server = null;
		this.url = null;
		this.shareInfo = null;
		this.clients = new Set();
		this.streamClients = new Map();
		this.unsubscribe = null;
	}

	async start() {
		if (this.server) return this.url;
		this.server = http.createServer((req, res) => {
			void this.handle(req, res).catch((error) => {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		});
		this.unsubscribe = this.store.onChange((event) => {
			if (event?.type === "run_event") this.broadcastRunEvent(event);
			else this.broadcast({ type: "store", event });
		});
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.config.port, this.config.host, () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		const port = typeof address === "object" && address ? address.port : this.config.port;
		this.shareInfo = buildShareInfo({ host: this.config.host, port, token: this.token });
		this.url = this.shareInfo.localUrl;
		return this.url;
	}

	getShareInfo() {
		return this.shareInfo ? { ...this.shareInfo } : null;
	}

	async stop() {
		if (this.unsubscribe) this.unsubscribe();
		this.unsubscribe = null;
		for (const client of this.clients) client.end();
		this.clients.clear();
		for (const clients of this.streamClients.values()) {
			for (const client of clients) client.end();
		}
		this.streamClients.clear();
		if (!this.server) return;
		await new Promise((resolve) => this.server.close(resolve));
		this.server = null;
		this.shareInfo = null;
	}

	broadcast(event) {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.clients) client.write(payload);
	}

	streamKey(issueId, runId) {
		return `${issueId}\0${runId}`;
	}

	broadcastRunEvent(event) {
		if (!event?.id || !event?.runId) return;
		const clients = this.streamClients.get(this.streamKey(event.id, event.runId));
		if (!clients?.size) return;
		const payload = `data: ${JSON.stringify({ type: "run_event", event })}\n\n`;
		for (const client of clients) client.write(payload);
	}

	addStreamClient(issueId, runId, res) {
		const key = this.streamKey(issueId, runId);
		let clients = this.streamClients.get(key);
		if (!clients) {
			clients = new Set();
			this.streamClients.set(key, clients);
		}
		clients.add(res);
		return () => {
			clients.delete(res);
			if (!clients.size) this.streamClients.delete(key);
		};
	}

	async handle(req, res) {
		const pathname = rawPathnameFromRequestUrl(req.url || "/");

		if (pathname === "/" && req.method === "GET") {
			if (!isAuthorized(req.url || "/", req.headers, this.token)) {
				return sendText(res, 401, "Missing or invalid orchestrator token.");
			}
			return sendText(res, 200, await renderDashboardHtml(this.token), "text/html; charset=utf-8");
		}

		if (pathname === "/ui/dashboard.css" && req.method === "GET") {
			return sendText(res, 200, await readFile(dashboardCssUrl, "utf-8"), "text/css; charset=utf-8");
		}

		if (pathname === "/ui/dashboard.js" && req.method === "GET") {
			return sendText(res, 200, await readFile(dashboardJsUrl, "utf-8"), "text/javascript; charset=utf-8");
		}

		if (!pathname.startsWith("/api/")) {
			return sendText(res, 404, "Not found.");
		}
		if (!isAuthorized(req.url || "/", req.headers, this.token)) {
			return sendJson(res, 401, { error: "Unauthorized." });
		}

		if (pathname === "/api/state" && req.method === "GET") {
			const state = await this.store.getBoardState();
			if (this.actions.getBacklogSuggestionState) {
				state.backlogSuggestions = await this.actions.getBacklogSuggestionState();
			}
			return sendJson(res, 200, state);
		}

		if (pathname === "/api/share" && req.method === "GET") {
			return sendJson(res, 200, this.getShareInfo());
		}

		if (pathname === "/api/share.svg" && req.method === "GET") {
			const svg = await renderQrSvg(this.getShareInfo().shareUrl);
			return sendText(res, 200, svg, "image/svg+xml; charset=utf-8");
		}

		if (pathname === "/api/events" && req.method === "GET") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				connection: "keep-alive",
			});
			res.write("event: ready\ndata: {}\n\n");
			this.clients.add(res);
			req.on("close", () => this.clients.delete(res));
			return;
		}

		if (pathname === "/api/profiles" && req.method === "GET") {
			return sendJson(res, 200, { profiles: await this.store.listProfiles() });
		}

		if (pathname === "/api/profiles" && req.method === "POST") {
			const body = await readJsonBody(req);
			return sendJson(res, 200, await this.store.saveProfile(body));
		}

		if (pathname === "/api/pick-directory" && req.method === "POST") {
			try {
				const pickedPath = await chooseDirectory();
				return sendJson(res, 200, { path: pickedPath, linkedDirectory: pickedPath });
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/projects" && req.method === "GET") {
			const projects = await this.store.listProjects();
			const counts = Object.fromEntries(await Promise.all(projects.map(async (project) => [project.id, await this.store.projectTicketCounts(project.id)])));
			return sendJson(res, 200, { projects, counts });
		}

		if (pathname === "/api/projects" && req.method === "POST") {
			try {
				const body = await readJsonBody(req);
				return sendJson(res, 200, await this.store.saveProject(body));
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/projects/resolve-path" && req.method === "POST") {
			try {
				const body = await readJsonBody(req);
				return sendJson(res, 200, await this.store.ensureProjectForPath(body.path || body.linkedDirectory, { name: body.name || body.title }));
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/spec/improve" && req.method === "POST") {
			try {
				const body = await readJsonBody(req);
				return sendJson(res, 200, await this.actions.improveSpec(body));
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/backlog/suggestions" && req.method === "POST") {
			try {
				return sendJson(res, 202, await this.actions.startBacklogSuggestions());
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/issues" && req.method === "POST") {
			try {
				const body = await readJsonBody(req);
				const issue = await this.actions.createIssue(body);
				return sendJson(res, 201, issue);
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/issues/clean-completed" && req.method === "POST") {
			return sendJson(res, 200, await this.store.cleanCompletedTickets());
		}

		const diffMatch = pathname.match(/^\/api\/issues\/([^/]*)\/diffs$/);
		if (diffMatch && req.method === "GET") {
			let id;
			try {
				id = decodeIssueIdPathSegment(diffMatch[1]);
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			const issue = await this.store.loadIssue(id);
			return sendJson(res, 200, await getIssueDiffs(issue));
		}

		const runEventsMatch = pathname.match(/^\/api\/issues\/([^/]*)\/runs\/([^/]+)\/events$/);
		if (runEventsMatch && req.method === "GET") {
			let id;
			let runId;
			try {
				id = decodeIssueIdPathSegment(runEventsMatch[1]);
				runId = decodeRunIdPathSegment(runEventsMatch[2]);
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-store",
				connection: "keep-alive",
			});
			res.write("event: ready\ndata: {}\n\n");
			const remove = this.addStreamClient(id, runId, res);
			req.on("close", remove);
			return;
		}

		const runMatch = pathname.match(/^\/api\/issues\/([^/]*)\/runs\/([^/]+)$/);
		if (runMatch && req.method === "GET") {
			let id = "";
			let runId = "";
			try {
				id = decodeIssueIdPathSegment(runMatch[1]);
				runId = decodeRunIdPathSegment(runMatch[2]);
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error), issueId: id, runId, events: [], session: { items: [], messages: [], tools: [], incomplete: false, ignoredCount: 0 } });
			}
			try {
				return sendJson(res, 200, await this.store.getAgentSession(id, runId));
			} catch (error) {
				return sendJson(res, 404, { error: error instanceof Error ? error.message : String(error), issueId: id, runId, events: [], session: { items: [], messages: [], tools: [], incomplete: false, ignoredCount: 0 } });
			}
		}

		const projectRefreshMatch = pathname.match(/^\/api\/projects\/([^/]+)\/refresh$/);
		if (projectRefreshMatch && req.method === "POST") {
			try {
				const id = decodeURIComponent(projectRefreshMatch[1]);
				return sendJson(res, 200, await this.store.refreshProjectGitState(id));
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)(?:\/(delete))?$/);
		if (projectMatch && req.method === "POST") {
			try {
				const id = decodeURIComponent(projectMatch[1]);
				if (projectMatch[2] === "delete") return sendJson(res, 200, await this.store.deleteProject(id));
				const body = await readJsonBody(req);
				return sendJson(res, 200, await this.store.saveProject({ ...body, id }));
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		const match = pathname.match(/^\/api\/issues\/([^/]*)\/([^/]+)$/);
		if (!match || req.method !== "POST") return sendJson(res, 404, { error: "Not found." });

		try {
			const id = decodeIssueIdPathSegment(match[1]);
			const action = match[2];
			const body = await readJsonBody(req);
			if (action === "comment") return sendJson(res, 200, await this.actions.comment(id, body));
			if (action === "update-backlog") return sendJson(res, 200, await this.actions.updateBacklogIssue(id, body));
			if (action === "delete-backlog") return sendJson(res, 200, await this.actions.deleteBacklogIssue(id));
			if (action === "send-to-agent") return sendJson(res, 200, await this.actions.sendBacklogIssueToAgent(id));
			if (action === "approve-plan") return sendJson(res, 200, await this.actions.approvePlan(id));
			if (action === "request-plan-changes") return sendJson(res, 200, await this.actions.requestPlanChanges(id, body));
			if (action === "approve-review") return sendJson(res, 200, await this.actions.approveReview(id));
			if (action === "approve-review-merge") return sendJson(res, 200, await this.actions.approveReviewAndMerge(id));
			if (action === "request-review-changes") return sendJson(res, 200, await this.actions.requestReviewChanges(id, body));
			if (action === "resume") return sendJson(res, 200, await this.actions.resumeBlockedIssue(id));
			return sendJson(res, 404, { error: "Not found." });
		} catch (error) {
			return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	}
}
