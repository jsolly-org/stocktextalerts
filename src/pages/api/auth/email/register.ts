import type { SupabaseClient } from "@supabase/supabase-js";
import type { APIRoute } from "astro";
import { getSiteUrl } from "../../../../lib/db/env";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { redirect } from "../../../../lib/http/redirect";
import { resolveTimezone } from "../../../../lib/timezones/cache";

async function cleanupOrphanedAuthUser(
	adminSupabase: SupabaseClient,
	userId: string,
): Promise<void> {
	const { error: deleteError } =
		await adminSupabase.auth.admin.deleteUser(userId);
	if (deleteError) {
		console.error(
			"Failed to cleanup orphaned auth user after profile creation failure",
			{
				userId,
				error: deleteError,
			},
		);
	}
}

export const POST: APIRoute = async ({ request }) => {
	const supabase = createSupabaseServerClient();

	const formData = await request.formData();
	const parsed = parseWithSchema(formData, {
		email: { type: "string", required: true },
		password: { type: "string", required: true, trim: false },
		captcha_token: { type: "string", required: true },
		timezone: { type: "timezone" },
	} as const);

	if (!parsed.ok) {
		console.error("Registration attempt rejected due to invalid form", {
			errors: parsed.allErrors,
		});
		return redirect("/auth/register?error=invalid_form");
	}

	const {
		email: rawEmail,
		password,
		timezone,
		captcha_token: captchaToken,
	} = parsed.data;

	// Trim email to ensure consistency between Supabase Auth (auth.users) and our database
	// (public.users). This cannot be enforced at the database level because Supabase Auth
	// stores emails in its own auth.users table which doesn't have our whitespace constraint.
	// We must trim here to prevent registration failures when inserting into public.users.
	const email = rawEmail.trim();

	const userTimezone = await resolveTimezone({
		supabase,
		detectedTimezone: timezone,
	});

	const origin = getSiteUrl();
	const emailRedirectTo = `${origin}/auth/verified`;

	const { data, error } = await supabase.auth.signUp({
		email,
		password,
		options: {
			emailRedirectTo,
			captchaToken,
		},
	});

	if (error) {
		if (error.code === "captcha_failed") {
			console.error("User registration blocked due to captcha", {
				code: error.code,
				status: error.status,
			});
			return redirect("/auth/register?error=captcha_required");
		}

		if (error.code === "user_already_exists") {
			console.error("User registration rejected: user already exists", {
				email,
			});
			return redirect("/auth/register?error=user_already_exists");
		}
		console.error("User registration failed:", error);
		return redirect("/auth/register?error=failed");
	}

	if (data.user) {
		// Use admin client to bypass RLS for user profile creation
		const adminSupabase = createSupabaseAdminClient();

		const userProfileData = {
			id: data.user.id,
			email,
			timezone: userTimezone,
		};

		const { error: profileError } = await adminSupabase
			.from("users")
			.upsert(userProfileData, {
				onConflict: "id",
			})
			.select()
			.single();

		if (profileError) {
			console.error("Failed to create user profile:", profileError);
			await cleanupOrphanedAuthUser(adminSupabase, data.user.id);
			return redirect("/auth/register?error=profile_creation_failed");
		}
	}

	return redirect(`/auth/unconfirmed?email=${encodeURIComponent(email)}`);
};
