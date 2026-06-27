import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { enqueueNewSymbolWarmup } from "../../../lib/backfill/queue";
import { createUserService, getUserAssets } from "../../../lib/db";
import {
	isAssetsLimitError,
	isAssetsWhitespaceError,
	MAX_TRACKED_ASSETS,
} from "../../../lib/db/database-errors";
import { readEnv } from "../../../lib/db/env";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging, extractErrorMessage } from "../../../lib/logging/errors";
import { isValidAssetSymbol } from "../../../lib/validation";

const ASSETS_SCHEMA = {
	tracked_assets: { type: "json_string_array", required: true },
} as const satisfies FormSchema;

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
		logger.info("Tracked assets update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Tracked assets update rejected due to malformed request body",
			{
				userId: user.id,
				contentType: request.headers.get("content-type"),
			},
			createErrorForLogging(error),
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}
	const parsed = parseWithSchema(formData, ASSETS_SCHEMA);

	if (!parsed.ok) {
		logger.info("Tracked assets update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const trackedSymbols = parsed.data.tracked_assets;

	// Validate symbol format and length (align with DB and logo/search routes).
	const normalizedSymbols = trackedSymbols.map((s) =>
		typeof s === "string" ? s.trim().toUpperCase() : "",
	);
	const invalidSymbol = normalizedSymbols.find((s) => !isValidAssetSymbol(s));
	if (invalidSymbol !== undefined) {
		logger.info("Tracked assets update rejected: invalid symbol format", {
			userId: user.id,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const uniqueSymbols = [...new Set(normalizedSymbols.filter(Boolean))];
	if (uniqueSymbols.length > MAX_TRACKED_ASSETS) {
		logger.info("Tracked assets limit exceeded", {
			userId: user.id,
			count: uniqueSymbols.length,
		});
		return jsonResponse(400, { ok: false, message: "assets_limit" });
	}

	// Reject any delisted symbols. The daily sweep populates assets.delisted_at;
	// this guard prevents users from re-adding a dead ticker the sweep just
	// cleaned up.
	if (uniqueSymbols.length > 0) {
		const { data: delistedRows, error: delistedErr } = await supabase
			.from("assets")
			.select("symbol")
			.in("symbol", uniqueSymbols)
			.not("delisted_at", "is", null);

		if (delistedErr) {
			logger.error(
				"Failed to check for delisted symbols",
				{ userId: user.id },
				createErrorForLogging(delistedErr),
			);
			return jsonResponse(500, {
				ok: false,
				message: "failed_to_update_assets",
			});
		}

		if (delistedRows && delistedRows.length > 0) {
			const blocked = delistedRows.map((r) => r.symbol);
			logger.info("Tracked assets update rejected: contains delisted symbols", {
				userId: user.id,
				blocked,
			});
			return jsonResponse(400, {
				ok: false,
				message: "delisted_symbols",
				blocked,
			});
		}
	}

	let previousSymbols: string[] = [];
	try {
		const previousAssets = await getUserAssets(supabase, user.id);
		previousSymbols = previousAssets.map((asset) => asset.symbol);
	} catch (error) {
		logger.warn(
			"Failed to load previous tracked assets before update",
			{ userId: user.id },
			createErrorForLogging(error),
		);
	}

	try {
		const { error } = await supabase.rpc("replace_user_assets", {
			user_id: user.id,
			symbols: uniqueSymbols,
		});
		if (error) {
			throw error;
		}
	} catch (error) {
		const errorMessage = extractErrorMessage(error);

		if (isAssetsLimitError(error) || isAssetsWhitespaceError(error)) {
			logger.info("Tracked assets update rejected due to invalid input", {
				userId: user.id,
				error: errorMessage,
			});
		} else {
			logger.error(
				"Failed to update tracked assets",
				{ userId: user.id, symbols: uniqueSymbols },
				createErrorForLogging(error),
			);
		}

		if (isAssetsLimitError(error)) {
			return jsonResponse(400, { ok: false, message: "assets_limit" });
		}

		if (isAssetsWhitespaceError(error)) {
			return jsonResponse(400, { ok: false, message: "invalid_form" });
		}

		return jsonResponse(500, { ok: false, message: "failed_to_update_assets" });
	}

	const previousSymbolSet = new Set(previousSymbols);
	if (readEnv("VENDOR_BACKFILL_QUEUE_URL")) {
		for (const symbol of uniqueSymbols) {
			if (previousSymbolSet.has(symbol)) continue;
			const enqueued = await enqueueNewSymbolWarmup({
				symbol,
				reason: "user_added_tracked_symbol",
			});
			if (!enqueued) {
				logger.error(
					"Failed to enqueue new-symbol warmup",
					{ userId: user.id, symbol },
					new Error("SQS enqueue failed"),
				);
			}
		}
	}

	return jsonResponse(200, { ok: true, message: "assets_updated" });
};
