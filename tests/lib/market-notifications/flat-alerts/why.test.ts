import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchGrokResponse = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/lib/vendors/grok", () => ({
	fetchGrokResponse,
}));

import {
	generatePriceMoveWhyWithGrok,
	parsePriceMoveWhyVerdict,
	stripVerdictMarker,
} from "../../../../src/lib/market-notifications/flat-alerts/why";

describe("parsePriceMoveWhyVerdict / stripVerdictMarker", () => {
	it("parses a structured VERDICT line", () => {
		expect(parsePriceMoveWhyVerdict("VERDICT: updated\nShares rose on guidance.")).toBe("updated");
		expect(stripVerdictMarker("VERDICT: updated\nShares rose on guidance.")).toBe(
			"Shares rose on guidance.",
		);
	});

	it("defaults to unknown when no marker is present", () => {
		expect(parsePriceMoveWhyVerdict("Something moved for unclear reasons.")).toBe("unknown");
	});
});

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

	it("calls grok-4.3 with low reasoning and both search tools", async () => {
		fetchGrokResponse.mockResolvedValue({
			id: "r1",
			object: "response",
			created_at: 1,
			model: "grok-4.3",
			status: "completed",
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "VERDICT: new\nApple rose after a stronger-than-expected iPhone report [CNBC](https://www.cnbc.com/example).",
						},
					],
				},
			],
		});

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
		});
		expect(result?.verdict).toBe("new");
		expect(result?.text).toContain("Apple rose");
		expect(result?.text).not.toMatch(/^VERDICT:/i);
	});

	it("classifies continuity against a prior why and adds a same-story lead-in", async () => {
		fetchGrokResponse.mockResolvedValue({
			id: "r2",
			object: "response",
			created_at: 1,
			model: "grok-4.3",
			status: "completed",
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: "VERDICT: same\nGuidance optimism remains the driver [Bloomberg](https://www.bloomberg.com/example).",
						},
					],
				},
			],
		});

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
		fetchGrokResponse.mockResolvedValue({
			id: "r3",
			object: "response",
			created_at: 1,
			model: "grok-4.3",
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text: "VERDICT: unknown\n" }],
				},
			],
		});

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
});
