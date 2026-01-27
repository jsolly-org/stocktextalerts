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

			// `verification_sent_at` may not be present in generated types yet, but it *is* in the DB.
			const dbUserWithVerificationSentAt = dbUser as typeof dbUser & {
				verification_sent_at?: string | null;
			};

			// `reserve_sms_verification` may not be present in generated types yet, but it *is* in the DB.
			const supabaseWithUntrackedRpc = supabase as unknown as {
				rpc: (
					fn: string,
					args: Record<string, unknown>,
				) => Promise<{ data: unknown; error: unknown }>;
			};
			const { data: reserved, error: reserveError } =
				await supabaseWithUntrackedRpc.rpc("reserve_sms_verification", {
					p_user_id: dbUser.id,
					p_phone_country_code: phoneCountryCode,
					p_phone_number: phoneNationalNumber,
					p_cooldown_ms: VERIFICATION_RESEND_COOLDOWN_MS,
				});

			if (reserveError) throw reserveError;

			if (reserved === false) {
				// Expected rejection (often bots); info to avoid inflating error metrics.
				logger.info("SMS verification resend blocked due to cooldown", {
					userId: user.id,
					sentAt: dbUserWithVerificationSentAt.verification_sent_at ?? null,
					cooldownMs: VERIFICATION_RESEND_COOLDOWN_MS,
				});
				return redirect(
					preferencesRedirect({ warning: "verification_recently_sent" }),
				);
			}

			if (reserved !== true) {
				logger.error(
					"SMS verification cooldown reservation returned unexpected value",
					{
						userId: user.id,
						reserved,
					},
				);
				return redirect(preferencesRedirect({ error: "server_error" }));
			}

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
