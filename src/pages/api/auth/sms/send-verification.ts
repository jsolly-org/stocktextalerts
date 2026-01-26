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

			// #region agent log
			const supabaseHost = (() => {
				try {
					return new URL(import.meta.env.PUBLIC_SUPABASE_URL).host;
				} catch {
					return "invalid";
				}
			})();
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:entry",
						message: "send-verification handler",
						data: { supabaseHost, userId: user.id },
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H1",
					}),
				},
			).catch(() => {});
			// #endregion

			const cutoff = new Date(
				Date.now() - VERIFICATION_RESEND_COOLDOWN_MS,
			).toISOString();
			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:before-cooldown-update",
						message: "before cooldown update",
						data: { userId: user.id },
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H2",
					}),
				},
			).catch(() => {});
			// #endregion
			const { data: cooldownUpdate, error: cooldownUpdateError } =
				await supabase
					.from("users")
					.update({
						sms_notifications_enabled: true,
						phone_country_code: phoneCountryCode,
						phone_number: phoneNationalNumber,
						phone_verified: false,
					})
					.eq("id", dbUser.id)
					.or(`verification_sent_at.is.null,verification_sent_at.lt.${cutoff}`)
					.select("id");

			if (cooldownUpdateError) throw cooldownUpdateError;
			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:after-cooldown-update",
						message: "after cooldown update",
						data: { userId: user.id, rowsAffected: cooldownUpdate.length },
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H2",
					}),
				},
			).catch(() => {});
			// #endregion

			const rowsAffected = cooldownUpdate.length;
			if (rowsAffected !== 1) {
				// Expected rejection (often bots); info to avoid inflating error metrics.
				logger.info("SMS verification resend blocked due to cooldown", {
					userId: user.id,
					sentAt: dbUser.verification_sent_at,
					cooldownMs: VERIFICATION_RESEND_COOLDOWN_MS,
					rowsAffected,
				});
				return redirect(
					preferencesRedirect({ warning: "verification_recently_sent" }),
				);
			}

			const result = await dependencies.sendVerification(fullPhone);
			if (!result.success) {
				logger.error("SMS verification failed", { error: result.error });
				return redirect(preferencesRedirect({ error: "verification_failed" }));
			}

			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:before-verification_sent_at-update",
						message: "before verification_sent_at update",
						data: { userId: user.id },
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H3",
					}),
				},
			).catch(() => {});
			// #endregion
			await userService.update(user.id, {
				verification_sent_at: new Date().toISOString(),
			});
			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:after-verification_sent_at-update",
						message: "after verification_sent_at update",
						data: { userId: user.id },
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H3",
					}),
				},
			).catch(() => {});
			// #endregion

			return redirect(preferencesRedirect({ success: "verification_sent" }));
		} catch (error) {
			// #region agent log
			fetch(
				"http://127.0.0.1:7242/ingest/e653b75a-9cbd-4d01-b4d5-c28f45a9f0f1",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						location: "send-verification.ts:catch",
						message: "Send verification error path",
						data: {
							userId: user.id,
							errorCode:
								error && typeof error === "object" && "code" in error
									? (error as { code: string }).code
									: undefined,
							errorMessage:
								error instanceof Error ? error.message : String(error),
						},
						timestamp: Date.now(),
						sessionId: "debug-session",
						hypothesisId: "H2",
					}),
				},
			).catch(() => {});
			// #endregion
			logger.error("Send verification error", { userId: user.id }, error);
			return redirect(preferencesRedirect({ error: "server_error" }));
		}
	};
}

export const POST = createSendVerificationHandler();
