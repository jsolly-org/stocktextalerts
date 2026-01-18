import type { APIRoute } from "astro";
import { parseWithSchema } from "../../../../lib/forms/parsing";
import { createSupabaseServerClient } from "../../../../lib/supabase";
import { createUserService } from "../../../../lib/users";
import { sendVerification } from "./verify-utils";

interface SmsSendVerificationDependencies {
	createSupabaseServerClient: typeof createSupabaseServerClient;
	createUserService: typeof createUserService;
	sendVerification: typeof sendVerification;
}

const defaultDependencies: SmsSendVerificationDependencies = {
	createSupabaseServerClient,
	createUserService,
	sendVerification,
};

export function createSendVerificationHandler(
	overrides: Partial<SmsSendVerificationDependencies> = {},
): APIRoute {
	const dependencies = { ...defaultDependencies, ...overrides };

	return async ({ request, cookies, redirect }) => {
		const supabase = dependencies.createSupabaseServerClient();
		const userService = dependencies.createUserService(supabase, cookies);

		const user = await userService.getCurrentUser();
		if (!user) {
			console.error("SMS verification send attempt without authenticated user");
			return redirect("/signin?error=unauthorized");
		}

		try {
			const formData = await request.formData();

			const parsed = parseWithSchema(formData, {
				phone_country_code: { type: "string", required: true },
				phone_national_number: { type: "string", required: true },
			} as const);

			if (!parsed.ok) {
				console.error("SMS verification form rejected due to invalid fields", {
					errors: parsed.allErrors,
				});
				return redirect("/dashboard?error=invalid_form");
			}

			const phoneCountryCode = parsed.data.phone_country_code;
			const phoneNationalNumber = parsed.data.phone_national_number;

			const fullPhone = `${phoneCountryCode}${phoneNationalNumber}`;

			const dbUser = await userService.getById(user.id);
			if (!dbUser) {
				console.error(
					`Auth user exists but database user record missing - ID: ${user.id}, email: ${user.email}, endpoint: sms/send-verification`,
				);
				return redirect("/dashboard?error=user_not_found");
			}
			if (dbUser.sms_opted_out) {
				console.error("SMS verification send blocked due to opt-out", {
					userId: user.id,
				});
				return redirect("/dashboard?error=sms_opted_out");
			}

			await userService.update(user.id, {
				sms_notifications_enabled: true,
				phone_country_code: phoneCountryCode,
				phone_number: phoneNationalNumber,
				phone_verified: false,
			});

			const result = await dependencies.sendVerification(fullPhone);
			if (!result.success) {
				console.error("SMS verification failed:", result.error);
				return redirect("/dashboard?error=verification_failed");
			}

			return redirect(
				"/dashboard?success=verification_sent#notification-preferences",
			);
		} catch (error) {
			console.error("Send verification error:", error);
			return redirect("/dashboard?error=server_error");
		}
	};
}

export const POST = createSendVerificationHandler();
