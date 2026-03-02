import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService, getUserAssets } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { extractErrorMessage } from "../../../lib/logging/errors";
import { fetchAssetPrices } from "../../../lib/providers/price-fetcher";

/**
 * POST /api/price-targets/save
 *
 * Body: { symbol: string, target_price: number | null }
 * - null target_price → DELETE the target
 * - number → validate, infer direction, UPSERT to price_targets
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const url = new URL(request.url);
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
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return jsonResponse(400, { ok: false, message: "invalid_json" });
	}

	if (typeof body !== "object" || body === null) {
		return jsonResponse(400, { ok: false, message: "invalid_body" });
	}

	const { symbol, target_price } = body as {
		symbol: unknown;
		target_price: unknown;
	};
	const normalizedSymbol =
		typeof symbol === "string" ? symbol.trim().toUpperCase() : "";

	if (!normalizedSymbol) {
		return jsonResponse(400, { ok: false, message: "invalid_symbol" });
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
				return jsonResponse(500, {
					ok: false,
					message: "failed_to_save",
				});
			}

			return jsonResponse(200, { ok: true, message: "target_removed" });
		} catch (error) {
			logger.error("Failed to delete price target", {
				userId: user.id,
				symbol: normalizedSymbol,
				error: extractErrorMessage(error),
			});
			return jsonResponse(500, { ok: false, message: "failed_to_save" });
		}
	}

	// UPSERT flow: validate and save target
	if (
		typeof target_price !== "number" ||
		!Number.isFinite(target_price) ||
		target_price <= 0
	) {
		return jsonResponse(400, { ok: false, message: "invalid_target_price" });
	}

	try {
		// Verify symbol is in user's watchlist
		const userAssets = await getUserAssets(supabase, user.id);
		const watchlistSymbols = new Set(userAssets.map((a) => a.symbol));
		if (!watchlistSymbols.has(normalizedSymbol)) {
			return jsonResponse(400, {
				ok: false,
				message: "symbol_not_in_watchlist",
			});
		}

		// Fetch current price to infer direction
		const priceMap = await fetchAssetPrices([normalizedSymbol]);
		const currentQuote = priceMap.get(normalizedSymbol);
		if (!currentQuote) {
			return jsonResponse(400, {
				ok: false,
				message: "price_unavailable",
			});
		}

		const currentPrice = currentQuote.price;
		if (target_price === currentPrice) {
			return jsonResponse(400, {
				ok: false,
				message: "target_equals_current",
			});
		}

		const direction = target_price > currentPrice ? "above" : "below";

		const { error } = await supabase.from("price_targets").upsert(
			{
				user_id: user.id,
				symbol: normalizedSymbol,
				target_price,
				direction,
				created_at: new Date().toISOString(),
			},
			{ onConflict: "user_id,symbol" },
		);

		if (error) {
			logger.error(
				"Failed to upsert price target",
				{ userId: user.id, symbol: normalizedSymbol },
				error,
			);
			return jsonResponse(500, { ok: false, message: "failed_to_save" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "target_saved",
			direction,
		});
	} catch (error) {
		logger.error("Failed to save price target", {
			userId: user.id,
			symbol: normalizedSymbol,
			error: extractErrorMessage(error),
		});
		return jsonResponse(500, { ok: false, message: "failed_to_save" });
	}
};
