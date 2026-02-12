import type { APIRoute } from "astro";
import { jsonResponse } from "../../../../lib/api/json-response";
import { checkVerification } from "../../../../lib/auth/sms-verification";
import { VERIFICATION_EXPIRATION_MS } from "../../../../lib/constants";
import { createUserService } from "../../../../lib/db";
import {
	createSupabaseAdminClient,
	createSupabaseServerClient,
} from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

interface SmsVerifyCodeDependencies {
	createSupabaseServerClient: typeof createSupabaseServerClient;
	createSupabaseAdminClient: typeof createSupabaseAdminClient;
	createUserService: typeof createUserService;
	checkVerification: typeof checkVerification;
}

const defaultDependencies: SmsVerifyCodeDependencies = {
	createSupabaseServerClient,
	createSupabaseAdminClient,
	createUserService,
	checkVerification,
};

/**
 * Create an API handler for verifying an SMS OTP code.
 *
 * Dependency injection is supported for testing.
 */
export function createVerifyCodeHandler(
	overrides: Partial<SmsVerifyCodeDependencies> = {},
): APIRoute {
	const dependencies = { ...defaultDependencies, ...overrides };

	return async ({ request, cookies, locals }) => {
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
			return jsonResponse(401, {
				ok: false,
				message: "unauthorized",
				tone: "error",
			});
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
				return jsonResponse(400, {
					ok: false,
					message: "invalid_form",
					tone: "error",
				});
			}

			const code = parsed.data.code;

			const userData = await userService.getById(user.id);
			if (!userData) {
				logger.error("Auth user exists but database user record missing", {
					userId: user.id,
					endpoint: "sms/verify-code",
				});
				return jsonResponse(404, {
					ok: false,
					message: "user_not_found",
					tone: "error",
				});
			}
			if (!userData.phone_country_code || !userData.phone_number) {
				logger.info("SMS verification requested but phone details missing", {
					userId: user.id,
				});
				return jsonResponse(400, {
					ok: false,
					message: "phone_not_set",
					tone: "error",
				});
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
					return jsonResponse(400, {
						ok: false,
						message: "code_expired",
						tone: "error",
					});
				}
			}

			// Rate limit verification attempts to prevent brute force attacks
			const adminSupabase = dependencies.createSupabaseAdminClient();
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
				return jsonResponse(500, {
					ok: false,
					message: "server_error",
					tone: "error",
				});
			}

			if (rateLimitAllowed === false) {
				logger.info("User rate-limited for SMS verification attempts", {
					userId: user.id,
				});
				return jsonResponse(429, {
					ok: false,
					message: "verification_rate_limited",
					tone: "error",
				});
			}

			if (rateLimitAllowed !== true) {
				logger.error(
					"SMS verification rate limit check returned unexpected value",
					{
						userId: user.id,
						rateLimitAllowed,
					},
				);
				return jsonResponse(500, {
					ok: false,
					message: "server_error",
					tone: "error",
				});
			}

			const fullPhone = `${userData.phone_country_code}${userData.phone_number}`;
			const result = await dependencies.checkVerification(fullPhone, code);

			if (!result.success) {
				logger.info("Verification failed", { error: result.error });
				return jsonResponse(400, {
					ok: false,
					message: "invalid_code",
					tone: "error",
				});
			}

			await userService.update(user.id, {
				phone_verified: true,
				verification_sent_at: null,
			});

			return jsonResponse(200, {
				ok: true,
				message: "phone_verified",
				tone: "success",
			});
		} catch (error) {
			logger.error(
				"Verify code error",
				{ userId: user.id, action: "verify_sms_code" },
				error,
			);
			return jsonResponse(500, {
				ok: false,
				message: "server_error",
				tone: "error",
			});
		}
	};
}

export const POST = createVerifyCodeHandler();
