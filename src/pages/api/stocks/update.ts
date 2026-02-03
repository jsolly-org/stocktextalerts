import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import {
	isStocksLimitError,
	isStocksWhitespaceError,
	MAX_TRACKED_STOCKS,
} from "../../../lib/db/database-errors";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { jsonResponse } from "../../../lib/json-response";
import { createLogger } from "../../../lib/logging";
import {
	createErrorForLogging,
	extractErrorMessage,
} from "../../../lib/logging/errors";

const STOCKS_SCHEMA = {
	tracked_stocks: { type: "json_string_array", required: true },
} as const satisfies FormSchema;

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
		logger.info("Tracked stocks update attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Tracked stocks update rejected due to malformed request body",
			{
				userId: user.id,
				error: extractErrorMessage(error),
				contentType: request.headers.get("content-type"),
			},
			createErrorForLogging(error),
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}
	const parsed = parseWithSchema(formData, STOCKS_SCHEMA);

	if (!parsed.ok) {
		logger.info("Tracked stocks update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const trackedSymbols = parsed.data.tracked_stocks;
	if (trackedSymbols.length > MAX_TRACKED_STOCKS) {
		logger.info("Tracked stocks limit exceeded", {
			userId: user.id,
			count: trackedSymbols.length,
		});
		return jsonResponse(400, { ok: false, message: "stocks_limit" });
	}

	try {
		const { error } = await supabase.rpc("replace_user_stocks", {
			user_id: user.id,
			symbols: trackedSymbols,
		});
		if (error) {
			throw error;
		}
	} catch (error) {
		const errorMessage = extractErrorMessage(error);

		if (isStocksLimitError(error) || isStocksWhitespaceError(error)) {
			logger.info("Tracked stocks update rejected due to invalid input", {
				userId: user.id,
				error: errorMessage,
			});
		} else {
			logger.error(
				"Failed to update tracked stocks",
				{
					userId: user.id,
					symbols: trackedSymbols,
					error: errorMessage,
				},
				createErrorForLogging(error),
			);
		}

		if (isStocksLimitError(error)) {
			return jsonResponse(400, { ok: false, message: "stocks_limit" });
		}

		if (isStocksWhitespaceError(error)) {
			return jsonResponse(400, { ok: false, message: "invalid_form" });
		}

		return jsonResponse(500, { ok: false, message: "failed_to_update_stocks" });
	}

	return jsonResponse(200, { ok: true, message: "stocks_updated" });
};
