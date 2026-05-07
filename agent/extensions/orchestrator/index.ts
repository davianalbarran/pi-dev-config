import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createOrchestratorRuntime } from "./src/runtime.js";

export default function orchestratorExtension(pi: ExtensionAPI) {
	if (process.env.PI_ORCHESTRATOR_CHILD === "1") return;

	const runtime = createOrchestratorRuntime();

	pi.on("session_start", async (_event, ctx) => {
		await runtime.start(ctx);
	});

	pi.on("session_shutdown", async () => {
		await runtime.stop();
	});

	pi.registerCommand("orchestrator", {
		description: "Show the local Pi orchestrator board URL and status.",
		handler: async (_args, ctx) => {
			await runtime.start(ctx);
			const state = runtime.getStatus();
			ctx.ui.notify(`Pi orchestrator: ${state.url}`, "info");
			ctx.ui.setWidget("pi-orchestrator", [
				"Pi orchestrator",
				`Board: ${state.url}`,
				`Data: ${state.dataRoot}`,
				`Issues: ${state.issueCount}`,
			]);
		},
	});
}
