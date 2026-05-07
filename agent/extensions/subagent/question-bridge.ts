import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface QuestionItem {
	id: string;
	label?: string;
	question: string;
	options: string[];
	allowCustom?: boolean;
}

export interface QuestionRequest {
	requestId: string;
	questions?: QuestionItem[];
	question?: string;
	options?: string[];
	allowCustom?: boolean;
}

export interface QuestionAnswer {
	id: string;
	answer: string;
	selectedIndex?: number;
	wasCustom?: boolean;
}

export interface QuestionResponse {
	requestId: string;
	answers?: QuestionAnswer[];
	answer?: string;
	cancelled?: boolean;
	error?: string;
}

export const QUESTION_BRIDGE_ENV = "PI_QUESTION_BRIDGE_FILE";

export function normalizeQuestionRequest(req: QuestionRequest): QuestionItem[] {
	if (Array.isArray(req.questions) && req.questions.length > 0) {
		return req.questions.map((question, index) => ({
			id: question.id || `q${index + 1}`,
			label: question.label || `Q${index + 1}`,
			question: question.question,
			options: [...question.options],
			allowCustom: question.allowCustom,
		}));
	}
	if (req.question) {
		return [
			{
				id: "q1",
				label: "Q1",
				question: req.question,
				options: [...(req.options || [])],
				allowCustom: req.allowCustom,
			},
		];
	}
	return [];
}

export function normalizeQuestionResponse(req: QuestionRequest, res: QuestionResponse): QuestionAnswer[] {
	if (Array.isArray(res.answers) && res.answers.length > 0) return res.answers;
	const questions = normalizeQuestionRequest(req);
	if (questions.length === 1 && typeof res.answer === "string") {
		return [{ id: questions[0]!.id, answer: res.answer }];
	}
	return [];
}

export async function writeBridgeRequest(bridgeFile: string, req: QuestionRequest): Promise<void> {
	await cleanupBridgeFiles(bridgeFile);
	await fs.writeFile(bridgeFile + ".req", JSON.stringify(req) + "\n", "utf-8");
}

export async function readBridgeResponse(bridgeFile: string, requestId: string, timeoutMs = 0): Promise<QuestionResponse> {
	const resFile = bridgeFile + ".res";
	const startTime = Date.now();
	while (true) {
		try {
			const data = await fs.readFile(resFile, "utf-8");
			const res = JSON.parse(data) as QuestionResponse;
			if (res.requestId === requestId) return res;
		} catch (e: any) {
			if (e.code !== "ENOENT") throw e;
		}
		if (timeoutMs > 0 && Date.now() - startTime > timeoutMs) {
			throw new Error("Timeout waiting for question response");
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

export async function waitForBridgeRequest(bridgeFile: string): Promise<QuestionRequest | null> {
	try {
		const data = await fs.readFile(bridgeFile + ".req", "utf-8");
		return JSON.parse(data) as QuestionRequest;
	} catch (e: any) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
}

export async function writeBridgeResponse(bridgeFile: string, res: QuestionResponse): Promise<void> {
	await fs.writeFile(bridgeFile + ".res", JSON.stringify(res) + "\n", "utf-8");
}

export async function cleanupBridgeFiles(bridgeFile: string): Promise<void> {
	try {
		await fs.unlink(bridgeFile + ".req");
	} catch {}
	try {
		await fs.unlink(bridgeFile + ".res");
	} catch {}
}

export function createBridgeFilePath(runToken: number | string): string {
	return path.join(os.tmpdir(), `pi-question-bridge-${runToken}`);
}
