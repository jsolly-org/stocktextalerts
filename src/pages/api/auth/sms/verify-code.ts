import type { APIRoute } from "astro";
import { createUserService } from "../../../../lib/db";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";
import { checkVerification } from "./verify-utils";

interface SmsVerifyCodeDependencies {
	createSupabaseServerClient: typeof createSupabaseServerClient;
	createUserService: typeof createUserService;
	checkVerification: typeof checkVerification;
}

const defaultDependencies: SmsVerifyCodeDependencies = {
	createSupabaseServerClient,
	createUserService,
	checkVerification,
};

export function createVerifyCodeHandler(
	overrides: Partial<SmsVerifyCodeDependencies> = {},
): APIRoute {
	const dependencies = { ...defaultDependencies, ...overrides };

	return async ({ request, cookies, redirect, locals }) => {
		const url = new URL(request.url);
		const logger = createLogger({
			requestId: locals?.requestId,
			path: url.pathname,
			method: request.method,
		});
		const supabase = dependencies.createSupabaseServerClient();
		const userService = dependencies.createUserService(supabase, cookies);

		const user = await userService.getCurrentUser();
		if (!user) {
			// Expected rejection (often bots); info to avoid inflating error metrics.
			logger.info("SMS verification attempt without authenticated user", {
				reason: "unauthenticated",
			});
			return redirect("/signin?error=unauthorized");
		}

		try {
			const formData = await request.formData();
			const parsed = parseWithSchema(formData, {
				code: { type: "string", required: true },
			} as const);

			if (!parsed.ok) {
				// Expected rejection (often bots); info to avoid inflating error metrics.
				logger.info(
					"SMS verification code form rejected due to invalid fields",
					{ errors: parsed.allErrors },
				);
				return redirect("/dashboard?error=invalid_form");
			}

			const code = parsed.data.code;

			const userData = await userService.getById(user.id);
			if (!userData) {
				logger.error("Auth user exists but database user record missing", {
					userId: user.id,
					endpoint: "sms/verify-code",
				});
				return redirect("/dashboard?error=user_not_found");
			}
			if (!userData.phone_country_code || !userData.phone_number) {
				logger.error("SMS verification requested but phone details missing", {
					userId: user.id,
				});
				return redirect("/dashboard?error=phone_not_set");
			}

			const fullPhone = `${userData.phone_country_code}${userData.phone_number}`;
			const result = await dependencies.checkVerification(fullPhone, code);

			if (!result.success) {
				logger.error("Verification failed", { error: result.error });
				return redirect("/dashboard?error=invalid_code");
			}

			await userService.update(user.id, {
				phone_verified: true,
			});

			return redirect(
				"/dashboard?success=phone_verified#notification-preferences",
			);
		} catch (error) {
			logger.error(
				"Verify code error",
				{ userId: user.id, action: "verify_sms_code" },
				error,
			);
			return redirect("/dashboard?error=server_error");
		}
	};
}

export const POST = createVerifyCodeHandler();
