import type { APIRoute } from "astro";
import { ensureAssetIconChecked } from "../../../lib/assets/icon-backfill";
import { createUserService } from "../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../lib/client/types";
import { getUserAssets } from "../../../lib/db";
import {
	isAssetsLimitError,
	isAssetsWhitespaceError,
	MAX_TRACKED_ASSETS,
} from "../../../lib/db/database-errors";
import { readEnv } from "../../../lib/db/env";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging, extractErrorMessage } from "../../../lib/logging/errors";
import { isValidAssetSymbol } from "../../../lib/validation";
import { enqueueNewSymbolWarmup } from "../../../lib/vendors/backfill/enqueue";

const ASSETS_SCHEMA = {
	tracked_assets: { type: "json_string_array", required: true },
} as const satisfies FormSchema;

/**
 * POST /api/assets/update
 *
 * Atomically replace the authenticated user's tracked-asset list via the
 * `replace_user_assets` RPC. Called from the dashboard watchlist panel
 * (hidden `tracked_assets` JSON field). Validates symbol format, enforces
 * {@link MAX_TRACKED_ASSETS}, and rejects delisted tickers before writing.
 * New symbols enqueue vendor-backfill warmup (daily closes + stats) when
 * `VENDOR_BACKFILL_QUEUE_URL` is configured — same path as first-time adds
 * elsewhere in the app. Net-new symbols with no prior icon check also get an
 * immediate Massive branding probe so dashboard badges don't wait for the
 * nightly drip.
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
		logger.info("Tracked assets update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
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
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}
	const parsed = parseWithSchema(formData, ASSETS_SCHEMA);

	if (!parsed.ok) {
		logger.info("Tracked assets update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
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
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const uniqueSymbols = [...new Set(normalizedSymbols.filter(Boolean))];
	if (uniqueSymbols.length > MAX_TRACKED_ASSETS) {
		logger.info("Tracked assets limit exceeded", {
			userId: user.id,
			count: uniqueSymbols.length,
		});
		return Response.json({ ok: false, message: "assets_limit" } satisfies ApiJsonBody, {
			status: 400,
		});
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
			return Response.json(
				{
					ok: false,
					message: "failed_to_update_assets",
				} satisfies ApiJsonBody,
				{ status: 500 },
			);
		}

		if (delistedRows && delistedRows.length > 0) {
			const blocked = delistedRows.map((r) => r.symbol);
			logger.info("Tracked assets update rejected: contains delisted symbols", {
				userId: user.id,
				blocked,
			});
			return Response.json(
				{
					ok: false,
					message: "delisted_symbols",
					blocked,
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
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
		// Single RPC replaces the join table atomically — avoids partial updates.
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
			return Response.json({ ok: false, message: "assets_limit" } satisfies ApiJsonBody, {
				status: 400,
			});
		}

		if (isAssetsWhitespaceError(error)) {
			return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
				status: 400,
			});
		}

		return Response.json({ ok: false, message: "failed_to_update_assets" } satisfies ApiJsonBody, {
			status: 500,
		});
	}

	const previousSymbolSet = new Set(previousSymbols);
	// Warm up price-history cache for net-new symbols so sparklines and alerts
	// have closes on the next dashboard load without waiting for the nightly cron.
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

	// Probe Massive branding for net-new tracked symbols that have never been
	// icon-checked. Best-effort: failures leave the row unchecked for the
	// nightly tracked-first drip. Writes go through the admin client (assets
	// UPDATE is service_role-only).
	const admin = createSupabaseAdminClient();
	for (const symbol of uniqueSymbols) {
		if (previousSymbolSet.has(symbol)) continue;
		try {
			await ensureAssetIconChecked({ supabase: admin, logger, symbol });
		} catch (error) {
			logger.warn(
				"On-add icon probe failed",
				{ userId: user.id, symbol },
				createErrorForLogging(error),
			);
		}
	}

	return Response.json({ ok: true, message: "assets_updated" } satisfies ApiJsonBody, {
		status: 200,
	});
};
