import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GROK_DIGEST_TEXT_FORMAT,
	generateNewsWithGrok,
	generateRumorsWithGrok,
} from "../../../src/lib/daily-digest/grok-sections";

vi.mock("node:timers/promises", () => ({
	setTimeout: vi.fn().mockResolvedValue(undefined),
}));

function mockXaiResponse(markdown: string): Response {
	return new Response(
		JSON.stringify({
			id: "test-resp",
			object: "response",
			created_at: 1779000000,
			model: "grok-4.20-0309-non-reasoning",
			status: "completed",
			output_text: JSON.stringify({ markdown }),
			output: [
				{
					type: "message",
					content: [
						{
							type: "output_text",
							text: JSON.stringify({ markdown }),
							annotations: [],
						},
					],
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

	it("daily-digest news: schema-wrapped markdown strips **…** and posts text.format", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const newsBody =
			"**LDOS: Leidos benefits from the Pentagon's accelerating shift toward AI-driven systems.**\n" +
			"**BAH: Booz Allen Hamilton is positioned to gain from the Pentagon's AI pivot.**";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse(newsBody));

		const result = await generateNewsWithGrok({
			tickers: ["LDOS", "BAH"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result).not.toBeNull();
		expect(result?.content).not.toContain("**");
		expect(result?.content).toContain("LDOS: Leidos benefits");
		expect(result?.content).toContain("BAH: Booz Allen");
		const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
		expect(body.text).toEqual({ format: GROK_DIGEST_TEXT_FORMAT });
	});

	it("daily-digest rumors: stripped output preserves @handle mentions and hedge phrasing", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const rumorsBody =
			"**AAPL: Chatter from @TechBullish about Siri delays, reportedly pressuring shares.**\n" +
			"**NVDA: @ChipAnalyst notes unconfirmed UBS price-target hike ahead of earnings.**";
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse(rumorsBody));

		const result = await generateRumorsWithGrok({
			tickers: ["AAPL", "NVDA"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result).not.toBeNull();
		expect(result?.content).not.toContain("**");
		expect(result?.content).toContain("@TechBullish");
		expect(result?.content).toContain("reportedly");
		const rumorsReq = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
		expect(rumorsReq.tools).toEqual([
			{ type: "x_search", from_date: "2026-05-21", to_date: "2026-05-22" },
		]);
	});
});

describe("Grok digest prompts seed search with issuer identity", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	const identities = [
		{ symbol: "GOOGL", companyName: "Alphabet Inc." },
		{ symbol: "SPCX", companyName: "Space Exploration Technologies", aliases: ["SpaceX"] },
	];

	it("news prompt carries identity names and labels Massive headlines incomplete", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse("GOOGL: ok"));

		await generateNewsWithGrok({
			tickers: ["GOOGL", "SPCX"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
			identities,
			providerNewsContext: "GOOGL: Alphabet announces something (Reuters)",
		});

		const input = String(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}")).input ?? "");
		expect(input).toContain("Issuer identity names for search");
		expect(input).toContain("GOOGL: GOOGL, Alphabet Inc., Alphabet, Google");
		expect(input).toContain("SpaceX");
		expect(input).not.toContain("$GOOGL");
		expect(input).toContain("Search the issuer identity names above, not the ticker symbol alone.");
		expect(input).toContain("incomplete / roundup-prone, not a primary source");
	});

	it("rumors prompt carries identity names alongside the dated x_search window", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse("GOOGL: ok"));

		await generateRumorsWithGrok({
			tickers: ["GOOGL", "SPCX"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
			identities,
		});

		const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}"));
		expect(String(body.input)).toContain("Issuer identity names for search");
		expect(String(body.input)).toContain(
			"SPCX: SPCX, Space Exploration Technologies, Space, SpaceX",
		);
		expect(body.tools).toEqual([
			{ type: "x_search", from_date: "2026-05-21", to_date: "2026-05-22" },
		]);
	});
});
