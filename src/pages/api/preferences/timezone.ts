import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { buildDashboardRedirect } from "../../../lib/constants";
import { createUserService, type User } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";
import { calculateNextSendAt } from "../../../lib/time/schedule";

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
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Timezone update attempt without authenticated user", {
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
	const parsed = parseWithSchema(formData, {
		timezone: { type: "timezone", required: true },
	} as const);

	if (!parsed.ok) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Timezone update rejected due to invalid form", {
			userId: authUser.id,
			errors: parsed.allErrors,
		});
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "invalid_form" },
				{ status: 400 },
			);
		}
		return redirect(
			buildDashboardRedirect({ error: "invalid_form", section: "preferences" }),
		);
	}

	let dbUser: User | null;
	try {
		dbUser = await users.getById(authUser.id);
	} catch (error) {
		const errorObject =
			error instanceof Error ? error : new Error(String(error));
		logger.error(
			"Failed to fetch user for timezone update",
			{ userId: authUser.id },
			errorObject,
		);
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "server_error" },
				{ status: 500 },
			);
		}
		return redirect(
			buildDashboardRedirect({
				error: "failed_to_update_timezone",
				section: "preferences",
			}),
		);
	}
	if (!dbUser) {
		logger.info("User not found for timezone update", { userId: authUser.id });
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "user_not_found" },
				{ status: 404 },
			);
		}
		return redirect("/signin?error=user_not_found");
	}

	const timezoneChanged = parsed.data.timezone !== dbUser.timezone;
	const updatePayload: { timezone: string; next_send_at?: string | null } = {
		timezone: parsed.data.timezone,
	};
	if (timezoneChanged && dbUser.daily_digest_enabled) {
		const nextSendAt = calculateNextSendAt(
			dbUser.daily_digest_notification_time,
			parsed.data.timezone,
			DateTime.utc(),
		);
		if (nextSendAt) {
			const nextSendAtIso = nextSendAt.toISO();
			if (nextSendAtIso) {
				updatePayload.next_send_at = nextSendAtIso;
			}
		}
	}

	let updatedUser: User;
	try {
		updatedUser = await users.update(authUser.id, updatePayload);
	} catch (error) {
		const errorObject =
			error instanceof Error ? error : new Error(String(error));
		logger.error(
			"Failed to update timezone",
			{
				userId: authUser.id,
				timezone: parsed.data.timezone,
			},
			errorObject,
		);
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "failed_to_update_timezone" },
				{ status: 500 },
			);
		}
		return redirect(
			buildDashboardRedirect({
				error: "failed_to_update_timezone",
				section: "preferences",
			}),
		);
	}
	if (!updatedUser) {
		logger.error("User update returned null", { userId: authUser.id });
		if (wantsJson) {
			return Response.json(
				{ ok: false, message: "user_not_found" },
				{ status: 404 },
			);
		}
		return redirect("/signin?error=user_not_found");
	}

	if (wantsJson) {
		return Response.json({
			ok: true,
			message: "timezone_updated",
			preferences: {
				timezone: updatedUser.timezone,
				next_send_at: updatedUser.next_send_at,
			},
		});
	}
	return redirect(
		buildDashboardRedirect({
			success: "timezone_updated",
			section: "preferences",
		}),
	);
};
