import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchGrokResponse = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/lib/vendors/grok", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../../src/lib/vendors/grok")>();
	return {
		...actual,
		fetchGrokResponse,
	};
});

import {
	GROK_WHY_TEXT_FORMAT,
	generatePriceMoveWhyWithGrok,
} from "../../../../src/lib/market-notifications/flat-alerts/why";

function whyResponse(verdict: string, why: string) {
	return {
		id: "r1",
		object: "response",
		created_at: 1,
		model: "grok-4.3",
		status: "completed",
		output_text: JSON.stringify({ verdict, why }),
		output: [],
	};
}

describe("generatePriceMoveWhyWithGrok", () => {
	beforeEach(() => {
		fetchGrokResponse.mockReset();
	});

	it("returns null when Grok fails", async () => {
		fetchGrokResponse.mockResolvedValue(null);
		const result = await generatePriceMoveWhyWithGrok({
			symbol: "AAPL",
			companyName: "Apple Inc.",
			triggerPercent: 3.2,
			isAcceleration: false,
			priorWhySummary: null,
			priorWhyVerdict: null,
		});
		expect(result).toBeNull();
	});

	it("calls grok-4.3 with text.format schema, low reasoning, and both search tools", async () => {
		fetchGrokResponse.mockResolvedValue(
			whyResponse(
				"new",
				"Apple rose after a stronger-than-expected iPhone report [CNBC](https://www.cnbc.com/example).",
			),
		);

		const result = await generatePriceMoveWhyWithGrok({
			symbol: "AAPL",
			companyName: "Apple Inc.",
			triggerPercent: 3.2,
			isAcceleration: false,
			priorWhySummary: null,
			priorWhyVerdict: null,
		});

		expect(fetchGrokResponse).toHaveBeenCalledOnce();
		const body = fetchGrokResponse.mock.calls[0]?.[0]?.requestBody;
		expect(body).toMatchObject({
			model: "grok-4.3",
			reasoning_effort: "low",
			temperature: 0.3,
			max_output_tokens: 200,
			tools: [{ type: "web_search" }, { type: "x_search" }],
			text: { format: GROK_WHY_TEXT_FORMAT },
		});
		expect(result?.verdict).toBe("new");
		expect(result?.text).toContain("Apple rose");
		expect(result?.text).not.toMatch(/^VERDICT:/i);
	});

	it("classifies continuity against a prior why and adds a same-story lead-in", async () => {
		fetchGrokResponse.mockResolvedValue(
			whyResponse(
				"same",
				"Guidance optimism remains the driver [Bloomberg](https://www.bloomberg.com/example).",
			),
		);

		const result = await generatePriceMoveWhyWithGrok({
			symbol: "AAPL",
			triggerPercent: 1.6,
			isAcceleration: true,
			priorWhySummary: "Guidance optimism after the overnight raise.",
			priorWhyVerdict: "new",
		});

		expect(result?.verdict).toBe("same");
		expect(result?.text.startsWith("Still the same story:")).toBe(true);
	});

	it("uses the unknown hedge when the model has no catalyst", async () => {
		fetchGrokResponse.mockResolvedValue(whyResponse("unknown", ""));

		const result = await generatePriceMoveWhyWithGrok({
			symbol: "AAPL",
			triggerPercent: -2.1,
			isAcceleration: false,
			priorWhySummary: null,
			priorWhyVerdict: null,
		});

		expect(result?.verdict).toBe("unknown");
		expect(result?.text).toBe("No clear catalyst on the wire.");
	});

	it("fail-opens null when JSON is missing", async () => {
		fetchGrokResponse.mockResolvedValue({
			id: "r4",
			object: "response",
			created_at: 1,
			model: "grok-4.3",
			status: "completed",
			output_text: "not json",
			output: [],
		});
		const result = await generatePriceMoveWhyWithGrok({
			symbol: "AAPL",
			triggerPercent: 1,
			isAcceleration: false,
			priorWhySummary: null,
			priorWhyVerdict: null,
		});
		expect(result).toBeNull();
	});
});
