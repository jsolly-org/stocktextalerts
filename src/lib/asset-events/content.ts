import { DateTime } from "luxon";
import type { Logger } from "../logging";
import type { UserRecord } from "../messaging/types";
import {
	fetchFinnhubExtras,
	formatAnalystSection,
	formatInsiderSection,
} from "../providers/finnhub";
import { formatAssetEventsSection } from "../providers/massive";
import type { SupabaseAdminClient } from "../schedule/helpers";

export async function buildAssetEventsContent(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	localDate: string; // YYYY-MM-DD (user's local date)
	tickers: readonly string[];
	channel: "email" | "sms";
}): Promise<{
	eventsSection: {
		earnings: string | null;
		dividends: string | null;
		splits: string | null;
		ipos: string | null;
	} | null;
	insiderSection: string | null;
	analystSection: string | null;
	shouldUpdateAnalystMonth: boolean;
	hasAnyContent: boolean;
}> {
	const { user, supabase, logger, localDate, tickers, channel } = options;

	const nullResult = {
		eventsSection: null,
		insiderSection: null,
		analystSection: null,
		shouldUpdateAnalystMonth: false,
		hasAnyContent: false,
	};

	const localDt = DateTime.fromISO(localDate);
	if (!localDt.isValid) {
		logger.warn("Invalid localDate for asset events content", {
			localDate,
			localDtInvalidReason: localDt.invalidReason,
		});
		return nullResult;
	}
	// "Next 3 days" inclusive: localDate, localDate+1, localDate+2
	const endDate = localDt.plus({ days: 2 }).toISODate() ?? "";
	if (!endDate) {
		logger.warn("Failed to format endDate for asset events content", {
			localDate,
			localDt: localDt.toString(),
			localDtIsValid: localDt.isValid,
		});
		return nullResult;
	}

	const includeCalendar =
		channel === "email"
			? user.asset_events_include_calendar_email
			: user.asset_events_include_calendar_sms;
	const includeIpos =
		channel === "email"
			? user.asset_events_include_ipo_email
			: user.asset_events_include_ipo_sms;

	// Query asset_events table for the relevant date range (pre-populated by weekly cron).
	// Calendar events are watchlist-scoped; IPOs are global for all users.
	const calendarPromise =
		includeCalendar && tickers.length > 0
			? supabase
					.from("asset_events")
					.select("symbol,event_type,event_date,data")
					.in("event_type", ["earnings", "dividend", "split"])
					.in("symbol", [...tickers])
					.gte("event_date", localDate)
					.lte("event_date", endDate)
			: Promise.resolve({ data: [], error: null });
	const ipoPromise = includeIpos
		? supabase
				.from("market_events")
				.select("symbol,event_type,event_date,data")
				.eq("event_type", "ipo")
				.gte("event_date", localDate)
				.lte("event_date", endDate)
		: Promise.resolve({ data: [], error: null });

	const [calendarResult, ipoResult] = await Promise.all([
		calendarPromise,
		ipoPromise,
	]);

	if (calendarResult.error || ipoResult.error) {
		logger.error("Failed to query asset/market events", {
			calendarError: calendarResult.error?.message ?? null,
			ipoError: ipoResult.error?.message ?? null,
		});
	}

	const calendarRows = calendarResult.error ? [] : (calendarResult.data ?? []);
	const ipoRows = ipoResult.error ? [] : (ipoResult.data ?? []);

	const rawEvents = [
		...(calendarRows as Array<{
			symbol: string;
			event_type: "earnings" | "dividend" | "split";
			event_date: string;
			data: Record<string, unknown> | null;
		}>),
		...ipoRows.map((row) => ({
			symbol: row.symbol,
			event_type: "ipo" as const,
			event_date: row.event_date,
			data: row.data as Record<string, unknown>,
		})),
	];

	// Events already filtered at query time via includeCalendar/includeIpos
	const filteredEvents = rawEvents;

	// 4. Compute daysUntil for each event
	const eventsWithDaysUntil = filteredEvents.map((event) => ({
		symbol: event.symbol,
		event_type: event.event_type,
		event_date: event.event_date,
		data: (event.data ?? {}) as Record<string, unknown>,
		daysUntil: Math.round(
			DateTime.fromISO(event.event_date).diff(localDt, "days").days,
		),
	}));

	// 5. Format asset events section
	const eventsSection =
		eventsWithDaysUntil.length > 0
			? formatAssetEventsSection(eventsWithDaysUntil, channel)
			: null;

	// 6. Determine if insider should be fetched
	const includeInsider =
		channel === "email"
			? user.asset_events_include_insider_email
			: user.asset_events_include_insider_sms;

	// 7. Determine if analyst should be fetched (channel-specific)
	const currentMonth = localDt.toFormat("yyyy-MM");
	const includeAnalyst =
		(channel === "email"
			? user.asset_events_include_analyst_email
			: user.asset_events_include_analyst_sms) &&
		user.asset_events_last_analyst_sent_month !== currentMonth;

	// Fetch finnhub extras - combine into one call when both needed
	let insiderSection: string | null = null;
	let analystSection: string | null = null;

	if ((includeInsider || includeAnalyst) && tickers.length > 0) {
		const finnhubData = await fetchFinnhubExtras([...tickers], {
			includeNews: false,
			includeAnalyst,
			includeInsider,
		});

		if (includeInsider) {
			insiderSection = formatInsiderSection(finnhubData.insider, channel);
		}

		if (includeAnalyst) {
			analystSection = formatAnalystSection(finnhubData.analyst, channel);
		}
	}

	// 8. Set shouldUpdateAnalystMonth if analyst was fetched and formatted
	const shouldUpdateAnalystMonth = analystSection !== null;

	// 9. Compute hasAnyContent
	const hasAnyContent =
		eventsSection !== null ||
		insiderSection !== null ||
		analystSection !== null;

	// 10. Return all sections
	return {
		eventsSection,
		insiderSection,
		analystSection,
		shouldUpdateAnalystMonth,
		hasAnyContent,
	};
}
