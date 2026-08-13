import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IntradayBarsResult } from "../../../../src/lib/types";

const fetchGrokResponse = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/lib/vendors/grok", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/vendors/grok")>();
	return {
		...actual,
		fetchGrokResponse,
	};
});

// The x_search window walks the US market calendar; keep it off the network.
vi.mock("../../../../src/lib/time/market/calendar", () => ({
	getUsMarketClosureInfoForInstant: vi.fn(async () => null),
}));

const executeGetQuotes = vi.hoisted(() => vi.fn(async () => ({ quotes: {} })));
vi.mock(
	"../../../../src/lib/market-notifications/flat-alerts/why-quotes",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("../../../../src/lib/market-notifications/flat-alerts/why-quotes")
			>();
		return { ...actual, executeGetQuotes };
	},
);

import {
	classifyContinuityAfterSearch,
	GROK_WHY_TEXT_FORMAT,
	generatePriceMoveWhyWithGrok,
} from "../../../../src/lib/market-notifications/flat-alerts/why";
import { GET_QUOTES_FUNCTION_TOOL } from "../../../../src/lib/market-notifications/flat-alerts/why-quotes";

const bars: IntradayBarsResult = {
	closes: [100, 106],
	timestamps: [Date.parse("2026-08-12T14:30:00Z"), Date.parse("2026-08-12T14:55:00Z")],
	startTimestamp: Date.parse("2026-08-12T14:30:00Z"),
	endTimestamp: Date.parse("2026-08-12T14:55:00Z"),
	candles: [
		{ o: 100, h: 101, l: 99, c: 100, t: Date.parse("2026-08-12T14:30:00Z") },
		{ o: 100, h: 107, l: 100, c: 106, t: Date.parse("2026-08-12T14:55:00Z") },
	],
};

function packet(overrides: Record<string, unknown> = {}) {
	return {
		lede: "Apple rose after a stronger-than-expected iPhone report [CNBC](https://www.cnbc.com/example).",
		grade: "reported",
		catalyst_type: "earnings",
		event_date: "2026-08-12",
		key_entity: "Apple",
		claims: [
			{
				text: "iPhone report beat estimates",
				source_url: "https://www.cnbc.com/example",
				publish_time: "2026-08-12T13:00:00Z",
			},
		],
		...overrides,
	};
}

function whyResponse(
	body: Record<string, unknown>,
	outputTypes: string[] = ["web_search_call", "x_search_call"],
) {
	return {
		id: "r1",
		object: "response",
		created_at: 1,
		model: "grok-4.3",
		status: "completed",
		output_text: JSON.stringify(body),
		output: outputTypes.map((type) => ({ type })),
	};
}

function functionCallResponse(outputTypes: string[] = ["web_search_call", "x_search_call"]) {
	return {
		id: "r-fn",
		object: "response",
		created_at: 1,
		model: "grok-4.3",
		status: "completed",
		output: [
			...outputTypes.map((type) => ({ type })),
			{
				type: "function_call",
				call_id: "c1",
				name: "get_quotes",
				arguments: '{"symbols":["SPY"]}',
			},
		],
	};
}

const baseOpts = {
	symbol: "AAPL",
	companyName: "Apple Inc.",
	triggerPercent: 5.2,
	isAcceleration: false,
	intraday: bars,
	prior: null,
};

describe("generatePriceMoveWhyWithGrok", () => {
	beforeEach(() => {
		fetchGrokResponse.mockReset();
	});

	it("returns grok_null when Grok fails", async () => {
		fetchGrokResponse.mockResolvedValue(null);
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result).toEqual({ ok: false, reason: "grok_null" });
	});

	it("calls grok with dated x_search, get_quotes, identity names, and no prior why", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet()));

		const result = await generatePriceMoveWhyWithGrok(baseOpts);

		expect(result.ok).toBe(true);
		expect(fetchGrokResponse).toHaveBeenCalledOnce();
		const body = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody;
		expect(body.max_output_tokens).toBe(1500);
		expect(body.tools).toEqual([
			{ type: "web_search" },
			expect.objectContaining({
				type: "x_search",
				from_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
				to_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
			}),
			GET_QUOTES_FUNCTION_TOOL,
		]);
		expect(body.text).toEqual({ format: GROK_WHY_TEXT_FORMAT });
		expect(body.input).toContain("Issuer identity names for search");
		expect(body.input).toContain("Apple Inc.");
		expect(body.input).not.toContain("Prior why");
		expect(body.input).toContain("Move onset");
		if (result.ok) {
			expect(result.verdict).toBe("new");
			expect(result.text).toContain("Apple rose");
			expect(result.packet.claims).toHaveLength(1);
			expect(result.packet.retrieval_version).toBe("why-toolkit-v1");
		}
	});

	it("states the fixed 5% magnitude and whether this print is a first or an acceleration", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet()));

		await generatePriceMoveWhyWithGrok(baseOpts);
		const firstPrint = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody?.input as string;
		expect(firstPrint).toContain("first print");
		expect(firstPrint).toContain("Alert magnitude is 5% for every alert.");

		fetchGrokResponse.mockClear();
		await generatePriceMoveWhyWithGrok({
			...baseOpts,
			triggerPercent: 2.6,
			isAcceleration: true,
			accelPercent: 2.6,
			sessionPercent: 7.8,
		});
		const accel = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody?.input as string;
		expect(accel).toContain("acceleration");
		expect(accel).toContain("Alert magnitude is 5% for every alert.");
		expect(accel).toContain("Additional move since last alert: 2.6%.");
		expect(accel).toContain("Session move vs previous close: 7.8%.");
	});

	it("never seeds peers, sector proxies, or a canned peer line", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet()));
		await generatePriceMoveWhyWithGrok(baseOpts);
		const body = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody;
		const prompt = `${body.instructions}\n${body.input}`;
		expect(prompt).not.toMatch(/\bSPY\b|\bXLK\b|\bQQQ\b/);
		expect(prompt).toContain("do not fish for peers");
		expect(prompt).toContain("never a canned peer list");
	});

	it("omits why when search tools never ran", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet(), ["message"]));
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result).toEqual({ ok: false, reason: "no_tool_calls" });
	});

	it("omits why when only one of the two search tools ran", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet(), ["web_search_call"]));
		expect(await generatePriceMoveWhyWithGrok(baseOpts)).toEqual({
			ok: false,
			reason: "no_tool_calls",
		});

		fetchGrokResponse.mockResolvedValue(whyResponse(packet(), ["x_search_call"]));
		expect(await generatePriceMoveWhyWithGrok(baseOpts)).toEqual({
			ok: false,
			reason: "no_tool_calls",
		});
	});

	it("omits why (never hedges) when get_quotes rounds hit the cap", async () => {
		fetchGrokResponse.mockResolvedValue(functionCallResponse());
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result).toEqual({ ok: false, reason: "quote_loop_cap" });
	});

	it("strips grade tokens the model leaked into the lede", async () => {
		fetchGrokResponse.mockResolvedValue(
			whyResponse(
				packet({
					lede: "Confirmed: Apple filed an 8-K naming a new CFO [CNBC](https://www.cnbc.com/example).",
					grade: "confirmed",
				}),
			),
		);
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.text.startsWith("Apple filed an 8-K")).toBe(true);
			expect(result.text.toLowerCase()).not.toContain("confirmed");
			expect(result.packet.lede.toLowerCase()).not.toContain("confirmed");
			expect(result.packet.grade).toBe("confirmed");
		}
	});

	it("omits why on empty lede instead of coercing a hedge", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse(packet({ lede: "", grade: "unexplained" })));
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result).toEqual({ ok: false, reason: "empty_lede" });
	});

	it("omits why when bars have no onset", async () => {
		const result = await generatePriceMoveWhyWithGrok({
			...baseOpts,
			intraday: {
				closes: [100, 106],
				timestamps: null,
				startTimestamp: null,
				endTimestamp: null,
				candles: null,
			},
		});
		expect(result).toEqual({ ok: false, reason: "bars_failed" });
		expect(fetchGrokResponse).not.toHaveBeenCalled();
	});

	it("classifies continuity after search from structured fields, not prior blurb", async () => {
		fetchGrokResponse.mockResolvedValue(
			whyResponse(
				packet({
					lede: "Guidance optimism remains the driver [Bloomberg](https://www.bloomberg.com/example).",
					grade: "reported",
					catalyst_type: "guidance",
					event_date: "2026-08-12",
					key_entity: "Apple",
				}),
			),
		);

		const result = await generatePriceMoveWhyWithGrok({
			...baseOpts,
			triggerPercent: 2.6,
			isAcceleration: true,
			accelPercent: 2.6,
			prior: {
				summary: "Guidance optimism after the overnight raise.",
				verdict: "new",
				grade: "reported",
				catalystType: "guidance",
				eventDate: "2026-08-12",
				keyEntity: "Apple",
			},
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.verdict).toBe("same");
			expect(result.text.startsWith("Still the same story:")).toBe(true);
		}
		const input = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody?.input as string;
		expect(input).not.toContain("Guidance optimism after the overnight raise");
	});

	it("fail-opens when JSON is missing", async () => {
		fetchGrokResponse.mockResolvedValue({
			id: "r4",
			object: "response",
			created_at: 1,
			model: "grok-4.3",
			status: "completed",
			output_text: "not json",
			output: [{ type: "web_search_call" }, { type: "x_search_call" }],
		});
		const result = await generatePriceMoveWhyWithGrok(baseOpts);
		expect(result).toEqual({ ok: false, reason: "parse_failed" });
	});
});

describe("classifyContinuityAfterSearch", () => {
	it("returns new when there is no prior", () => {
		expect(
			classifyContinuityAfterSearch({
				hadPrior: false,
				priorCatalystType: null,
				priorEventDate: null,
				priorKeyEntity: null,
				grade: "reported",
				catalystType: "earnings",
				eventDate: "2026-08-12",
				keyEntity: "Apple",
			}),
		).toBe("new");
	});

	it("returns unknown for unexplained", () => {
		expect(
			classifyContinuityAfterSearch({
				hadPrior: true,
				priorCatalystType: "earnings",
				priorEventDate: "2026-08-12",
				priorKeyEntity: "Apple",
				grade: "unexplained",
				catalystType: "",
				eventDate: null,
				keyEntity: null,
			}),
		).toBe("unknown");
	});
});

describe("GROK_WHY_TEXT_FORMAT", () => {
	it("does not embed issuer-specific prompt literals", () => {
		const blob = JSON.stringify(GROK_WHY_TEXT_FORMAT);
		expect(blob).not.toMatch(/Grok|SpaceXAI|xAI/i);
	});
});
