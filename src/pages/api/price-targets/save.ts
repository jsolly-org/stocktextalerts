import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/json-response";
import { ASSET_SYMBOL_MAX_LENGTH } from "../../../lib/constants";
import { getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";
import { fetchAssetPrices } from "../../../lib/market-data/prices";
import { getCurrentMarketSession } from "../../../lib/market-data/session";

/**
 * POST /api/price-targets/save
 *
 * Body: { symbol: string, target_price: number | null }
 * - null target_price → DELETE the target
 * - number → validate, infer direction, UPSERT to price_targets
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
		logger.info("Price target save attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ ok: false, message: "invalid_json" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	if (typeof body !== "object" || body === null) {
		return Response.json({ ok: false, message: "invalid_body" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const { symbol, target_price } = body as {
		symbol: unknown;
		target_price: unknown;
	};
	const normalizedSymbol = typeof symbol === "string" ? symbol.trim().toUpperCase() : "";

	// Keep in sync with assets.symbol DB constraint and logo route validation.
	if (!normalizedSymbol) {
		return Response.json({ ok: false, message: "invalid_symbol" } satisfies ApiJsonBody, {
			status: 400,
		});
	}
	if (normalizedSymbol.length > ASSET_SYMBOL_MAX_LENGTH) {
		return Response.json({ ok: false, message: "invalid_symbol" } satisfies ApiJsonBody, {
			status: 400,
		});
	}
	// Restrict to valid ticker characters (alphanumeric, dot, hyphen) to avoid injection edge cases.
	if (!/^[A-Z0-9.-]+$/u.test(normalizedSymbol)) {
		return Response.json({ ok: false, message: "invalid_symbol" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	// DELETE flow: null target_price removes the target
	if (target_price === null) {
		try {
			const { error } = await supabase
				.from("price_targets")
				.delete()
				.eq("user_id", user.id)
				.eq("symbol", normalizedSymbol);

			if (error) {
				logger.error(
					"Failed to delete price target",
					{ userId: user.id, symbol: normalizedSymbol },
					error,
				);
				return Response.json(
					{
						ok: false,
						message: "failed_to_save",
					} satisfies ApiJsonBody,
					{ status: 500 },
				);
			}

			return Response.json({ ok: true, message: "target_removed" } satisfies ApiJsonBody, {
				status: 200,
			});
		} catch (error) {
			logger.error(
				"Failed to delete price target",
				{ userId: user.id, symbol: normalizedSymbol },
				createErrorForLogging(error),
			);
			return Response.json({ ok: false, message: "failed_to_save" } satisfies ApiJsonBody, {
				status: 500,
			});
		}
	}

	// UPSERT flow: validate and save target
	if (typeof target_price !== "number" || !Number.isFinite(target_price) || target_price <= 0) {
		return Response.json({ ok: false, message: "invalid_target_price" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	try {
		// Verify symbol is in user's watchlist
		const userAssets = await getUserAssets(supabase, user.id);
		const watchlistSymbols = new Set(userAssets.map((a) => a.symbol));
		if (!watchlistSymbols.has(normalizedSymbol)) {
			return Response.json(
				{
					ok: false,
					message: "symbol_not_in_watchlist",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		// Fetch current price to infer direction
		const session = await getCurrentMarketSession();
		const priceMap = await fetchAssetPrices([normalizedSymbol], session);
		const currentQuote = priceMap.get(normalizedSymbol);
		if (!currentQuote) {
			return Response.json(
				{
					ok: false,
					message: "price_unavailable",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		const currentPrice = currentQuote.price;
		if (target_price === currentPrice) {
			return Response.json(
				{
					ok: false,
					message: "target_equals_current",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		const direction = target_price > currentPrice ? "above" : "below";

		const { error } = await supabase.from("price_targets").upsert(
			{
				user_id: user.id,
				symbol: normalizedSymbol,
				target_price,
				direction,
				created_at: new Date().toISOString(),
				// Editing a target is a fresh target — reset all trigger/delivery-retry state so
				// a row mid-retry (kept alive across backoff ticks) can't resume against a stale
				// triggered_price or skip channels via stale *_delivered_at on the next tick.
				triggered_at: null,
				triggered_price: null,
				attempt_count: 0,
				next_retry_at: null,
				email_delivered_at: null,
				sms_delivered_at: null,
				telegram_delivered_at: null,
			},
			{ onConflict: "user_id,symbol" },
		);

		if (error) {
			logger.error(
				"Failed to upsert price target",
				{ userId: user.id, symbol: normalizedSymbol },
				error,
			);
			return Response.json({ ok: false, message: "failed_to_save" } satisfies ApiJsonBody, {
				status: 500,
			});
		}

		return Response.json(
			{
				ok: true,
				message: "target_saved",
				direction,
			} satisfies ApiJsonBody,
			{ status: 200 },
		);
	} catch (error) {
		logger.error(
			"Failed to save price target",
			{ userId: user.id, symbol: normalizedSymbol },
			createErrorForLogging(error),
		);
		return Response.json({ ok: false, message: "failed_to_save" } satisfies ApiJsonBody, {
			status: 500,
		});
	}
};
