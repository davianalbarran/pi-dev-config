import { readFile } from "node:fs/promises";
import { LANE, LANES, ROLE_DEFAULTS, THINKING_LEVELS } from "./constants.js";

const dashboardTemplateUrl = new URL("./ui/dashboard.html", import.meta.url);
let dashboardTemplatePromise;

async function getDashboardTemplate() {
	if (!dashboardTemplatePromise) {
		dashboardTemplatePromise = readFile(dashboardTemplateUrl, "utf-8");
	}
	return dashboardTemplatePromise;
}

export async function renderDashboardHtml(token) {
	const replacements = {
		__TOKEN_JSON__: JSON.stringify(token),
		__LANES_JSON__: JSON.stringify(LANES),
		__LANE_JSON__: JSON.stringify(LANE),
		__ROLE_DEFAULTS_JSON__: JSON.stringify(ROLE_DEFAULTS),
		__THINKING_LEVELS_JSON__: JSON.stringify(THINKING_LEVELS),
	};
	let html = await getDashboardTemplate();
	for (const [placeholder, value] of Object.entries(replacements)) {
		html = html.replaceAll(placeholder, value);
	}
	return html;
}
