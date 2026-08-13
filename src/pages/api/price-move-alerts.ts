import type { APIRoute } from "astro";
import { createUserService } from "../../lib/auth/user-service";
import type { ApiJsonBody } from "../../lib/client/types";
import { PRICE_MOVE_ALERT_THRESHOLD_PERCENT } from "../../lib/constants";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../lib/db/supabase";
import { createLogger } from "../../lib/logging";
import { createErrorForLogging } from "../../lib/logging/errors";
import { isValidAssetSymbol } from "../../lib/validation";

interface ThresholdRequest {
	symbol: unknown;
	enabled?: unknown;
	value?: unknown;
	unit?: unknown;
}

/**
 * POST /api/price-move-alerts
 *
 * Opt a tracked stock into or out of the fixed 5% Price Move Alert.
 * Preferred body: `{ symbol, enabled: boolean }`.
 * Legacy `{ symbol, value }`: any non-empty value enables at 5% percent;
 * null/absent value clears. Chosen numbers and units are ignored.
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

	const enable =
		typeof body.enabled === "boolean"
			? body.enabled
			: !(body.value === null || body.value === undefined || body.value === "");

	if (!enable) {
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

	const { error } = await admin.from("price_move_alert_thresholds").upsert(
		{
			user_id: user.id,
			symbol,
			threshold_value: PRICE_MOVE_ALERT_THRESHOLD_PERCENT,
			threshold_unit: "percent",
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
