import type { APIRoute } from "astro";
import { createUserService } from "../../lib/auth/user-service";
import type { ApiJsonBody } from "../../lib/client/types";
import {
	MAX_PRICE_MOVE_DOLLAR_THRESHOLD,
	MAX_PRICE_MOVE_PERCENT_THRESHOLD,
} from "../../lib/constants";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../lib/db/supabase";
import { isPriceMoveThresholdUnit } from "../../lib/db/types";
import { createLogger } from "../../lib/logging";
import { createErrorForLogging } from "../../lib/logging/errors";
import { isValidAssetSymbol } from "../../lib/validation";

interface ThresholdRequest {
	symbol: unknown;
	value: unknown;
	unit: unknown;
}

/**
 * POST /api/price-move-alerts
 *
 * Upsert or clear the authenticated user's per-stock price-move alert threshold.
 * Body: `{ symbol, value, unit }`. A null/absent `value` clears the threshold
 * (disables alerts for that stock); a positive `value` with unit `"percent"` or
 * `"dollar"` upserts it. The symbol must be in the user's watchlist. Row presence
 * in `price_move_alert_thresholds` is what enables the alert — mirrors the
 * opt-in-per-stock model. Writes run through the admin client after the session
 * user is authenticated (the table is not writable by the `authenticated` role).
 */
export const POST: APIRoute = async ({ url, request, cookies, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const userService = createUserService(supabase, cookies);

	const user = await userService.getCurrentUser();
	if (!user) {
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	let body: ThresholdRequest;
	try {
		body = (await request.json()) as ThresholdRequest;
	} catch (error) {
		logger.info(
			"Price-move threshold update rejected due to malformed body",
			{ userId: user.id },
			createErrorForLogging(error),
		);
		return Response.json({ ok: false, message: "invalid_body" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
	if (!isValidAssetSymbol(symbol)) {
		return Response.json({ ok: false, message: "invalid_symbol" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const admin = createSupabaseAdminClient();

	// The threshold only makes sense for a tracked asset; enforce watchlist
	// membership so a client can't seed thresholds for untracked symbols.
	const { data: trackedRow, error: trackedError } = await admin
		.from("user_assets")
		.select("symbol")
		.eq("user_id", user.id)
		.eq("symbol", symbol)
		.maybeSingle();
	if (trackedError) {
		logger.error(
			"Failed to verify tracked asset for price-move threshold",
			{ userId: user.id, symbol },
			trackedError,
		);
		return Response.json({ ok: false, message: "server_error" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
	if (!trackedRow) {
		return Response.json({ ok: false, message: "asset_not_tracked" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	// A null/absent value clears the threshold (disables alerts for this stock).
	if (body.value === null || body.value === undefined || body.value === "") {
		const { error } = await admin
			.from("price_move_alert_thresholds")
			.delete()
			.eq("user_id", user.id)
			.eq("symbol", symbol);
		if (error) {
			logger.error("Failed to clear price-move threshold", { userId: user.id, symbol }, error);
			return Response.json({ ok: false, message: "server_error" } satisfies ApiJsonBody, {
				status: 500,
			});
		}
		return Response.json({ ok: true, message: "threshold_cleared" } satisfies ApiJsonBody, {
			status: 200,
		});
	}

	// Fail loud on an unrecognized unit — silently coercing would flip the
	// threshold's meaning (a "$5" request stored as 5%).
	if (!isPriceMoveThresholdUnit(body.unit)) {
		return Response.json({ ok: false, message: "invalid_unit" } satisfies ApiJsonBody, {
			status: 400,
		});
	}
	const unit = body.unit;

	const value = typeof body.value === "number" ? body.value : Number(body.value);
	const maxValue =
		unit === "percent" ? MAX_PRICE_MOVE_PERCENT_THRESHOLD : MAX_PRICE_MOVE_DOLLAR_THRESHOLD;
	if (!Number.isFinite(value) || value <= 0 || value > maxValue) {
		return Response.json({ ok: false, message: "invalid_value" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const { error } = await admin.from("price_move_alert_thresholds").upsert(
		{
			user_id: user.id,
			symbol,
			// Round to 4 dp to match the numeric(12,4) column.
			threshold_value: Math.round(value * 10000) / 10000,
			threshold_unit: unit,
		},
		{ onConflict: "user_id,symbol" },
	);
	if (error) {
		logger.error("Failed to upsert price-move threshold", { userId: user.id, symbol }, error);
		return Response.json({ ok: false, message: "server_error" } satisfies ApiJsonBody, {
			status: 500,
		});
	}

	return Response.json({ ok: true, message: "threshold_saved" } satisfies ApiJsonBody, {
		status: 200,
	});
};
