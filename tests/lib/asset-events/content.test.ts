import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildAssetEventsContent,
	buildAssetEventsContentForChannels,
} from "../../../src/lib/asset-events/content";
import { fetchFinnhubExtras } from "../../../src/lib/providers/finnhub";
import { makeUserRecord as makeUser } from "../../helpers/user-record-fixture";

vi.mock("../../../src/lib/providers/finnhub", async () => {
	const actual = await vi.importActual("../../../src/lib/providers/finnhub");
	return {
		...actual,
		fetchFinnhubExtras: vi.fn(),
	};
});

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

function createAssetEventsSupabase(
	calendarEvents: CalendarEventRow[],
	marketEvents: MarketEventRow[],
) {
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

describe("buildAssetEventsContent", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("includes IPO content even when user has no tracked assets", async () => {
		const supabase = createAssetEventsSupabase(
			[
				{
					symbol: "AAPL",
					event_type: "earnings",
					event_date: "2026-02-11",
					data: {},
				},
			],
			[
				{
					symbol: "ACME",
					event_type: "ipo",
					event_date: "2026-02-11",
					data: { issuerName: "Acme Corp" },
				},
			],
		);
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map(),
			insider: new Map(),
			analystFetchSucceeded: false,
		});

		const result = await buildAssetEventsContent({
			user: makeUser({ asset_events_include_ipo_email: true }),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: [],
			channel: "email",
		});

		expect(result.hasAnyContent).toBe(true);
		expect(result.eventsSection?.ipos).toContain("ACME: IPO tomorrow");
		expect(result.eventsSection?.earnings).toBeNull();
		expect(vi.mocked(fetchFinnhubExtras)).not.toHaveBeenCalled();
	});

	it("calls fetchFinnhubExtras once when email and SMS insider are both enabled", async () => {
		const supabase = createAssetEventsSupabase([], []);
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map(),
			insider: new Map([
				["AAPL", []],
				["MSFT", []],
			]),
			analystFetchSucceeded: false,
		});

		await buildAssetEventsContentForChannels({
			user: makeUser({
				asset_events_include_insider_email: true,
				asset_events_include_insider_sms: true,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL", "MSFT"],
			channels: ["email", "sms"],
		});

		expect(vi.mocked(fetchFinnhubExtras)).toHaveBeenCalledOnce();
		expect(vi.mocked(fetchFinnhubExtras)).toHaveBeenCalledWith(["AAPL", "MSFT"], {
			includeNews: false,
			includeAnalyst: false,
			includeInsider: true,
		});
	});

	it("formats insider only on the channel that opted in", async () => {
		const supabase = createAssetEventsSupabase([], []);
		const insiderTx = [
			{
				name: "Jane Doe",
				share: 1000,
				change: 500,
				transactionType: "P",
				transactionDate: "2026-02-10",
			},
		];
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map(),
			insider: new Map([["AAPL", insiderTx]]),
			analystFetchSucceeded: false,
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				asset_events_include_insider_email: true,
				asset_events_include_insider_sms: false,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL"],
			channels: ["email", "sms"],
		});

		expect(result.email?.insiderSection).toContain("AAPL");
		expect(result.sms?.insiderSection).toBeNull();
		expect(result.sms?.hasAnyContent).toBe(false);
	});

	it("sets shouldUpdateAnalystMonth when analyst fetch succeeds with no formatted section", async () => {
		const supabase = createAssetEventsSupabase([], []);
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map([["AAPL", null]]),
			insider: new Map(),
			analystFetchSucceeded: true,
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				asset_events_include_analyst_email: true,
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

	it("does not set shouldUpdateAnalystMonth when analyst fetch exhausts retries", async () => {
		const supabase = createAssetEventsSupabase([], []);
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map([["AAPL", null]]),
			insider: new Map(),
			analystFetchSucceeded: false,
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				asset_events_include_analyst_email: true,
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

	it("sets shouldUpdateAnalystMonth when at least one symbol analyst fetch succeeds", async () => {
		const supabase = createAssetEventsSupabase([], []);
		vi.mocked(fetchFinnhubExtras).mockResolvedValue({
			news: new Map(),
			analyst: new Map([
				["AAPL", null],
				["MSFT", null],
			]),
			insider: new Map(),
			analystFetchSucceeded: true,
		});

		const result = await buildAssetEventsContentForChannels({
			user: makeUser({
				asset_events_include_analyst_email: true,
				asset_events_last_analyst_sent_month: null,
			}),
			supabase: supabase as never,
			logger: logger as never,
			localDate: "2026-02-10",
			tickers: ["AAPL", "MSFT"],
			channels: ["email"],
		});

		expect(result.shouldUpdateAnalystMonth).toBe(true);
	});
});
