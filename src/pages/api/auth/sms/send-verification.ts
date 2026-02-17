import type { APIRoute } from "astro";
import { jsonResponse } from "../../../../lib/api/json-response";
import { sendVerification } from "../../../../lib/auth/sms-verification";
import { VERIFICATION_RESEND_COOLDOWN_MS } from "../../../../lib/constants";
import { createUserService } from "../../../../lib/db";
import { createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

/**
 * POST /api/auth/sms/send-verification
 *
 * Sends an SMS verification code to the authenticated user's phone number.
 * Expects form fields: phone_country_code, phone_number.
 * Applies cooldown between sends; returns 429 if a verification was recently sent.
 */
export const POST: APIRoute = async ({ request, cookies, locals }) => {
	const url = new URL(request.url);
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});
	const supabase = createSupabaseServerClient();
	const userService = createUserService(supabase, cookies);

	const user = await userService.getCurrentUser();
	if (!user) {
		// Expected rejection (often bots); info to avoid inflating error metrics.
		logger.info("SMS verification send attempt without authenticated user", {
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
			phone_country_code: { type: "string", required: true },
			phone_number: { type: "string", required: true },
		} as const);

		if (!parsed.ok) {
			// Expected rejection (often bots); info to avoid inflating error metrics.
			logger.info("SMS verification form rejected due to invalid fields", {
				errors: parsed.allErrors,
			});
			return jsonResponse(400, {
				ok: false,
				message: "invalid_form",
				tone: "error",
			});
		}

		// Normalize phone inputs: the external auth/storage service controls its own
		// constraints, so E.164 format must be enforced at the application layer.
		const rawCountryCode = parsed.data.phone_country_code
			.trim()
			.replace(/\s+/g, "");
		const rawNational = parsed.data.phone_number.trim().replace(/\s+/g, "");
		const normalizedCountryCode = `+${rawCountryCode.replace(/^\+/, "").replace(/\D/g, "")}`;
		const phoneNationalNumber = rawNational.replace(/\D/g, "");

		const fullPhone = `${normalizedCountryCode}${phoneNationalNumber}`;

		// E.164: + followed by 7–15 digits total.
		if (!/^\+\d{7,15}$/.test(fullPhone)) {
			logger.info("SMS verification rejected due to invalid phone format", {
				userId: user.id,
			});
			return jsonResponse(400, {
				ok: false,
				message: "invalid_phone_format",
				tone: "error",
			});
		}

		const dbUser = await userService.getById(user.id);
		if (!dbUser) {
			logger.error("Auth user exists but database user record missing", {
				userId: user.id,
				endpoint: "sms/send-verification",
			});
			return jsonResponse(404, {
				ok: false,
				message: "user_not_found",
				tone: "error",
			});
		}

		if (dbUser.sms_opted_out) {
			logger.info("SMS verification blocked: user has opted out of SMS", {
				userId: user.id,
			});
			return jsonResponse(400, {
				ok: false,
				message: "sms_opted_out",
				tone: "warning",
			});
		}

		const previousVerificationSentAt = dbUser.verification_sent_at ?? null;

		const { data: reserved, error: reserveError } = await supabase.rpc(
			"reserve_sms_verification",
			{
				p_user_id: dbUser.id,
				p_phone_country_code: normalizedCountryCode,
				p_phone_number: phoneNationalNumber,
				p_cooldown_ms: VERIFICATION_RESEND_COOLDOWN_MS,
			},
		);

		if (reserveError) throw reserveError;

		if (reserved === false) {
			// Expected rejection (often bots); info to avoid inflating error metrics.
			logger.info("SMS verification resend blocked due to cooldown", {
				userId: user.id,
				sentAt: dbUser.verification_sent_at ?? null,
				cooldownMs: VERIFICATION_RESEND_COOLDOWN_MS,
			});
			return jsonResponse(429, {
				ok: false,
				message: "verification_recently_sent",
				tone: "warning",
			});
		}

		if (reserved !== true) {
			logger.error(
				"SMS verification cooldown reservation returned unexpected value",
				{
					userId: user.id,
					reserved,
				},
			);
			return jsonResponse(500, {
				ok: false,
				message: "server_error",
				tone: "error",
			});
		}

		const dbUserAfterReserve = await userService.getById(user.id);
		if (!dbUserAfterReserve) {
			logger.error(
				"Database user record missing after SMS verification reservation",
				{
					userId: user.id,
					endpoint: "sms/send-verification",
				},
			);
			return jsonResponse(500, {
				ok: false,
				message: "server_error",
				tone: "error",
			});
		}

		const reservedVerificationSentAt = dbUserAfterReserve.verification_sent_at;

		if (!reservedVerificationSentAt) {
			logger.error(
				"SMS verification reservation succeeded but verification_sent_at was not set",
				{
					userId: user.id,
				},
			);
			return jsonResponse(500, {
				ok: false,
				message: "server_error",
				tone: "error",
			});
		}

		const result = await sendVerification(fullPhone);
		if (!result.success) {
			const { data: rolledBack, error: rollbackError } = await supabase.rpc(
				"rollback_sms_verification_reservation",
				{
					p_user_id: dbUser.id,
					p_expected_verification_sent_at: reservedVerificationSentAt,
					p_restore_verification_sent_at: previousVerificationSentAt,
				},
			);

			if (rollbackError || rolledBack !== true) {
				logger.error(
					"Failed to rollback SMS verification reservation after send failure",
					{
						userId: user.id,
						rolledBack,
						reservedVerificationSentAt,
						previousVerificationSentAt,
					},
					rollbackError ?? undefined,
				);
			}

			const sendError = new Error(
				result.error ?? "Failed to send verification",
			);
			logger.error("SMS verification failed", { userId: user.id }, sendError);
			return jsonResponse(500, {
				ok: false,
				message: "verification_failed",
				tone: "error",
			});
		}

		return jsonResponse(200, {
			ok: true,
			message: "verification_sent",
			tone: "success",
		});
	} catch (error) {
		logger.error("Send verification error", { userId: user.id }, error);
		return jsonResponse(500, {
			ok: false,
			message: "server_error",
			tone: "error",
		});
	}
};
