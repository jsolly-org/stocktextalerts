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

type AssetEventRow = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split" | "ipo";
	scope: "watchlist" | "global";
	event_date: string;
	data: Record<string, unknown> | null;
};

function createAssetEventsSupabase(events: AssetEventRow[]) {
	return {
		from(table: string) {
			if (table !== "asset_events") {
				throw new Error(`Unexpected table: ${table}`);
			}

			return {
				select() {
					const filters: {
						eventTypeEq?: string;
						eventTypeIn?: string[];
						scopeEq?: string;
						symbolIn?: string[];
						gteDate?: string;
					} = {};

					const query = {
						eq(column: string, value: string) {
							if (column === "event_type") filters.eventTypeEq = value;
							if (column === "scope") filters.scopeEq = value;
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
							const rows = events.filter((row) => {
								if (
									filters.eventTypeEq &&
									row.event_type !== filters.eventTypeEq
								) {
									return false;
								}
								if (filters.scopeEq && row.scope !== filters.scopeEq) {
									return false;
								}
								if (
									filters.eventTypeIn &&
									!filters.eventTypeIn.includes(row.event_type)
								) {
									return false;
								}
								if (
									filters.symbolIn &&
									!filters.symbolIn.includes(row.symbol)
								) {
									return false;
								}
								if (filters.gteDate && row.event_date < filters.gteDate) {
									return false;
								}
								if (row.event_date > value) {
									return false;
								}
								return true;
							});
							return Promise.resolve({ data: rows, error: null });
						},
					};

					return query;
				},
			};
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
		sms_opted_out: false,
		show_sparklines: false,
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
		const supabase = createAssetEventsSupabase([
			{
				symbol: "ACME",
				event_type: "ipo",
				scope: "global",
				event_date: "2026-02-11",
				data: { issuerName: "Acme Corp" },
			},
			{
				symbol: "AAPL",
				event_type: "earnings",
				scope: "watchlist",
				event_date: "2026-02-11",
				data: {},
			},
		]);
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
