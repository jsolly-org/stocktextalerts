import type { APIRoute } from "astro";
import {
	buildDashboardRedirect,
	VERIFICATION_EXPIRATION_MS,
} from "../../../../lib/constants";
import { createUserService } from "../../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../../lib/db/supabase";
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

/** Builds the SMS verification "verify code" API route handler (dependency-injectable for tests). */
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
		const preferencesRedirect = (params: {
			success?: string;
			error?: string;
			warning?: string;
		}) => buildDashboardRedirect({ ...params, section: "preferences" });

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
				return redirect(preferencesRedirect({ error: "invalid_form" }));
			}

			const code = parsed.data.code;

			const userData = await userService.getById(user.id);
			if (!userData) {
				logger.error("Auth user exists but database user record missing", {
					userId: user.id,
					endpoint: "sms/verify-code",
				});
				return redirect(preferencesRedirect({ error: "user_not_found" }));
			}
			if (!userData.phone_country_code || !userData.phone_number) {
				logger.error("SMS verification requested but phone details missing", {
					userId: user.id,
				});
				return redirect(preferencesRedirect({ error: "phone_not_set" }));
			}

			// Check if verification code has expired.
			if (userData.verification_sent_at) {
				const sentAt = new Date(userData.verification_sent_at);
				const now = new Date();
				if (now.getTime() - sentAt.getTime() > VERIFICATION_EXPIRATION_MS) {
					logger.info("SMS verification code expired", {
						userId: user.id,
						sentAt: userData.verification_sent_at,
					});
					return redirect(preferencesRedirect({ error: "code_expired" }));
				}
			}

			// Rate limit verification attempts to prevent brute force attacks
			const adminSupabase = createSupabaseAdminClient();
			const { data: rateLimitAllowed, error: rateLimitError } =
				await adminSupabase.rpc("check_rate_limit", {
					p_user_id: user.id,
					p_endpoint: "sms_verify_code",
					p_max_requests: 10,
					p_window_minutes: 15,
				});

			if (rateLimitError) {
				logger.error(
					"Rate limit check failed for SMS verification",
					{ userId: user.id },
					rateLimitError,
				);
				return redirect(preferencesRedirect({ error: "server_error" }));
			}

			if (rateLimitAllowed === false) {
				logger.info("User rate-limited for SMS verification attempts", {
					userId: user.id,
				});
				return redirect(
					preferencesRedirect({ error: "verification_rate_limited" }),
				);
			}

			if (rateLimitAllowed !== true) {
				logger.error(
					"SMS verification rate limit check returned unexpected value",
					{
						userId: user.id,
						rateLimitAllowed,
					},
				);
				return redirect(preferencesRedirect({ error: "server_error" }));
			}

			const fullPhone = `${userData.phone_country_code}${userData.phone_number}`;
			const result = await dependencies.checkVerification(fullPhone, code);

			if (!result.success) {
				logger.error("Verification failed", { error: result.error });
				return redirect(preferencesRedirect({ error: "invalid_code" }));
			}

			await userService.update(user.id, {
				phone_verified: true,
				verification_sent_at: null,
			});

			return redirect(preferencesRedirect({ success: "phone_verified" }));
		} catch (error) {
			logger.error(
				"Verify code error",
				{ userId: user.id, action: "verify_sms_code" },
				error,
			);
			return redirect(preferencesRedirect({ error: "server_error" }));
		}
	};
}

/** Astro `POST` handler for verifying a submitted SMS code. */
export const POST = createVerifyCodeHandler();
