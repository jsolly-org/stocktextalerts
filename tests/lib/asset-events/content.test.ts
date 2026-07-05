import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAssetEventsContent,
	buildAssetEventsContentForChannels,
} from "../../../src/lib/asset-events/content";
import { makePrefRows, makeUserRecord as makeUser } from "../../helpers/user-record-fixture";

type CalendarEventRow = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split";
	event_date: string;
	data: Record<string, unknown> | null;
};

type MarketEventRow = {
	symbol: string;
	event_type: string;
	event_date: string;
	data: Record<string, unknown> | null;
};

type AnalystConsensusRow = {
	symbol: string;
	period: string | null;
	buy: number | null;
	hold: number | null;
	sell: number | null;
	strong_buy: number | null;
	strong_sell: number | null;
	fetch_succeeded: boolean;
	fetched_at: string;
};

type InsiderTransactionRow = {
	symbol: string;
	transaction_date: string;
	name: string;
	share: number;
	change: number;
	transaction_type: string;
};

function createAssetEventsSupabase(options: {
	calendarEvents?: CalendarEventRow[];
	marketEvents?: MarketEventRow[];
	analystConsensus?: AnalystConsensusRow[];
	insiderTransactions?: InsiderTransactionRow[];
}) {
	const calendarEvents = options.calendarEvents ?? [];
	const marketEvents = options.marketEvents ?? [];
	const analystConsensus = options.analystConsensus ?? [];
	const insiderTransactions = options.insiderTransactions ?? [];

	return {
		from(table: string) {
			if (table === "asset_events") {
				return buildQueryChain(calendarEvents, (row, filters) => {
					if (filters.eventTypeIn && !filters.eventTypeIn.includes(row.event_type)) return false;
					if (filters.symbolIn && !filters.symbolIn.includes(row.symbol)) return false;
					return true;
				});
			}

			if (table === "market_events") {
				return buildQueryChain(marketEvents, (row, filters) => {
					if (filters.eventTypeEq && row.event_type !== filters.eventTypeEq) return false;
					return true;
				});
			}

			if (table === "asset_analyst_consensus") {
				return {
					select() {
						return {
							in(_column: string, symbols: string[]) {
								const rows = analystConsensus.filter((row) => symbols.includes(row.symbol));
								return Promise.resolve({ data: rows, error: null });
							},
						};
					},
				};
			}

			if (table === "asset_insider_transactions") {
				return {
					select() {
						const query = {
							in(_column: string, symbols: string[]) {
								query.symbolFilter = symbols;
								return query;
							},
							gte(_column: string, cutoff: string) {
								query.cutoff = cutoff;
								return query;
							},
							order() {
								const rows = insiderTransactions.filter((row) => {
									if (query.symbolFilter && !query.symbolFilter.includes(row.symbol)) {
										return false;
									}
									if (query.cutoff && row.transaction_date < query.cutoff) {
										return false;
									}
									return true;
								});
								return Promise.resolve({ data: rows, error: null });
							},
							symbolFilter: undefined as string[] | undefined,
							cutoff: undefined as string | undefined,
						};
						return query;
					},
				};
			}

			throw new Error(`Unexpected table: ${table}`);
		},
	};
}

function buildQueryChain<T extends { event_date: string }>(
	rows: T[],
	filterFn: (
		row: T,
		filters: {
			eventTypeEq?: string;
			eventTypeIn?: string[];
			symbolIn?: string[];
			gteDate?: string;
		},
	) => boolean,
) {
	return {
		select() {
			const filters: {
				eventTypeEq?: string;
				eventTypeIn?: string[];
				symbolIn?: string[];
				gteDate?: string;
			} = {};

			const query = {
				eq(column: string, value: string) {
					if (column === "event_type") filters.eventTypeEq = value;
					return query;
				},
				in(column: string, values: string[]) {
					if (column === "event_type") filters.eventTypeIn = values;
					if (column === "symbol") filters.symbolIn = values;
					return query;
				},
				gte(_column: string, value: string) {
					filters.gteDate = value;
					return query;
				},
				lte(_column: string, value: string) {
					const filtered = rows.filter((row) => {
						if (!filterFn(row, filters)) return false;
						if (filters.gteDate && row.event_date < filters.gteDate) return false;
						if (row.event_date > value) return false;
						return true;
					});
					return Promise.resolve({ data: filtered, error: null });
				},
			};

			return query;
		},
	};
}

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

const freshFetchedAt = new Date().toISOString();

describe("buildAssetEventsContent", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("includes IPO content even when user has no tracked assets", async () => {
		const supabase = createAssetEventsSupabase({
			calendarEvents: [
				{
					symbol: "AAPL",
					event_type: "earnings",
					event_date: "2026-02-11",
					data: {},
				},
			],
			marketEvents: [
				{
					symbol: "ACME",
					event_type: "ipo",
					event_date: "2026-02-11",
					data: { issuerName: "Acme Corp" },
				},
			],
		});

		const result = await buildAssetEventsContent({
			user: makeUser({ prefs: makePrefRows([["daily_notification", "ipo", "email", true]]) }),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: [],
			channel: "email",
		});

		expect(result.hasAnyContent).toBe(true);
		expect(result.eventsSection?.ipos).toContain("ACME: IPO tomorrow");
		expect(result.eventsSection?.earnings).toBeNull();
	});

	it("loads insider from DB for the email channel", async () => {
		const supabase = createAssetEventsSupabase({
			insiderTransactions: [
				{
					symbol: "AAPL",
					transaction_date: "2026-02-10",
					name: "Jane Doe",
					share: 1000,
					change: 500,
					transaction_type: "P",
				},
				{
					symbol: "MSFT",
					transaction_date: "2026-02-10",
					name: "Satya Nadella",
					share: 2000,
					change: -100,
					transaction_type: "S",
				},
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				prefs: makePrefRows([["daily_notification", "insider", "email", true]]),
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL", "MSFT"],
			channels: ["email"],
		});

		expect(result.email?.insiderSection).toContain("AAPL");
		expect(result.email?.insiderSection).toContain("MSFT");
	});

	it("formats insider on the email channel when opted in", async () => {
		const supabase = createAssetEventsSupabase({
			insiderTransactions: [
				{
					symbol: "AAPL",
					transaction_date: "2026-02-10",
					name: "Jane Doe",
					share: 1000,
					change: 500,
					transaction_type: "P",
				},
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				prefs: makePrefRows([["daily_notification", "insider", "email", true]]),
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: ["email"],
		});

		expect(result.email?.insiderSection).toContain("AAPL");
	});

	it("sets shouldUpdateAnalystMonth when analyst fetch succeeded with no formatted section", async () => {
		const supabase = createAssetEventsSupabase({
			analystConsensus: [
				{
					symbol: "AAPL",
					period: null,
					buy: null,
					hold: null,
					sell: null,
					strong_buy: null,
					strong_sell: null,
					fetch_succeeded: true,
					fetched_at: freshFetchedAt,
				},
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				prefs: makePrefRows([["daily_notification", "analyst", "email", true]]),
				asset_events_last_analyst_sent_month: null,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: ["email"],
		});

		expect(result.shouldUpdateAnalystMonth).toBe(true);
		expect(result.email?.analystSection).toBeNull();
	});

	it("does not set shouldUpdateAnalystMonth when analyst data is missing from DB", async () => {
		const supabase = createAssetEventsSupabase({});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				prefs: makePrefRows([["daily_notification", "analyst", "email", true]]),
				asset_events_last_analyst_sent_month: null,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: ["email"],
		});

		expect(result.shouldUpdateAnalystMonth).toBe(false);
	});

	it("sets shouldUpdateAnalystMonth when at least one symbol has fresh analyst data", async () => {
		const supabase = createAssetEventsSupabase({
			analystConsensus: [
				{
					symbol: "MSFT",
					period: "2026-02-01",
					buy: 10,
					hold: 5,
					sell: 1,
					strong_buy: 2,
					strong_sell: 0,
					fetch_succeeded: true,
					fetched_at: freshFetchedAt,
				},
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				prefs: makePrefRows([["daily_notification", "analyst", "email", true]]),
				asset_events_last_analyst_sent_month: null,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL", "MSFT"],
			channels: ["email"],
		});

		expect(result.shouldUpdateAnalystMonth).toBe(true);
		expect(result.email?.analystSection).toContain("MSFT");
	});

	it("omits insider transactions older than the last-day window", async () => {
		const supabase = createAssetEventsSupabase({
			insiderTransactions: [
				{
					symbol: "AAPL",
					transaction_date: "2026-02-08",
					name: "Old Trade",
					share: 100,
					change: 50,
					transaction_type: "P",
				},
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({ prefs: makePrefRows([["daily_notification", "insider", "email", true]]) }),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: ["email"],
		});

		expect(result.email?.insiderSection).toBeNull();
		expect(result.email?.hasAnyContent).toBe(false);
	});
});

describe("buildAssetEventsContentForChannels Telegram facets", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("renders a Telegram block gated by the facet selection — enabled facet present, disabled facet absent", async () => {
		const supabase = createAssetEventsSupabase({
			calendarEvents: [
				{ symbol: "AAPL", event_type: "earnings", event_date: "2026-02-11", data: {} },
			],
			marketEvents: [
				{
					symbol: "ACME",
					event_type: "ipo",
					event_date: "2026-02-11",
					data: { issuerName: "Acme Corp" },
				},
			],
		});

		// Email off entirely (no channels); only the Telegram calendar facet is on.
		const result = await buildAssetEventsContentForChannels({
			user: makeUser(),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: [],
			telegramFacets: { calendar: true, ipo: false, insider: false, analyst: false },
		});

		expect(result.telegram).not.toBeNull();
		expect(result.telegram?.hasAnyContent).toBe(true);
		// Calendar facet on → earnings present.
		expect(result.telegram?.eventsSection?.earnings).toContain("AAPL");
		// IPO facet off → no IPO section, even though an IPO row exists.
		expect(result.telegram?.eventsSection?.ipos ?? null).toBeNull();
		// email untouched (no channels requested).
		expect(result.email).toBeNull();
	});

	it("returns null Telegram content when no Telegram facet is enabled", async () => {
		const supabase = createAssetEventsSupabase({
			calendarEvents: [
				{ symbol: "AAPL", event_type: "earnings", event_date: "2026-02-11", data: {} },
			],
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser(),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: [],
			telegramFacets: { calendar: false, ipo: false, insider: false, analyst: false },
		});

		expect(result.telegram).toBeNull();
	});
});
