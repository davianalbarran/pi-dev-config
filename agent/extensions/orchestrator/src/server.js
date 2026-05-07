import * as http from "node:http";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { URL } from "node:url";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "./constants.js";
import { getIssueDiffs } from "./diffs.js";
import { renderDashboardHtml } from "./ui.js";

const execFileAsync = promisify(execFile);
let qrcodePromise = null;

async function renderQrSvg(value) {
	try {
		qrcodePromise ||= import("qrcode");
		const { default: QRCode } = await qrcodePromise;
		return QRCode.toString(value, { type: "svg", margin: 1 });
	} catch (error) {
		qrcodePromise = null;
		if (isMissingQrCodeDependency(error)) {
			throw new Error('Missing dependency "qrcode"; run npm install in the orchestrator extension directory.');
		}
		throw error;
	}
}

function isMissingQrCodeDependency(error) {
	const code = error && typeof error === "object" ? error.code : null;
	const message = error instanceof Error ? error.message : String(error);
	return (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") && message.includes("qrcode");
}

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

async function chooseDirectory() {
	if (process.platform !== "darwin") {
		throw new Error("Native directory picking currently requires macOS. Paste an absolute path instead.");
	}
	const script = 'POSIX path of (choose folder with prompt "Choose linked directory for Pi Orchestrator")';
	try {
		const { stdout } = await execFileAsync("osascript", ["-e", script], {
			timeout: 5 * 60 * 1000,
			maxBuffer: 64 * 1024,
		});
		const selected = stdout.trim();
		if (!selected) throw new Error("No directory selected.");
		return selected.length > 1 && selected.endsWith("/") ? selected.slice(0, -1) : selected;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/User canceled/i.test(message)) throw new Error("Directory selection cancelled.");
		throw error;
	}
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
		this.unsubscribe = null;
	}

	async start() {
		if (this.server) return this.url;
		this.server = http.createServer((req, res) => {
			void this.handle(req, res).catch((error) => {
				sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
			});
		});
		this.unsubscribe = this.store.onChange((event) => this.broadcast({ type: "store", event }));
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
		if (!this.server) return;
		await new Promise((resolve) => this.server.close(resolve));
		this.server = null;
		this.shareInfo = null;
	}

	broadcast(event) {
		const payload = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of this.clients) client.write(payload);
	}

	async handle(req, res) {
		const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
		const pathname = url.pathname;

		if (pathname === "/" && req.method === "GET") {
			if (!isAuthorized(req.url || "/", req.headers, this.token)) {
				return sendText(res, 401, "Missing or invalid orchestrator token.");
			}
			return sendText(res, 200, await renderDashboardHtml(this.token), "text/html; charset=utf-8");
		}

		if (!pathname.startsWith("/api/")) {
			return sendText(res, 404, "Not found.");
		}
		if (!isAuthorized(req.url || "/", req.headers, this.token)) {
			return sendJson(res, 401, { error: "Unauthorized." });
		}

		if (pathname === "/api/state" && req.method === "GET") {
			return sendJson(res, 200, await this.store.getBoardState());
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
				return sendJson(res, 200, { linkedDirectory: await chooseDirectory() });
			} catch (error) {
				return sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}

		if (pathname === "/api/issues" && req.method === "POST") {
			const body = await readJsonBody(req);
			const issue = await this.actions.createIssue(body);
			return sendJson(res, 201, issue);
		}

		const diffMatch = pathname.match(/^\/api\/issues\/([^/]+)\/diffs$/);
		if (diffMatch && req.method === "GET") {
			const issue = await this.store.loadIssue(decodeURIComponent(diffMatch[1]));
			return sendJson(res, 200, await getIssueDiffs(issue));
		}

		const match = pathname.match(/^\/api\/issues\/([^/]+)\/([^/]+)$/);
		if (!match || req.method !== "POST") return sendJson(res, 404, { error: "Not found." });

		const id = decodeURIComponent(match[1]);
		const action = match[2];
		const body = await readJsonBody(req);
		if (action === "comment") return sendJson(res, 200, await this.actions.comment(id, body));
		if (action === "approve-plan") return sendJson(res, 200, await this.actions.approvePlan(id));
		if (action === "request-plan-changes") return sendJson(res, 200, await this.actions.requestPlanChanges(id, body));
		if (action === "approve-review") return sendJson(res, 200, await this.actions.approveReview(id));
		if (action === "approve-review-merge") return sendJson(res, 200, await this.actions.approveReviewAndMerge(id));
		if (action === "request-review-changes") return sendJson(res, 200, await this.actions.requestReviewChanges(id, body));
		return sendJson(res, 404, { error: "Not found." });
	}
}
