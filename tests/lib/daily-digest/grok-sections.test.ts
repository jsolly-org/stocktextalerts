import { afterEach, describe, expect, it, vi } from "vitest";
import {
	GROK_DIGEST_TEXT_FORMAT,
	generateNewsWithGrok,
	generateRumorsWithGrok,
	omitEmptyTickerSnippets,
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
		vi.stubEnv("XAI_API_KEY_STOCKTEXTALERTS", "test-key");
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
		vi.stubEnv("XAI_API_KEY_STOCKTEXTALERTS", "test-key");
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
		vi.stubEnv("XAI_API_KEY_STOCKTEXTALERTS", "test-key");
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
		vi.stubEnv("XAI_API_KEY_STOCKTEXTALERTS", "test-key");
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

	it("news and rumors prompts forbid empty-ticker filler instead of covering every symbol", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(mockXaiResponse("GOOGL: ok"));

		await generateNewsWithGrok({
			tickers: ["GOOGL"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});
		await generateRumorsWithGrok({
			tickers: ["GOOGL"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		const newsInput = String(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? "{}")).input);
		const rumorsInput = String(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body ?? "{}")).input);
		for (const input of [newsInput, rumorsInput]) {
			expect(input).toContain("omit them entirely");
			expect(input).toContain("Never write filler");
			expect(input).toContain("No noteworthy chatter found");
		}
	});
});

describe("omitEmptyTickerSnippets drops nothing-found digest bullets", () => {
	it("keeps real ticker items and drops empty filler lines from the screenshot pattern", () => {
		const markdown = [
			"ACN: Accenture CEO urging staff to skip PTO in August [@shortsqueeznews](https://x.com/shortsqueeznews/status/1).",
			"BAH: No noteworthy chatter found.",
			"LDOS: No noteworthy chatter found.",
			"PLTR: Unconfirmed reports of ARK trimming holdings after earnings [@Azunta66](https://x.com/Azunta66/status/2).",
			"DELL: No noteworthy rumors or unconfirmed reports surfaced.",
			"NVDA: Reports of Nvidia providing credit support for OpenAI [Reuters](https://www.reuters.com/nvda).",
		].join("\n");

		const kept = omitEmptyTickerSnippets(markdown);
		expect(kept).toContain("ACN:");
		expect(kept).toContain("PLTR:");
		expect(kept).toContain("NVDA:");
		expect(kept).not.toContain("BAH:");
		expect(kept).not.toContain("LDOS:");
		expect(kept).not.toContain("DELL:");
		expect(kept).not.toContain("No noteworthy chatter found");
		expect(kept).not.toContain("No noteworthy rumors");
	});

	it("drops other empty phrasings and blank ticker bodies", () => {
		const markdown = [
			"AAPL: No news found.",
			"MSFT: Nothing to report.",
			"GOOG: No significant news.",
			"IBM:",
			"ORCL: None found.",
			"TSLA: Chatter about a robotaxi delay [@elonmusk](https://x.com/elonmusk/status/3).",
		].join("\n");

		expect(omitEmptyTickerSnippets(markdown)).toBe(
			"TSLA: Chatter about a robotaxi delay [@elonmusk](https://x.com/elonmusk/status/3).",
		);
	});

	it("keeps real items that mention an absence as one clause among others", () => {
		const markdown =
			"AAPL: No noteworthy Q2 beat, but the CEO guided up after services grew [CNBC](https://www.cnbc.com/aapl).";
		expect(omitEmptyTickerSnippets(markdown)).toBe(markdown);
	});

	it("returns an empty string when every ticker is filler", () => {
		expect(omitEmptyTickerSnippets("BAH: No noteworthy chatter found.\nLDOS: No news found.")).toBe(
			"",
		);
	});

	it("strips leading list markers before classifying ticker lines", () => {
		const markdown =
			"- BAH: No noteworthy chatter found.\n- AAPL: Apple unveiled a modem [CNBC](https://www.cnbc.com/aapl).";
		expect(omitEmptyTickerSnippets(markdown)).toBe(
			"AAPL: Apple unveiled a modem [CNBC](https://www.cnbc.com/aapl).",
		);
	});

	it("strips numbered and indented prefixes so filler tickers are not glued onto the previous item", () => {
		const markdown = [
			"  1. AAPL: Apple fell after an FTC inquiry [CNBC](https://www.cnbc.com/aapl).",
			"  2. BAH: No noteworthy chatter found.",
			"\tLDOS: No news found.",
		].join("\n");
		expect(omitEmptyTickerSnippets(markdown)).toBe(
			"AAPL: Apple fell after an FTC inquiry [CNBC](https://www.cnbc.com/aapl).",
		);
	});

	it("drops filler and citation-only bodies after stripping markdown links", () => {
		const markdown = [
			"BAH: No noteworthy chatter found [Source](https://x.com/x/status/1).",
			"IBM: [CNBC](https://www.cnbc.com/x).",
			"TSLA: Chatter about a robotaxi delay [@elonmusk](https://x.com/elonmusk/status/3).",
		].join("\n");
		expect(omitEmptyTickerSnippets(markdown)).toBe(
			"TSLA: Chatter about a robotaxi delay [@elonmusk](https://x.com/elonmusk/status/3).",
		);
	});
});

describe("Grok digest generation omits empty ticker sections", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("filters filler tickers out of a mixed news response", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			mockXaiResponse(
				"AAPL: Apple fell after an FTC inquiry [CNBC](https://www.cnbc.com/aapl).\nBAH: No noteworthy chatter found.",
			),
		);

		const result = await generateNewsWithGrok({
			tickers: ["AAPL", "BAH"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result?.content).toContain("AAPL:");
		expect(result?.content).not.toContain("BAH:");
	});

	it("returns null when rumors are only empty filler", async () => {
		vi.stubEnv("XAI_API_KEY", "test-key");
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			mockXaiResponse(
				"BAH: No noteworthy chatter found.\nDELL: No noteworthy rumors or unconfirmed reports surfaced.",
			),
		);

		const result = await generateRumorsWithGrok({
			tickers: ["BAH", "DELL"],
			localDateIso: "2026-05-22",
			timezone: "America/New_York",
		});

		expect(result).toBeNull();
	});
});
