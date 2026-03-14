import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIContext } from "astro";
import {
	MIN_PASSWORD_LENGTH,
	REGISTRATION_ENABLED,
} from "../../../../lib/constants";
import { getSiteUrl } from "../../../../lib/db/env";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger, type Logger } from "../../../../lib/logging";
import { resolveTimezone } from "../../../../lib/time/cache";

async function cleanupOrphanedAuthUser(
	adminSupabase: SupabaseClient,
	userId: string,
	logger: Logger,
): Promise<void> {
	const { error: deleteError } =
		await adminSupabase.auth.admin.deleteUser(userId);
	if (deleteError) {
		logger.error(
			"Failed to cleanup orphaned auth user after profile creation failure",
			{ userId },
			deleteError,
		);
	}
}

export async function POST({
	url,
	request,
	redirect,
	locals,
}: APIContext): Promise<Response> {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	if (!REGISTRATION_ENABLED) {
		return redirect("/auth/signin?error=registration_closed");
	}

	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
		password: { type: "string", required: true, trim: false },
		confirm: { type: "string", required: true, trim: false },
		timezone: { type: "timezone" },
	} as const);

	if (!parsed.ok) {
		logger.info("Registration attempt rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/auth/register?error=invalid_form");
	}

	const { email: rawEmail, password, confirm, timezone } = parsed.data;

	if (password.length < MIN_PASSWORD_LENGTH) {
		logger.info("Registration rejected: password too short", {
			passwordLength: password.length,
			minLength: MIN_PASSWORD_LENGTH,
		});
		return redirect("/auth/register?error=weak_password");
	}

	if (password !== confirm) {
		logger.info("Registration rejected: password mismatch");
		return redirect("/auth/register?error=password_mismatch");
	}

	// Trim email to satisfy our database constraints (no leading/trailing whitespace).
	// Supabase Auth doesn't enforce this constraint (external service owns its storage/constraints),
	// so we normalize at the application level before sending.
	const trimmedEmail = rawEmail.trim();

	const userTimezone = await resolveTimezone({
		supabase,
		detectedTimezone: timezone,
	});

	const origin = getSiteUrl();
	const emailRedirectTo = `${origin}/auth/verified`;

	const { data, error } = await supabase.auth.signUp({
		email: trimmedEmail,
		password,
		options: {
			emailRedirectTo,
		},
	});

	if (error) {
		if (error.code === "user_already_exists") {
			logger.info("User registration rejected: user already exists", {
				userAlreadyExists: true,
			});
			return redirect("/auth/register?error=user_already_exists");
		}
		logger.error(
			"User registration failed",
			{ email: trimmedEmail, errorCode: error.code, errorStatus: error.status },
			error,
		);
		return redirect("/auth/register?error=failed");
	}

	if (data.user) {
		// Use admin client to bypass RLS for user profile creation
		const adminSupabase = createSupabaseAdminClient();

		const userProfileData = {
			id: data.user.id,
			email: trimmedEmail,
			timezone: userTimezone,
		};

		const { error: profileError } = await adminSupabase
			.from("users")
			.upsert(userProfileData, {
				onConflict: "id",
			});

		if (profileError) {
			logger.error(
				"Failed to create user profile",
				{ userId: data.user.id, email: trimmedEmail },
				profileError,
			);
			await cleanupOrphanedAuthUser(adminSupabase, data.user.id, logger);
			return redirect("/auth/register?error=profile_creation_failed");
		}
	}

	return redirect(
		`/auth/unconfirmed?email=${encodeURIComponent(trimmedEmail)}`,
	);
}
