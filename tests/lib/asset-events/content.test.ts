import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssetEventsContent } from "../../../src/lib/asset-events/content";
import type { UserRecord } from "../../../src/lib/messaging/types";
import { fetchFinnhubExtras } from "../../../src/lib/providers/finnhub";

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

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return {
		id: "user-1",
		email: "test@example.com",
		phone_country_code: "1",
		phone_number: "5551112222",
		phone_verified: false,
		timezone: "UTC",
		market_scheduled_asset_price_next_send_at: null,
		email_notifications_enabled: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		market_scheduled_asset_price_enabled: false,
		market_scheduled_asset_price_include_email: false,
		market_scheduled_asset_price_include_sms: false,
		market_scheduled_asset_price_times: null,
		daily_digest_time: null,
		daily_digest_next_send_at: null,
		asset_events_include_calendar_email: false,
		asset_events_include_calendar_sms: false,
		asset_events_include_ipo_email: false,
		asset_events_include_ipo_sms: false,
		asset_events_include_analyst_email: false,
		asset_events_include_analyst_sms: false,
		asset_events_include_insider_email: false,
		asset_events_include_insider_sms: false,
		asset_events_next_send_at: null,
		asset_events_last_analyst_sent_month: null,
		daily_digest_include_news_email: false,
		daily_digest_include_rumors_email: false,
		last_grok_rumors_at: null,
		grok_window_start: null,
		grok_sends_in_window: 0,
		...overrides,
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
			news: [],
			analyst: [],
			insider: [],
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
});
