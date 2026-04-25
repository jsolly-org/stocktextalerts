import { DEFAULT_TIMEZONE } from "../constants";
import type { Database } from "../db/generated/database.types";
import type { AppSupabaseClient } from "../db/supabase";
import { rootLogger } from "../logging";
import type { TimezoneOption } from "./types";

type DbTimezoneRow = Database["public"]["Tables"]["timezones"]["Row"];

const ALL_TIMEZONES_TTL_MS = 24 * 60 * 60 * 1000;

// Module-level cache resets on serverless cold starts, but provides
// TTL benefits during warm invocations to reduce DB load during sustained traffic.
let allTimezonesCache: {
	rows: DbTimezoneRow[];
	expiresAtMs: number;
	cacheBuster: string;
} | null = null;
let allTimezonesInFlight: Promise<DbTimezoneRow[]> | null = null;

function getTimezoneCacheBuster(): string {
	return (process.env.TIMEZONE_CACHE_BUSTER ?? "").trim();
}

async function loadAllTimezones(
	supabase: AppSupabaseClient,
): Promise<DbTimezoneRow[]> {
	const pageSize = 1000;
	const rows: DbTimezoneRow[] = [];

	for (let from = 0; ; from += pageSize) {
		const { data, error } = await supabase
			.from("timezones")
			.select("value,label,display_order,active")
			.range(from, from + pageSize - 1);

		if (error) {
			throw new Error(`Failed to load timezones: ${error.message}`);
		}

		rows.push(...data);

		if (data.length < pageSize) {
			break;
		}
	}

	return rows.filter((row) => row.value !== "");
}

async function getAllTimezonesCached(
	supabase: AppSupabaseClient,
): Promise<DbTimezoneRow[]> {
	const cacheBuster = getTimezoneCacheBuster();
	const nowMs = Date.now();

	if (
		allTimezonesCache &&
		allTimezonesCache.cacheBuster === cacheBuster &&
		allTimezonesCache.expiresAtMs > nowMs
	) {
		return allTimezonesCache.rows;
	}

	if (allTimezonesInFlight) {
		return allTimezonesInFlight;
	}

	allTimezonesInFlight = loadAllTimezones(supabase)
		.then((rows) => {
			allTimezonesCache = {
				rows,
				expiresAtMs: Date.now() + ALL_TIMEZONES_TTL_MS,
				cacheBuster,
			};
			return rows;
		})
		.catch((error) => {
			rootLogger.error(
				"Failed to load timezones cache",
				{ action: "load_timezones_cache", cacheBuster },
				error,
			);
			// Only invalidate cache on error if a cache bust was explicitly requested
			// (i.e., cacheBuster changed). This preserves valid cached data during
			// transient fetch errors.
			if (allTimezonesCache && allTimezonesCache.cacheBuster !== cacheBuster) {
				allTimezonesCache = null;
			}
			throw error;
		})
		.finally(() => {
			allTimezonesInFlight = null;
		});

	return allTimezonesInFlight;
}

// Cached in-memory for short TTL to reduce DB load during sustained traffic.
export async function getTimezoneOptions(
	supabase: AppSupabaseClient,
	options?: { includeValues?: string[] },
): Promise<TimezoneOption[]> {
	const includeValues = (options?.includeValues ?? []).filter(
		(value) => value !== "",
	);
	const uniqueIncludeValues = [...new Set(includeValues)];

	const rows = await getAllTimezonesCached(supabase);

	const activeTimezones = rows
		.filter((timezone) => timezone.active)
		.map((timezone) => ({
			value: timezone.value,
			label: timezone.label,
			display_order: timezone.display_order,
		}))
		.sort((left, right) => left.display_order - right.display_order);

	if (uniqueIncludeValues.length === 0) {
		return activeTimezones;
	}

	const byValue = new Map(rows.map((timezone) => [timezone.value, timezone]));

	const activeValueSet = new Set(
		activeTimezones.map((timezone) => timezone.value),
	);

	const extras = uniqueIncludeValues
		.map((value) => byValue.get(value))
		.filter((timezone): timezone is DbTimezoneRow => Boolean(timezone))
		.filter((timezone) => !activeValueSet.has(timezone.value))
		.map((timezone) => ({
			value: timezone.value,
			label: timezone.label,
			display_order: timezone.display_order,
		}))
		.sort((left, right) => left.value.localeCompare(right.value));

	return [...extras, ...activeTimezones];
}

// Prefers detected timezone when it exists in DB; otherwise falls back to DEFAULT_TIMEZONE.
export async function resolveTimezone(options: {
	supabase: AppSupabaseClient;
	detectedTimezone: string | null | undefined;
	allTimezoneValues?: string[];
}): Promise<string> {
	const { supabase, detectedTimezone, allTimezoneValues } = options;

	const values = allTimezoneValues
		? allTimezoneValues
		: (await getAllTimezonesCached(supabase)).map((timezone) => timezone.value);

	if (detectedTimezone && detectedTimezone !== "") {
		const byValue = new Set(values);
		if (byValue.has(detectedTimezone)) {
			return detectedTimezone;
		}

		// Browser-supplied timezone we don't recognize — falls back to
		// DEFAULT_TIMEZONE. Treated as invalid user input (info), not a
		// system failure.
		rootLogger.info("Detected timezone not found in database", {
			detectedTimezone,
		});
	}

	return DEFAULT_TIMEZONE;
}
