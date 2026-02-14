import type { APIRoute } from "astro";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import type { FormSchema } from "../../../lib/forms/schema";
import { createLogger } from "../../../lib/logging";

const FORMAT_PREFERENCES_SCHEMA = {
	show_sparklines: { type: "boolean" },
	show_company_name: { type: "boolean" },
	detailed_format: { type: "boolean" },
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
		logger.info(
			"Format-preferences update attempt without authenticated user",
			{ reason: "unauthenticated" },
		);
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}

	let formData: FormData;
	try {
		formData = await request.formData();
	} catch (error) {
		logger.info(
			"Format-preferences update rejected due to malformed request body",
			{
				userId: user.id,
				contentType: request.headers.get("content-type"),
			},
			error,
		);
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const parsed = parseWithSchema(formData, FORMAT_PREFERENCES_SCHEMA);

	if (!parsed.ok) {
		logger.info("Format-preferences update rejected due to invalid form", {
			userId: user.id,
			errors: parsed.allErrors,
		});
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	try {
		const updates: Record<string, boolean> = {};
		if (parsed.data.show_sparklines !== undefined) {
			updates.show_sparklines = parsed.data.show_sparklines;
		}
		if (parsed.data.show_company_name !== undefined) {
			updates.show_company_name = parsed.data.show_company_name;
		}
		if (parsed.data.detailed_format !== undefined) {
			updates.detailed_format = parsed.data.detailed_format;
		}

		const updatedUser = await userService.update(user.id, updates);
		if (!updatedUser) {
			logger.error("User update returned null", { userId: user.id });
			return jsonResponse(404, { ok: false, message: "user_not_found" });
		}

		return jsonResponse(200, {
			ok: true,
			message: "settings_updated",
			formatPreferences: {
				show_sparklines: updatedUser.show_sparklines,
				show_company_name: updatedUser.show_company_name,
				detailed_format: updatedUser.detailed_format,
			},
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(
			"Failed to update format-preferences",
			{
				userId: user.id,
				error: errorMessage,
			},
			error instanceof Error ? error : new Error(String(error)),
		);

		return jsonResponse(500, {
			ok: false,
			message: "failed_to_update_settings",
		});
	}
};
