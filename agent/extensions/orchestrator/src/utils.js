import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export function nowIso() {
	return new Date().toISOString();
}

export function expandHome(input) {
	if (!input || typeof input !== "string") return input;
	if (input === "~") return os.homedir();
	if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
	return input;
}

export function normalizePath(input, cwd = process.cwd()) {
	const expanded = expandHome(String(input || "").trim());
	return path.resolve(cwd, expanded);
}

export function slugify(input, fallback = "item") {
	const slug = String(input || "")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
	return slug || fallback;
}

export function sanitizeForBranch(input) {
	return slugify(input, "issue").replace(/\.+/g, ".").replace(/^\.|\.$/g, "");
}

export async function ensureDir(dir) {
	await fsp.mkdir(dir, { recursive: true });
}

export async function pathExists(filePath) {
	try {
		await fsp.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function readJson(filePath, fallback = undefined) {
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		return JSON.parse(raw);
	} catch (error) {
		if (error && error.code === "ENOENT") return fallback;
		throw error;
	}
}

export async function writeFileAtomic(filePath, content) {
	await ensureDir(path.dirname(filePath));
	const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, content, "utf-8");
	await fsp.rename(tmp, filePath);
}

export async function writeJsonAtomic(filePath, data) {
	await writeFileAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export async function appendJsonLine(filePath, data) {
	await ensureDir(path.dirname(filePath));
	await fsp.appendFile(filePath, `${JSON.stringify(data)}\n`, "utf-8");
}

export async function readJsonLines(filePath) {
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch (error) {
		if (error && error.code === "ENOENT") return [];
		throw error;
	}
}

export function debounce(fn, delayMs) {
	let timer = null;
	return (...args) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, delayMs);
	};
}

export function makeId(title) {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	const suffix = Math.random().toString(36).slice(2, 8);
	return `PI-${stamp}-${slugify(title, "issue").slice(0, 32)}-${suffix}`;
}

export function isDirectorySync(candidate) {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}
