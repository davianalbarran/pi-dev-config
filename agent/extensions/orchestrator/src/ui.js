import { readFile } from "node:fs/promises";
import { DEFAULT_PROFILE_ID, KANBAN_LANES, LANE, LANES, ROLE_DEFAULTS, THINKING_LEVELS } from "./constants.js";

const dashboardTemplateUrl = new URL("./ui/dashboard.html", import.meta.url);
let dashboardTemplatePromise;

async function getDashboardTemplate() {
	if (!dashboardTemplatePromise) {
		dashboardTemplatePromise = readFile(dashboardTemplateUrl, "utf-8");
	}
	return dashboardTemplatePromise;
}

function escapeHtmlAttribute(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

function jsonAttribute(value) {
	return escapeHtmlAttribute(JSON.stringify(value));
}

export async function renderDashboardHtml(token) {
	const replacements = {
		__TOKEN_JSON_ATTR__: jsonAttribute(token),
		__LANES_JSON_ATTR__: jsonAttribute(LANES),
		__KANBAN_LANES_JSON_ATTR__: jsonAttribute(KANBAN_LANES),
		__LANE_JSON_ATTR__: jsonAttribute(LANE),
		__ROLE_DEFAULTS_JSON_ATTR__: jsonAttribute(ROLE_DEFAULTS),
		__THINKING_LEVELS_JSON_ATTR__: jsonAttribute(THINKING_LEVELS),
		__DEFAULT_PROFILE_ID_JSON_ATTR__: jsonAttribute(DEFAULT_PROFILE_ID),
	};
	let html = await getDashboardTemplate();
	for (const [placeholder, value] of Object.entries(replacements)) {
		html = html.replaceAll(placeholder, value);
	}
	return html;
}
