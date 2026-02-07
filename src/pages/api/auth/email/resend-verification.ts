import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/db/env";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

export const POST: APIRoute = async ({ request, redirect, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
	} as const);

	if (!parsed.ok) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("Resend verification request rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/auth/unconfirmed?error=invalid_form");
	}

	// Trim email to satisfy our database constraints (no leading/trailing whitespace).
	// Supabase Auth doesn't enforce this constraint (external service owns its storage/constraints),
	// so we normalize at the application level before sending.
	const email = parsed.data.email.trim();

	const origin = getSiteUrl();
	const emailRedirectTo = `${origin}/auth/verified`;

	const { error } = await supabase.auth.resend({
		type: "signup",
		email,
		options: {
			emailRedirectTo,
		},
	});

	if (error) {
		logger.error(
			"Resend verification email failed",
			{ email, errorCode: error.code, errorStatus: error.status },
			error,
		);
		return redirect(
			`/auth/unconfirmed?email=${encodeURIComponent(email)}&error=failed`,
		);
	}

	return redirect(
		`/auth/unconfirmed?email=${encodeURIComponent(email)}&success=true`,
	);
};
