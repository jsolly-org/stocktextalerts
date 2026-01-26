import type { APIRoute } from "astro";
import { buildDashboardRedirect } from "../../../lib/constants";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

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

	try {
		await users.update(authUser.id, {
			timezone: parsed.data.timezone,
		});
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

	if (wantsJson) {
		return Response.json({ ok: true, message: "timezone_updated" });
	}
	return redirect(
		buildDashboardRedirect({
			success: "timezone_updated",
			section: "preferences",
		}),
	);
};
