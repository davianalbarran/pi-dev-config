const MESSAGE_EVENT_TYPES = new Set(["message_start", "message_update", "message_end"]);
const TOOL_EVENT_ALIASES = new Map([
	["tool_call_start", "tool_call_start"],
	["tool_call_update", "tool_call_update"],
	["tool_call_end", "tool_call_end"],
	["tool_execution_start", "tool_call_start"],
	["tool_execution_update", "tool_call_update"],
	["tool_execution_end", "tool_call_end"],
]);

function asObject(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
	for (const value of values) {
		if (typeof value === "string" && value) return value;
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return "";
}

function textFromContentPart(part) {
	if (typeof part === "string") return part;
	const object = asObject(part);
	if (!object) return "";
	if (typeof object.content === "string") return object.content;
	if (Array.isArray(object.content)) return object.content.map(textFromContentPart).filter(Boolean).join("\n").trim();
	return firstString(object.text, object.delta, object.summary, object.thinking, object.value);
}

export function textFromMessage(message) {
	if (typeof message === "string") return message;
	const object = asObject(message);
	if (!object) return "";
	if (typeof object.content === "string") return object.content;
	if (Array.isArray(object.content)) return object.content.map(textFromContentPart).filter(Boolean).join("\n").trim();
	return firstString(object.text, object.delta, object.summary, object.thinking);
}

function textFromToolResult(value) {
	const text = textFromMessage(value);
	if (text) return text;
	const object = asObject(value);
	if (!object) return "";
	return firstString(object.output, object.stdout, object.stderr, object.result, object.value);
}

function stringifyValue(value) {
	if (value === undefined || value === null) return "";
	if (typeof value === "string") return value;
	const contentText = textFromToolResult(value);
	if (contentText) return contentText;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function textFromSnapshotEvent(event) {
	const assistant = asObject(event.assistantMessageEvent);
	return firstString(textFromMessage(event.message), textFromMessage(assistant?.partial), textFromMessage(assistant?.message));
}

function textFromEvent(event, lifecycleType) {
	const assistant = asObject(event.assistantMessageEvent);
	const delta = asObject(event.delta);
	if (lifecycleType === "message_update") {
		if (assistant) {
			if (assistant.type === "text_delta" || assistant.type === "thinking_delta") {
				return { text: firstString(assistant.delta), mode: "append" };
			}
			if (assistant.type === "text_end" || assistant.type === "thinking_end") {
				return { text: firstString(textFromSnapshotEvent(event), assistant.content), mode: "replace" };
			}
			if (assistant.type === "text_start" || assistant.type === "thinking_start" || assistant.type === "toolcall_start" || assistant.type === "toolcall_delta" || assistant.type === "toolcall_end") {
				return { text: textFromSnapshotEvent(event), mode: "replace" };
			}
			if (typeof assistant.delta === "string") return { text: assistant.delta, mode: "append" };
			if (typeof assistant.content === "string") return { text: firstString(textFromSnapshotEvent(event), assistant.content), mode: "replace" };
			if (typeof assistant.text === "string") return { text: assistant.text, mode: "append" };
		}
		const directDelta = firstString(event.delta, event.textDelta, event.messageDelta, delta?.text, delta?.content, delta?.delta);
		if (directDelta) return { text: directDelta, mode: "append" };
		const directText = firstString(event.text, event.content);
		if (directText) return { text: directText, mode: "append" };
		return { text: textFromSnapshotEvent(event), mode: "replace" };
	}
	return {
		text: firstString(event.text, event.content, textFromSnapshotEvent(event), event.delta, event.textDelta, event.messageDelta, assistant?.text, assistant?.content, assistant?.delta, delta?.text, delta?.content, delta?.delta),
		mode: "replace",
	};
}

function messageIdFromEvent(event) {
	const message = asObject(event.message);
	const assistant = asObject(event.assistantMessageEvent);
	return firstString(event.messageId, event.message_id, message?.id, assistant?.messageId, assistant?.message_id, assistant?.id);
}

function toolPayload(event) {
	return asObject(event.toolCall) || asObject(event.tool_call) || asObject(event.toolExecution) || asObject(event.tool_execution) || asObject(event.call) || asObject(event.execution) || {};
}

function toolIdFromEvent(event) {
	const tool = toolPayload(event);
	return firstString(event.toolCallId, event.tool_call_id, event.toolExecutionId, event.tool_execution_id, event.callId, tool.id, tool.callId, tool.toolCallId);
}

function toolNameFromEvent(event) {
	const tool = toolPayload(event);
	return firstString(event.toolName, event.tool_name, event.name, event.tool, tool.name, tool.toolName, tool.command);
}

function toolInputFromEvent(event) {
	const tool = toolPayload(event);
	return stringifyValue(event.input ?? event.arguments ?? event.args ?? event.parameters ?? tool.input ?? tool.arguments ?? tool.args ?? tool.parameters);
}

function toolOutputFromEvent(event) {
	const tool = toolPayload(event);
	return stringifyValue(event.partialResult ?? event.output ?? event.result ?? event.stdout ?? event.stderr ?? event.text ?? event.delta ?? tool.partialResult ?? tool.output ?? tool.result ?? tool.stdout ?? tool.stderr);
}

function toolErrorFromEvent(event) {
	const tool = toolPayload(event);
	const result = asObject(event.result) || asObject(tool.result);
	const partialResult = asObject(event.partialResult) || asObject(tool.partialResult);
	return firstString(event.error, event.errorMessage, result?.error, result?.errorMessage, partialResult?.error, partialResult?.errorMessage, tool.error, tool.errorMessage);
}

function toolIsErrorFromEvent(event) {
	const tool = toolPayload(event);
	const result = asObject(event.result) || asObject(tool.result);
	const partialResult = asObject(event.partialResult) || asObject(tool.partialResult);
	return event.isError === true || result?.isError === true || partialResult?.isError === true || tool.isError === true;
}

function normalizeType(type) {
	if (MESSAGE_EVENT_TYPES.has(type)) return type;
	return TOOL_EVENT_ALIASES.get(type) || "";
}

export function normalizeAgentSessionEvent(event, index = 0) {
	const object = asObject(event);
	if (!object) return null;
	const type = normalizeType(object.type);
	if (!type) return null;
	if (type.startsWith("message_")) {
		const text = textFromEvent(object, type);
		return {
			kind: "message",
			type,
			at: object.at || object.timestamp || null,
			id: messageIdFromEvent(object),
			role: firstString(object.role, asObject(object.message)?.role) || "assistant",
			text: text.text,
			textMode: text.mode,
			raw: object,
			index,
		};
	}
	return {
		kind: "tool",
		type,
		at: object.at || object.timestamp || null,
		id: toolIdFromEvent(object),
		name: toolNameFromEvent(object),
		input: toolInputFromEvent(object),
		output: toolOutputFromEvent(object),
		error: toolErrorFromEvent(object),
		isError: toolIsErrorFromEvent(object),
		success: typeof object.success === "boolean" ? object.success : undefined,
		status: firstString(object.status, asObject(toolPayload(object))?.status),
		raw: object,
		index,
	};
}

function appendText(existing, next) {
	if (!next) return existing || "";
	return `${existing || ""}${next}`;
}

export function assembleAgentSession(events = []) {
	const inputEvents = Array.isArray(events) ? events : [];
	const items = [];
	const messages = [];
	const tools = [];
	const messagesById = new Map();
	const toolsById = new Map();
	let currentMessage = null;
	let generatedMessageCount = 0;
	let generatedToolCount = 0;
	let ignoredCount = 0;

	function getMessage(normalized) {
		let id = normalized.id;
		if (normalized.type === "message_end" && currentMessage && (!id || !messagesById.has(id))) id = currentMessage.id;
		id = id || currentMessage?.id || `message-${++generatedMessageCount}`;
		let item = messagesById.get(id);
		if (!item) {
			item = {
				kind: "message",
				id,
				role: normalized.role || "assistant",
				content: "",
				status: normalized.type === "message_end" ? "complete" : "streaming",
				startedAt: normalized.at,
				updatedAt: normalized.at,
				endedAt: null,
				eventTypes: [],
			};
			messagesById.set(id, item);
			messages.push(item);
			items.push(item);
		}
		currentMessage = item;
		return item;
	}

	function getTool(normalized) {
		const id = normalized.id || `tool-${++generatedToolCount}`;
		let item = toolsById.get(id);
		if (!item) {
			item = {
				kind: "tool",
				id,
				name: normalized.name || "tool",
				input: "",
				updates: [],
				output: "",
				error: "",
				status: normalized.type === "tool_call_end" ? "complete" : "running",
				startedAt: normalized.at,
				updatedAt: normalized.at,
				endedAt: null,
				eventTypes: [],
			};
			toolsById.set(id, item);
			tools.push(item);
			items.push(item);
		}
		if (normalized.name && item.name === "tool") item.name = normalized.name;
		return item;
	}

	for (let index = 0; index < inputEvents.length; index += 1) {
		const normalized = normalizeAgentSessionEvent(inputEvents[index], index);
		if (!normalized) {
			ignoredCount += 1;
			continue;
		}
		if (normalized.kind === "message") {
			const item = getMessage(normalized);
			item.eventTypes.push(normalized.type);
			item.updatedAt = normalized.at || item.updatedAt;
			if (normalized.type === "message_start" && normalized.text && !item.content) item.content = normalized.text;
			if (normalized.type === "message_update") {
				if (normalized.textMode === "replace") {
					if (normalized.text) item.content = normalized.text;
				} else {
					item.content = appendText(item.content, normalized.text);
				}
			}
			if (normalized.type === "message_end") {
				if (normalized.text) item.content = normalized.text;
				item.status = "complete";
				item.endedAt = normalized.at || item.updatedAt;
				currentMessage = null;
			}
			continue;
		}
		const item = getTool(normalized);
		item.eventTypes.push(normalized.type);
		item.updatedAt = normalized.at || item.updatedAt;
		if (normalized.name && (!item.name || item.name === "tool")) item.name = normalized.name;
		if (normalized.input && !item.input) item.input = normalized.input;
		if (normalized.type === "tool_call_update" && normalized.output) item.updates.push({ at: normalized.at, text: normalized.output });
		if (normalized.isError) item.status = "error";
		if (normalized.type === "tool_call_end") {
			if (normalized.output) item.output = normalized.output;
			if (normalized.error) item.error = normalized.error;
			if (normalized.isError && !item.error) item.error = "Tool returned an error.";
			item.status = normalized.error || normalized.isError || normalized.success === false ? "error" : (normalized.status || "complete");
			item.endedAt = normalized.at || item.updatedAt;
		} else if (normalized.status && !normalized.isError) {
			item.status = normalized.status;
		}
	}

	for (const item of items) {
		if (item.status === "streaming" || item.status === "running") item.incomplete = true;
	}
	return {
		items,
		messages,
		tools,
		incomplete: items.some((item) => item.incomplete),
		ignoredCount,
	};
}
