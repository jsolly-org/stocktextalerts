import type { APIRoute } from "astro";
import {
	buildDashboardRedirect,
	VERIFICATION_RESEND_COOLDOWN_MS,
} from "../../../../lib/constants";
import { createUserService } from "../../../../lib/db";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";
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
			logger.info("SMS verification send attempt without authenticated user", {
				reason: "unauthenticated",
			});
			return redirect("/signin?error=unauthorized");
		}

		try {
			const formData = await request.formData();

			const parsed = parseWithSchema(formData, {
				phone_country_code: { type: "string", required: true },
				phone_number: { type: "string", required: true },
			} as const);

			if (!parsed.ok) {
				// Expected rejection (often bots); info to avoid inflating error metrics.
				logger.info("SMS verification form rejected due to invalid fields", {
					errors: parsed.allErrors,
				});
				return redirect(preferencesRedirect({ error: "invalid_form" }));
			}

			const phoneCountryCode = parsed.data.phone_country_code;
			const phoneNationalNumber = parsed.data.phone_number;

			const fullPhone = `${phoneCountryCode}${phoneNationalNumber}`;

			const dbUser = await userService.getById(user.id);
			if (!dbUser) {
				logger.error("Auth user exists but database user record missing", {
					userId: user.id,
					endpoint: "sms/send-verification",
				});
				return redirect(preferencesRedirect({ error: "user_not_found" }));
			}
			if (dbUser.sms_opted_out) {
				logger.error("SMS verification send blocked due to opt-out", {
					userId: user.id,
				});
				return redirect(preferencesRedirect({ error: "sms_opted_out" }));
			}

			if (dbUser.verification_sent_at) {
				const sentAtMs = new Date(dbUser.verification_sent_at).getTime();
				const nowMs = Date.now();
				if (nowMs - sentAtMs < VERIFICATION_RESEND_COOLDOWN_MS) {
					// Expected rejection (often bots); info to avoid inflating error metrics.
					logger.info("SMS verification resend blocked due to cooldown", {
						userId: user.id,
						sentAt: dbUser.verification_sent_at,
						cooldownMs: VERIFICATION_RESEND_COOLDOWN_MS,
					});
					return redirect(
						preferencesRedirect({ warning: "verification_recently_sent" }),
					);
				}
			}

			await userService.update(user.id, {
				sms_notifications_enabled: true,
				phone_country_code: phoneCountryCode,
				phone_number: phoneNationalNumber,
				phone_verified: false,
				verification_sent_at: new Date().toISOString(),
			});

			const result = await dependencies.sendVerification(fullPhone);
			if (!result.success) {
				logger.error("SMS verification failed", { error: result.error });
				return redirect(preferencesRedirect({ error: "verification_failed" }));
			}

			return redirect(preferencesRedirect({ success: "verification_sent" }));
		} catch (error) {
			logger.error("Send verification error", { userId: user.id }, error);
			return redirect(preferencesRedirect({ error: "server_error" }));
		}
	};
}

export const POST = createSendVerificationHandler();
