import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GrokResponsesResponse } from "../../../src/lib/vendors/grok";

const fetchGrokResponse = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/vendors/grok", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/lib/vendors/grok")>();
	return { ...actual, fetchGrokResponse };
});

import {
	collectFunctionCalls,
	collectSearchToolUsage,
	fetchGrokResponseWithClientTools,
} from "../../../src/lib/vendors/grok-tool-loop";

function item(
	type: string,
	extra: Record<string, unknown> = {},
): GrokResponsesResponse["output"][number] {
	return { type, ...extra };
}

function response(
	outputTypes: string[],
	extra: Record<string, unknown>[] = [],
): GrokResponsesResponse {
	return {
		id: "r",
		object: "response",
		created_at: 1,
		model: "grok",
		status: "completed",
		output: [...outputTypes.map((type) => item(type)), ...extra],
	} as GrokResponsesResponse;
}

describe("collectSearchToolUsage", () => {
	it("reports web and x search calls independently", () => {
		expect(collectSearchToolUsage(response(["web_search_call"]))).toEqual({ web: true, x: false });
		expect(collectSearchToolUsage(response(["x_search_call"]))).toEqual({ web: false, x: true });
		expect(collectSearchToolUsage(response(["web_search_call", "x_search_call"]))).toEqual({
			web: true,
			x: true,
		});
		expect(collectSearchToolUsage(response(["message"]))).toEqual({ web: false, x: false });
	});
});

describe("collectFunctionCalls", () => {
	it("reads function_call items", () => {
		const calls = collectFunctionCalls(
			response(
				[],
				[
					{
						type: "function_call",
						call_id: "c1",
						name: "get_quotes",
						arguments: '{"symbols":["SMCI"]}',
					},
				],
			),
		);
		expect(calls).toEqual([
			{ call_id: "c1", name: "get_quotes", arguments: '{"symbols":["SMCI"]}' },
		]);
	});
});

describe("fetchGrokResponseWithClientTools search gating", () => {
	beforeEach(() => {
		fetchGrokResponse.mockReset();
	});

	const requestBody = { model: "grok", instructions: "s", input: "u" };

	it("only reports sawSearch once BOTH search tools have run", async () => {
		fetchGrokResponse.mockResolvedValue(response(["web_search_call", "message"]));
		const webOnly = await fetchGrokResponseWithClientTools({
			requestBody,
			logContext: {},
			maxFunctionRounds: 2,
			executeFunction: async () => ({}),
		});
		expect(webOnly.sawWebSearch).toBe(true);
		expect(webOnly.sawXSearch).toBe(false);
		expect(webOnly.sawSearch).toBe(false);

		fetchGrokResponse.mockResolvedValue(response(["web_search_call", "x_search_call", "message"]));
		const both = await fetchGrokResponseWithClientTools({
			requestBody,
			logContext: {},
			maxFunctionRounds: 2,
			executeFunction: async () => ({}),
		});
		expect(both.sawSearch).toBe(true);
	});

	it("accumulates search usage across rounds and reports the round cap", async () => {
		const call = {
			type: "function_call",
			call_id: "c1",
			name: "get_quotes",
			arguments: "{}",
		};
		fetchGrokResponse
			.mockResolvedValueOnce(response(["web_search_call"], [call]))
			.mockResolvedValueOnce(response(["x_search_call"], [call]))
			.mockResolvedValueOnce(response([], [call]));

		const seenCtx: { sawSearch: boolean }[] = [];
		const result = await fetchGrokResponseWithClientTools({
			requestBody,
			logContext: {},
			maxFunctionRounds: 2,
			executeFunction: async (_name, _args, ctx) => {
				seenCtx.push({ sawSearch: ctx.sawSearch });
				return {};
			},
		});

		expect(seenCtx.map((c) => c.sawSearch)).toEqual([false, true]);
		expect(result.hitRoundCap).toBe(true);
		expect(result.response).toBeNull();
		expect(result.sawSearch).toBe(true);
	});
});
