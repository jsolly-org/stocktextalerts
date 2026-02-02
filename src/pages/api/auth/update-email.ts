import type { APIRoute } from "astro";
import { createUserService } from "../../../lib/db";
import { getSiteUrl } from "../../../lib/db/env";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { parseWithSchema } from "../../../lib/forms/parse";
import { createLogger } from "../../../lib/logging";

export const POST: APIRoute = async ({
	request,
	redirect,
	locals,
	cookies,
}) => {
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
		logger.info("Email change requested without authenticated user", {
			reason: "unauthenticated",
		});
		return redirect("/auth/signin?error=unauthorized");
	}

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		logger.info("Email change request rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/profile?error=invalid_form");
	}

	// Trim email to satisfy our database constraints (no leading/trailing whitespace).
	// Supabase Auth doesn't enforce this constraint (external service owns its storage/constraints),
	// so we normalize at the application level before sending.
	const trimmedEmail = parsed.data.email.trim();

	if (
		authUser.email &&
		trimmedEmail.toLowerCase() === authUser.email.toLowerCase()
	) {
		logger.info("Email change request rejected: same as current email", {
			userId: authUser.id,
		});
		return redirect("/profile?error=email_unchanged");
	}

	const origin = getSiteUrl();
	const emailRedirectTo = `${origin}/auth/verified`;

	const { error } = await supabase.auth.updateUser(
		{ email: trimmedEmail },
		{ emailRedirectTo },
	);

	if (error) {
		const isExpected =
			error.status === 400 || error.status === 401 || error.status === 403;
		const log = isExpected ? logger.info : logger.error;
		log(
			"Email change request failed",
			{
				userId: authUser.id,
				email: trimmedEmail,
				errorCode: error.code,
				errorStatus: error.status,
			},
			error,
		);
		return redirect("/profile?error=email_change_failed");
	}

	return redirect("/profile?success=email_change_requested");
};
