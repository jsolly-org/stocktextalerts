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
import { createLogger } from "../../../lib/logging";

const STOCKS_SCHEMA = {
	tracked_stocks: { type: "json_string_array", required: true },
} as const satisfies FormSchema;

export const POST: APIRoute = async ({
	request,
	cookies,
	redirect,
	locals,
}) => {
	const wantsJson = request.headers
		.get("accept")
		?.toLowerCase()
		.includes("application/json");
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
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "unauthorized" },
				{ status: 401 },
			);
		}
		return redirect("/signin?error=unauthorized");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, STOCKS_SCHEMA);

	if (!parsed.ok) {
		logger.info("Tracked stocks update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "invalid_form" },
				{ status: 400 },
			);
		}
		return redirect("/dashboard?error=invalid_form");
	}

	const trackedSymbols = parsed.data.tracked_stocks;
	if (trackedSymbols.length > MAX_TRACKED_STOCKS) {
		logger.info("Tracked stocks limit exceeded", {
			userId: user.id,
			count: trackedSymbols.length,
		});
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "stocks_limit" },
				{ status: 400 },
			);
		}
		return redirect("/dashboard?error=stocks_limit");
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
		const errorMessage = error instanceof Error ? error.message : String(error);

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
				error instanceof Error ? error : new Error(String(error)),
			);
		}

		if (isStocksLimitError(error)) {
			if (wantsJson) {
				return Response.json(
					{ ok: false, message: "stocks_limit" },
					{ status: 400 },
				);
			}
			return redirect("/dashboard?error=stocks_limit");
		}

		if (isStocksWhitespaceError(error)) {
			if (wantsJson) {
				return Response.json(
					{ ok: false, message: "invalid_form" },
					{ status: 400 },
				);
			}
			return redirect("/dashboard?error=invalid_form");
		}

		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "update_failed" },
				{ status: 500 },
			);
		}
		return redirect("/dashboard?error=update_failed");
	}

	if (wantsJson) {
		return Response.json({ ok: true, message: "stocks_updated" });
	}

	return redirect("/dashboard?success=stocks_updated");
};
