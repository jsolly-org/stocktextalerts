import { DateTime } from "luxon";
import type { Logger } from "../logging";
import { isFacetEnabled } from "../messaging/notification-prefs";
import type { UserRecord } from "../messaging/types";
import type { SupabaseAdminClient } from "../schedule/helpers";
import { formatAnalystSection, formatInsiderSection } from "../vendors/finnhub";
import { formatAssetEventsSection } from "../vendors/massive";
import { loadStoredFinnhubExtras } from "./enrichment-store";

type DeliveryChannel = "email" | "sms";

/**
 * Telegram facet selection for asset events, sourced from notification_preferences
 * (NOT the per-column email/sms flags). When present, the content builder renders a
 * `telegram` AssetEventsContent using the rich email-style section formatting, gated
 * by these facets. Additive: email/SMS rendering is unchanged.
 */
export type AssetEventsTelegramFacets = {
	calendar: boolean;
	ipo: boolean;
	insider: boolean;
	analyst: boolean;
};

export type AssetEventsContent = {
	eventsSection: {
		earnings: string | null;
		dividends: string | null;
		splits: string | null;
		ipos: string | null;
	} | null;
	insiderSection: string | null;
	analystSection: string | null;
	hasAnyContent: boolean;
};

const emptyContent = (): AssetEventsContent => ({
	eventsSection: null,
	insiderSection: null,
	analystSection: null,
	hasAnyContent: false,
});

function channelWantsCalendar(user: UserRecord, channel: DeliveryChannel): boolean {
	return isFacetEnabled(user.prefs, "asset_events", channel, "calendar");
}

function channelWantsIpos(user: UserRecord, channel: DeliveryChannel): boolean {
	return isFacetEnabled(user.prefs, "asset_events", channel, "ipo");
}

function channelWantsInsider(user: UserRecord, channel: DeliveryChannel): boolean {
	return isFacetEnabled(user.prefs, "asset_events", channel, "insider");
}

function channelWantsAnalyst(
	user: UserRecord,
	channel: DeliveryChannel,
	currentMonth: string,
): boolean {
	return (
		isFacetEnabled(user.prefs, "asset_events", channel, "analyst") &&
		user.asset_events_last_analyst_sent_month !== currentMonth
	);
}

type RawEvent = {
	symbol: string;
	event_type: "earnings" | "dividend" | "split" | "ipo";
	event_date: string;
	data: Record<string, unknown>;
};

function filterEventsForChannel(
	events: RawEvent[],
	user: UserRecord,
	channel: DeliveryChannel,
): RawEvent[] {
	return events.filter((event) => {
		if (event.event_type === "ipo") {
			return channelWantsIpos(user, channel);
		}
		return channelWantsCalendar(user, channel);
	});
}

function formatContentForChannel(options: {
	channel: DeliveryChannel;
	user: UserRecord;
	eventsWithDaysUntil: Array<{
		symbol: string;
		event_type: "earnings" | "dividend" | "split" | "ipo";
		event_date: string;
		data: Record<string, unknown>;
		daysUntil: number;
	}>;
	finnhubData: Awaited<ReturnType<typeof loadStoredFinnhubExtras>>;
	includeInsider: boolean;
	includeAnalyst: boolean;
}): AssetEventsContent {
	const { channel, user, eventsWithDaysUntil, finnhubData, includeInsider, includeAnalyst } =
		options;

	const channelEvents = filterEventsForChannel(eventsWithDaysUntil, user, channel);
	const eventsSection =
		channelEvents.length > 0 ? formatAssetEventsSection(channelEvents, channel) : null;

	let insiderSection: string | null = null;
	let analystSection: string | null = null;

	if (includeInsider) {
		insiderSection = formatInsiderSection(finnhubData.insider, channel);
	}

	if (includeAnalyst) {
		analystSection = formatAnalystSection(finnhubData.analyst, channel);
	}

	const hasAnyContent =
		eventsSection !== null || insiderSection !== null || analystSection !== null;

	return {
		eventsSection,
		insiderSection,
		analystSection,
		hasAnyContent,
	};
}

/** Build asset-events content for one or more delivery channels with a single upstream load. */
export async function buildAssetEventsContentForChannels(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	localDate: string;
	tickers: readonly string[];
	channels: readonly DeliveryChannel[];
	/** When set, also render a Telegram content block gated by these facets. */
	telegramFacets?: AssetEventsTelegramFacets;
}): Promise<{
	email: AssetEventsContent | null;
	sms: AssetEventsContent | null;
	telegram: AssetEventsContent | null;
	analystFetchAttempted: boolean;
	shouldUpdateAnalystMonth: boolean;
}> {
	const { user, supabase, logger, localDate, tickers, channels, telegramFacets } = options;
	const noChannels = {
		email: null,
		sms: null,
		telegram: null,
		analystFetchAttempted: false,
		shouldUpdateAnalystMonth: false,
	};

	// The Telegram facet selection independently requires content even when the
	// user has email/SMS off (a Telegram-only asset-events user).
	const telegramWantsCalendar = Boolean(telegramFacets?.calendar);
	const telegramWantsIpos = Boolean(telegramFacets?.ipo);
	const telegramWantsInsider = Boolean(telegramFacets?.insider);
	const telegramWantsAnalyst = Boolean(telegramFacets?.analyst);
	const hasTelegramRequest =
		telegramWantsCalendar || telegramWantsIpos || telegramWantsInsider || telegramWantsAnalyst;

	if (channels.length === 0 && !hasTelegramRequest) {
		return noChannels;
	}

	const localDt = DateTime.fromISO(localDate);
	if (!localDt.isValid) {
		logger.error(
			"Invalid localDate for asset events content",
			{ localDate, localDtInvalidReason: localDt.invalidReason },
			new Error(`Invalid localDate: ${localDt.invalidReason ?? "unknown"}`),
		);
		return noChannels;
	}

	const endDate = localDt.plus({ days: 2 }).toISODate() ?? "";
	if (!endDate) {
		logger.error(
			"Failed to format endDate for asset events content",
			{ localDate, localDt: localDt.toString(), localDtIsValid: localDt.isValid },
			new Error("Failed to format endDate for asset events content"),
		);
		return noChannels;
	}

	const currentMonth = localDt.toFormat("yyyy-MM");
	// Analyst is published monthly on the 1st — for every channel (incl. Telegram)
	// it's gated on not having already sent this month.
	const telegramAnalystDue =
		telegramWantsAnalyst && user.asset_events_last_analyst_sent_month !== currentMonth;
	const includeCalendar =
		channels.some((ch) => channelWantsCalendar(user, ch)) || telegramWantsCalendar;
	const includeIpos = channels.some((ch) => channelWantsIpos(user, ch)) || telegramWantsIpos;
	const includeInsiderUnion =
		channels.some((ch) => channelWantsInsider(user, ch)) || telegramWantsInsider;
	const includeAnalystUnion =
		channels.some((ch) => channelWantsAnalyst(user, ch, currentMonth)) || telegramAnalystDue;

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
		return noChannels;
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

	if ((includeInsiderUnion || includeAnalystUnion) && tickers.length > 0) {
		finnhubData = await loadStoredFinnhubExtras({
			supabase,
			logger,
			tickers,
			localDate,
			includeAnalyst: includeAnalystUnion,
			includeInsider: includeInsiderUnion,
		});
	}

	const analystFetchAttempted = includeAnalystUnion && tickers.length > 0;
	const shouldUpdateAnalystMonth = analystFetchAttempted && finnhubData.analystFetchSucceeded;

	let email: AssetEventsContent | null = null;
	let sms: AssetEventsContent | null = null;

	if (channels.includes("email")) {
		email = formatContentForChannel({
			channel: "email",
			user,
			eventsWithDaysUntil,
			finnhubData,
			includeInsider: channelWantsInsider(user, "email"),
			includeAnalyst: channelWantsAnalyst(user, "email", currentMonth),
		});
	}

	if (channels.includes("sms")) {
		sms = formatContentForChannel({
			channel: "sms",
			user,
			eventsWithDaysUntil,
			finnhubData,
			includeInsider: channelWantsInsider(user, "sms"),
			includeAnalyst: channelWantsAnalyst(user, "sms", currentMonth),
		});
	}

	// Telegram uses the rich (email-style) section rendering, gated by the
	// notification_preferences facet selection rather than the per-column flags.
	let telegram: AssetEventsContent | null = null;
	if (hasTelegramRequest) {
		const telegramEvents = eventsWithDaysUntil.filter((event) =>
			event.event_type === "ipo" ? telegramWantsIpos : telegramWantsCalendar,
		);
		const eventsSection =
			telegramEvents.length > 0 ? formatAssetEventsSection(telegramEvents, "email") : null;
		const insiderSection = telegramWantsInsider
			? formatInsiderSection(finnhubData.insider, "email")
			: null;
		const analystSection = telegramAnalystDue
			? formatAnalystSection(finnhubData.analyst, "email")
			: null;
		telegram = {
			eventsSection,
			insiderSection,
			analystSection,
			hasAnyContent: eventsSection !== null || insiderSection !== null || analystSection !== null,
		};
	}

	return {
		email,
		sms,
		telegram,
		analystFetchAttempted,
		shouldUpdateAnalystMonth,
	};
}

/** Build asset-events content for a single delivery channel. */
export async function buildAssetEventsContent(options: {
	user: UserRecord;
	supabase: SupabaseAdminClient;
	logger: Logger;
	localDate: string;
	tickers: readonly string[];
	channel: DeliveryChannel;
}): Promise<AssetEventsContent> {
	const built = await buildAssetEventsContentForChannels({
		user: options.user,
		supabase: options.supabase,
		logger: options.logger,
		localDate: options.localDate,
		tickers: options.tickers,
		channels: [options.channel],
	});
	const content = options.channel === "email" ? built.email : built.sms;
	return content ?? emptyContent();
}
