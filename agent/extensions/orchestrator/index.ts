import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createOrchestratorRuntime, parseOrchestratorEnv } from "./src/runtime.js";

export default function orchestratorExtension(pi: ExtensionAPI) {
	if (process.env.PI_ORCHESTRATOR_CHILD === "1") return;

	const runtime = createOrchestratorRuntime({ config: parseOrchestratorEnv() });

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
			ctx.ui.notify(`Pi orchestrator: ${state.localUrl || state.url}${state.networkUrl ? `\nNetwork: ${state.networkUrl}` : ""}`, "info");
			ctx.ui.setWidget("pi-orchestrator", [
				"Pi orchestrator",
				`Local: ${state.localUrl || state.url}`,
				...(state.networkUrl ? [`Network: ${state.networkUrl}`] : []),
				`Data: ${state.dataRoot}`,
				`Issues: ${state.issueCount}`,
			]);
		},
	});
}
