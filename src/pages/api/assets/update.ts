import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import {
	isAssetsLimitError,
	isAssetsWhitespaceError,
	MAX_TRACKED_ASSETS,
} from "../../../lib/db/database-errors";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";
import {
	createErrorForLogging,
	extractErrorMessage,
} from "../../../lib/logging/errors";

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
				error: extractErrorMessage(error),
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
	if (trackedSymbols.length > MAX_TRACKED_ASSETS) {
		logger.info("Tracked assets limit exceeded", {
			userId: user.id,
			count: trackedSymbols.length,
		});
		return jsonResponse(400, { ok: false, message: "assets_limit" });
	}

	try {
		const { error } = await supabase.rpc("replace_user_assets", {
			user_id: user.id,
			symbols: trackedSymbols,
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
				{
					userId: user.id,
					symbols: trackedSymbols,
					error: errorMessage,
				},
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

	return jsonResponse(200, { ok: true, message: "assets_updated" });
};
