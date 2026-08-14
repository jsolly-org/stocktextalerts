import {
	fetchGrokResponse,
	type GrokFunctionCallOutput,
	type GrokResponsesRequest,
	type GrokResponsesResponse,
} from "./grok";

export type GrokFunctionCall = {
	call_id: string;
	name: string;
	arguments: string;
};

export function collectFunctionCalls(response: GrokResponsesResponse): GrokFunctionCall[] {
	const out: GrokFunctionCall[] = [];
	for (const item of response.output ?? []) {
		if (item.type !== "function_call") continue;
		const callId = typeof item.call_id === "string" ? item.call_id : undefined;
		const name = typeof item.name === "string" ? item.name : undefined;
		const args = typeof item.arguments === "string" ? item.arguments : "{}";
		if (!callId || !name) continue;
		out.push({ call_id: callId, name, arguments: args });
	}
	return out;
}

export type GrokSearchToolUsage = {
	/** A server-side `web_search` call appears on the Responses output. */
	web: boolean;
	/** A server-side `x_search` call appears on the Responses output. */
	x: boolean;
};

/** Which server-side search tools the Responses output actually invoked. */
export function collectSearchToolUsage(response: GrokResponsesResponse): GrokSearchToolUsage {
	const usage: GrokSearchToolUsage = { web: false, x: false };
	for (const item of response.output ?? []) {
		const t = item.type;
		if (t === "web_search_call" || t === "web_search") usage.web = true;
		if (t === "x_search_call" || t === "x_search") usage.x = true;
	}
	return usage;
}

export type GrokClientToolLoopResult = {
	response: GrokResponsesResponse | null;
	functionRounds: number;
	hitRoundCap: boolean;
	/** Both search tools ran — the bar for concluding anything about a catalyst. */
	sawSearch: boolean;
	sawWebSearch: boolean;
	sawXSearch: boolean;
};

/**
 * Run a Responses request, executing client-side `function_call` items via
 * `previous_response_id` until the model returns a final message or the round cap hits.
 */
export async function fetchGrokResponseWithClientTools(options: {
	requestBody: GrokResponsesRequest;
	logContext: Record<string, unknown>;
	executeFunction: (
		name: string,
		argsJson: string,
		ctx: { sawSearch: boolean; sawWebSearch: boolean; sawXSearch: boolean },
	) => Promise<unknown>;
	maxFunctionRounds: number;
}): Promise<GrokClientToolLoopResult> {
	let body: GrokResponsesRequest = { ...options.requestBody, store: true };
	let sawWebSearch = false;
	let sawXSearch = false;
	let functionRounds = 0;

	const searchState = () => ({
		sawSearch: sawWebSearch && sawXSearch,
		sawWebSearch,
		sawXSearch,
	});

	for (;;) {
		const response = await fetchGrokResponse({
			requestBody: body,
			logContext: options.logContext,
		});
		if (!response) {
			return { response: null, functionRounds, hitRoundCap: false, ...searchState() };
		}
		const usage = collectSearchToolUsage(response);
		sawWebSearch = sawWebSearch || usage.web;
		sawXSearch = sawXSearch || usage.x;

		const calls = collectFunctionCalls(response);
		if (calls.length === 0) {
			return { response, functionRounds, hitRoundCap: false, ...searchState() };
		}

		if (functionRounds >= options.maxFunctionRounds) {
			return { response: null, functionRounds, hitRoundCap: true, ...searchState() };
		}

		functionRounds++;
		const outputs: GrokFunctionCallOutput[] = [];
		for (const call of calls) {
			let output: unknown;
			try {
				output = await options.executeFunction(call.name, call.arguments, searchState());
			} catch (error) {
				output = { error: error instanceof Error ? error.message : String(error) };
			}
			outputs.push({
				type: "function_call_output",
				call_id: call.call_id,
				output: typeof output === "string" ? output : JSON.stringify(output),
			});
		}

		body = {
			model: options.requestBody.model,
			instructions: options.requestBody.instructions,
			input: outputs,
			previous_response_id: response.id,
			tools: options.requestBody.tools,
			text: options.requestBody.text,
			temperature: options.requestBody.temperature,
			max_output_tokens: options.requestBody.max_output_tokens,
			reasoning_effort: options.requestBody.reasoning_effort,
			store: true,
		};
	}
}
