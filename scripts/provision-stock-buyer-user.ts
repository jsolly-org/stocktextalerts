/**
 * Provision (or refresh) the internal stock-buyer STA user used to wake
 * asset-buyer via delivery_channel=lambda flat price alerts.
 *
 * Usage (local or prod — service role required):
 *   node --env-file-if-exists=.env.local ./node_modules/.bin/tsx \
 *     scripts/provision-stock-buyer-user.ts
 *
 * Idempotent: upserts auth+public user, replaces watchlist + 5% thresholds,
 * enables price_move_alerts only (all digest/PM/asset-events facets forced off).
 * Does not change password when the auth user exists.
 */
import { createClient } from "@supabase/supabase-js";
import { rootLogger } from "../src/lib/logging";
import { buildDefaultPreferenceRows } from "../src/lib/messaging/notification-prefs";

const STOCK_BUYER_EMAIL = "stock-buyer@internal.stocktextalerts";

/** Asset-buyer watchlist (41 tickers) — keep in sync with asset-buyer WATCHLIST. */
export const STOCK_BUYER_TICKERS = [
	"NVDA",
	"MSFT",
	"AMZN",
	"GOOGL",
	"AMD",
	"AVGO",
	"CHKP",
	"FFIV",
	"GEN",
	"CSCO",
	"IBM",
	"TT",
	"CARR",
	"JCI",
	"LII",
	"PLTR",
	"TSLA",
	"META",
	"NET",
	"CRWD",
	"SHOP",
	"ARM",
	"SNOW",
	"OKTA",
	"FTNT",
	"PANW",
	"ZS",
	"CYBR",
	"S",
	"RPD",
	"TENB",
	"VRNS",
	"QLYS",
	"VRT",
	"AAON",
	"MOD",
	"FIX",
	"SPXC",
	"NVT",
	"SPCX",
	"RBRK",
] as const;

async function main(): Promise<void> {
	const url = process.env.SUPABASE_URL?.trim();
	const secret = process.env.SUPABASE_SECRET_KEY?.trim();
	if (!url || !secret) {
		throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required");
	}

	const admin = createClient(url, secret, {
		auth: { autoRefreshToken: false, persistSession: false },
	});

	let userId: string | undefined;
	for (let page = 1; page <= 20; page++) {
		const { data: listed, error: listError } = await admin.auth.admin.listUsers({
			page,
			perPage: 1000,
		});
		if (listError) {
			throw new Error(`listUsers failed: ${listError.message}`);
		}
		userId = listed.users.find((u) => u.email === STOCK_BUYER_EMAIL)?.id;
		if (userId || listed.users.length < 1000) break;
	}
	if (!userId) {
		const password = process.env.STOCK_BUYER_SEED_PASSWORD?.trim();
		if (!password || password.length < 32) {
			throw new Error(
				"STOCK_BUYER_SEED_PASSWORD is required (≥32 chars) when creating the stock-buyer user",
			);
		}
		const { data: created, error: createError } = await admin.auth.admin.createUser({
			email: STOCK_BUYER_EMAIL,
			password,
			email_confirm: true,
		});
		if (createError || !created.user) {
			throw new Error(`createUser failed: ${createError?.message ?? "no user"}`);
		}
		userId = created.user.id;
		rootLogger.info("Created stock-buyer auth user", { userId, email: STOCK_BUYER_EMAIL });
	} else {
		rootLogger.info("Stock-buyer auth user already exists", { userId, email: STOCK_BUYER_EMAIL });
	}

	const nowIso = new Date().toISOString();
	const { error: profileError } = await admin.from("users").upsert(
		{
			id: userId,
			email: STOCK_BUYER_EMAIL,
			approved_at: nowIso,
			approved_by: "provision-stock-buyer-user",
			delivery_channel: "lambda",
			timezone: "America/New_York",
		},
		{ onConflict: "id" },
	);
	if (profileError) {
		throw new Error(`users upsert failed: ${profileError.message}`);
	}

	// Wakeup path only: force every content facet off, including matrix defaults
	// like daily_notification/prices that would otherwise stay enabled.
	const prefRows = buildDefaultPreferenceRows(userId).map((row) => ({
		...row,
		enabled: row.notification_type === "price_move_alerts",
	}));
	const { error: prefError } = await admin
		.from("notification_preferences")
		.upsert(prefRows, { onConflict: "user_id,notification_type,content" });
	if (prefError) {
		throw new Error(`notification_preferences upsert failed: ${prefError.message}`);
	}

	const { data: existingAssets, error: assetsLookupError } = await admin
		.from("assets")
		.select("symbol")
		.in("symbol", [...STOCK_BUYER_TICKERS]);
	if (assetsLookupError) {
		throw new Error(`assets lookup failed: ${assetsLookupError.message}`);
	}
	const known = new Set((existingAssets ?? []).map((row) => row.symbol));
	const missing = STOCK_BUYER_TICKERS.filter((symbol) => !known.has(symbol));
	const symbols = STOCK_BUYER_TICKERS.filter((symbol) => known.has(symbol));
	if (missing.length > 0) {
		rootLogger.warn("Skipping tickers missing from public.assets", {
			missing,
			knownCount: symbols.length,
		});
	}
	if (symbols.length === 0) {
		throw new Error("No STOCK_BUYER_TICKERS exist in public.assets");
	}

	const { error: replaceError } = await admin.rpc("replace_user_assets", {
		user_id: userId,
		symbols,
	});
	if (replaceError) {
		throw new Error(
			`replace_user_assets failed: ${replaceError.message}. Ensure all tickers exist in public.assets.`,
		);
	}

	const thresholds = symbols.map((symbol) => ({
		user_id: userId,
		symbol,
		threshold_value: 5,
		threshold_unit: "percent" as const,
	}));
	const { error: thresholdError } = await admin
		.from("price_move_alert_thresholds")
		.upsert(thresholds, { onConflict: "user_id,symbol" });
	if (thresholdError) {
		throw new Error(`price_move_alert_thresholds upsert failed: ${thresholdError.message}`);
	}

	rootLogger.info("Stock-buyer user provisioned", {
		userId,
		email: STOCK_BUYER_EMAIL,
		delivery_channel: "lambda",
		tickerCount: symbols.length,
		missingFromAssets: missing,
		thresholdPercent: 5,
	});
}

main().catch((err) => {
	rootLogger.error("provision-stock-buyer-user failed", {}, err);
	process.exitCode = 1;
});
