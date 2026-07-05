import { afterEach, describe, expect, it, vi } from "vitest";
import {
	generateNewsWithGrok,
	generateRumorsWithGrok,
} from "../../../src/lib/daily-digest/grok-sections";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function mockXaiResponse(text: string): Response {
	return new Response(
		JSON.stringify({
			id: "test-resp",
			object: "response",
			created_at: 1779000000,
			model: "grok-4.20-0309-non-reasoning",
			status: "completed",
			output: [
				{
					type: "message",
					content: [{ type: "output_text", text, annotations: [] }],
				},
			],
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("Grok digest parsers strip stray markdown bold", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("daily-digest news: a non-reasoning model that wraps each bullet in **…** renders as plain ticker-prefixed lines", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const newsBody =
			"**LDOS: Leidos benefits from the Pentagon's accelerating shift toward AI-driven systems.**\n" +
			"**BAH: Booz Allen Hamilton is positioned to gain from the Pentagon's AI pivot.**";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse(newsBody));

		const result = await generateNewsWithGrok({
			tickers: ["LDOS", "BAH"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result).not.toBeNull();
		expect(result?.content).not.toContain("**");
		expect(result?.content).toContain("LDOS: Leidos benefits");
		expect(result?.content).toContain("BAH: Booz Allen");
	});

	it("daily-digest rumors: stripped output preserves @handle mentions and hedge phrasing", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const rumorsBody =
			"**AAPL: Chatter from @TechBullish about Siri delays, reportedly pressuring shares.**\n" +
			"**NVDA: @ChipAnalyst notes unconfirmed UBS price-target hike ahead of earnings.**";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse(rumorsBody));

		const result = await generateRumorsWithGrok({
			tickers: ["AAPL", "NVDA"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result).not.toBeNull();
		expect(result?.content).not.toContain("**");
		expect(result?.content).toContain("@TechBullish");
		expect(result?.content).toContain("reportedly");
	});
});
