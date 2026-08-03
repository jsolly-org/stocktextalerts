import { DateTime } from "luxon";
import { isDailyNotificationFacetEnabled } from "../daily-notification/eligibility";
import type { SupabaseAdminClient } from "../db/supabase";
import type { Logger } from "../logging";
import type { UserRecord } from "../types";
import { loadStoredFinnhubExtras } from "./enrichment-store";
import { formatAnalystSection, formatAssetEventsSection, formatInsiderSection } from "./format";
import { loadStoredSecFilings } from "./sec-filings";
import { loadShortInterestDigestContent } from "./short-interest";
import type { AssetEventsContent, SecFilingLine, ShortInterestDigestContent } from "./types";

const emptyContent = (): AssetEventsContent => ({
	eventsSection: null,
	insiderSection: null,
	analystSection: null,
	filingsLines: null,
	shortInterest: null,
	hasAnyContent: false,
});

function wantsCalendar(user: UserRecord): boolean {
	return isDailyNotificationFacetEnabled(user.prefs, "calendar");
}

function wantsIpos(user: UserRecord): boolean {
	return isDailyNotificationFacetEnabled(user.prefs, "ipo");
}

function wantsInsider(user: UserRecord): boolean {
	return isDailyNotificationFacetEnabled(user.prefs, "insider");
}

function wantsAnalyst(user: UserRecord, currentMonth: string): boolean {
	return (
		isDailyNotificationFacetEnabled(user.prefs, "analyst") &&
		user.asset_events_last_analyst_sent_month !== currentMonth
	);
}

function wantsFilings(user: UserRecord): boolean {
	return isDailyNotificationFacetEnabled(user.prefs, "filings");
}

function wantsShortInterest(user: UserRecord): boolean {
	return isDailyNotificationFacetEnabled(user.prefs, "short_interest");
}

type RawEvent = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split" | "ipo";
	event_date: string;
	data: Record<string, unknown>;
};

function filterEventsForUserPrefs<T extends RawEvent>(events: T[], user: UserRecord): T[] {
	return events.filter((event) => {
		if (event.event_type === "ipo") {
			return wantsIpos(user);
		}
		return wantsCalendar(user);
	});
}

/**
 * Load asset-events once from channel-agnostic content prefs.
 * Delivery formatters wrap this payload for email or Telegram — this builder
 * does not branch on `delivery_channel`.
 */
export async function buildAssetEventsContent(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	localDate: string;
	tickers: readonly string[];
}): Promise<{
	content: AssetEventsContent;
	analystFetchAttempted: boolean;
	shouldUpdateAnalystMonth: boolean;
}> {
	const { user, supabase, logger, localDate, tickers } = options;
	const empty = {
		content: emptyContent(),
		analystFetchAttempted: false,
		shouldUpdateAnalystMonth: false,
	};

	const localDt = DateTime.fromISO(localDate);
	if (!localDt.isValid) {
		logger.error(
			"Invalid localDate for asset events content",
			{ localDate, localDtInvalidReason: localDt.invalidReason },
			new Error(`Invalid localDate: ${localDt.invalidReason ?? "unknown"}`),
		);
		return empty;
	}

	const endDate = localDt.plus({ days: 2 }).toISODate() ?? "";
	if (!endDate) {
		logger.error(
			"Failed to format endDate for asset events content",
			{ localDate, localDt: localDt.toString(), localDtIsValid: localDt.isValid },
			new Error("Failed to format endDate for asset events content"),
		);
		return empty;
	}

	const currentMonth = localDt.toFormat("yyyy-MM");
	const includeCalendar = wantsCalendar(user);
	const includeIpos = wantsIpos(user);
	const includeInsider = wantsInsider(user);
	const includeAnalyst = wantsAnalyst(user, currentMonth);
	const includeFilings = wantsFilings(user);
	const includeShortInterest = wantsShortInterest(user);

	if (
		!includeCalendar &&
		!includeIpos &&
		!includeInsider &&
		!includeAnalyst &&
		!includeFilings &&
		!includeShortInterest
	) {
		return empty;
	}

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

	const [calendarResult, ipoResult] = await Promise.all([calendarPromise, ipoPromise]);

	if (calendarResult.error || ipoResult.error) {
		const queryError = calendarResult.error ?? ipoResult.error;
		logger.error(
			"Failed to query asset/market events",
			{ localDate },
			queryError ?? new Error("asset/market events query failed"),
		);
		return empty;
	}

	const calendarRows = calendarResult.data ?? [];
	const ipoRows = ipoResult.data ?? [];

	const rawEvents: RawEvent[] = [
		...(
			calendarRows as Array<{
				symbol: string;
				event_type: "earnings" | "dividend" | "split";
				event_date: string;
				data: Record<string, unknown> | null;
			}>
		).map((row) => ({
			symbol: row.symbol,
			event_type: row.event_type,
			event_date: row.event_date,
			data: (row.data ?? {}) as Record<string, unknown>,
		})),
		...ipoRows.map((row) => ({
			symbol: row.symbol,
			event_type: "ipo" as const,
			event_date: row.event_date,
			data: (row.data ?? {}) as Record<string, unknown>,
		})),
	];

	const eventsWithDaysUntil = rawEvents.map((event) => ({
		symbol: event.symbol,
		event_type: event.event_type,
		event_date: event.event_date,
		data: event.data,
		daysUntil: Math.round(DateTime.fromISO(event.event_date).diff(localDt, "days").days),
	}));

	let finnhubData: Awaited<ReturnType<typeof loadStoredFinnhubExtras>> = {
		analyst: new Map(),
		insider: new Map(),
		analystFetchSucceeded: false,
	};

	const [finnhubLoaded, filingsLoaded, shortInterestLoaded] = await Promise.all([
		(includeInsider || includeAnalyst) && tickers.length > 0
			? loadStoredFinnhubExtras({
					supabase,
					logger,
					tickers,
					localDate,
					includeAnalyst,
					includeInsider,
				})
			: Promise.resolve(finnhubData),
		includeFilings && tickers.length > 0
			? loadStoredSecFilings({
					supabase,
					logger,
					tickers,
					localDate,
				})
			: Promise.resolve([] as SecFilingLine[]),
		includeShortInterest
			? loadShortInterestDigestContent({
					supabase,
					logger,
					tickers,
					localDate,
				})
			: Promise.resolve(null as ShortInterestDigestContent | null),
	]);
	finnhubData = finnhubLoaded;
	const filingsLines = filingsLoaded;
	const shortInterest = shortInterestLoaded;

	const analystFetchAttempted = includeAnalyst && tickers.length > 0;
	const shouldUpdateAnalystMonth = analystFetchAttempted && finnhubData.analystFetchSucceeded;

	const filteredEvents = filterEventsForUserPrefs(eventsWithDaysUntil, user);
	const eventsSection = filteredEvents.length > 0 ? formatAssetEventsSection(filteredEvents) : null;
	const insiderSection = includeInsider ? formatInsiderSection(finnhubData.insider) : null;
	const analystSection = includeAnalyst ? formatAnalystSection(finnhubData.analyst) : null;
	const contentFilings = includeFilings && filingsLines.length > 0 ? filingsLines : null;
	const contentShortInterest = includeShortInterest ? shortInterest : null;

	const content: AssetEventsContent = {
		eventsSection,
		insiderSection,
		analystSection,
		filingsLines: contentFilings,
		shortInterest: contentShortInterest,
		hasAnyContent:
			eventsSection !== null ||
			insiderSection !== null ||
			analystSection !== null ||
			contentFilings !== null ||
			contentShortInterest !== null,
	};

	return {
		content,
		analystFetchAttempted,
		shouldUpdateAnalystMonth,
	};
}
