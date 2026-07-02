import type { APIRoute } from "astro";
import { checkVerification } from "../../../../lib/auth/sms-verification";
import { createUserService } from "../../../../lib/auth/user-service";
import type { ApiJsonBody } from "../../../../lib/client/types";
import { VERIFICATION_EXPIRATION_MS } from "../../../../lib/constants";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../../lib/db/supabase";
import { parseWithSchema } from "../../../../lib/forms/parse";
import { createLogger } from "../../../../lib/logging";

/**
 * POST /api/auth/sms/verify-code
 *
 * Verifies the SMS code submitted by the authenticated user.
 * Expects form field: code.
 * Marks phone_verified and enables sms_notifications if not opted out.
 * Rate-limited and rejects expired codes.
 */
export const POST: APIRoute = async ({ url, request, cookies, locals }) => {
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
		logger.info("SMS verification attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json(
			{
				ok: false,
				message: "unauthorized",
				tone: "error",
			} satisfies ApiJsonBody,
			{ status: 401 },
		);
	}

	try {
		const formData = await request.formData();
		const parsed = parseWithSchema(formData, {
			code: { type: "string", required: true },
		} as const);

		if (!parsed.ok) {
			// Expected rejection (often bots); info to avoid inflating error metrics.
			logger.info("SMS verification code form rejected due to invalid fields", {
				errors: parsed.allErrors,
			});
			return Response.json(
				{
					ok: false,
					message: "invalid_form",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		const code = parsed.data.code;

		const userData = await userService.getById(user.id);
		if (!userData) {
			logger.error("Auth user exists but database user record missing", {
				userId: user.id,
				endpoint: "sms/verify-code",
			});
			return Response.json(
				{
					ok: false,
					message: "user_not_found",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 404 },
			);
		}
		if (!userData.phone_country_code || !userData.phone_number) {
			logger.info("SMS verification requested but phone details missing", {
				userId: user.id,
			});
			return Response.json(
				{
					ok: false,
					message: "phone_not_set",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		if (!userData.verification_sent_at) {
			logger.info("SMS verification attempted without prior code request", {
				userId: user.id,
			});
			return Response.json(
				{
					ok: false,
					message: "no_code_requested",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		// Check if verification code has expired.
		const sentAt = new Date(userData.verification_sent_at);
		const now = new Date();
		if (now.getTime() - sentAt.getTime() > VERIFICATION_EXPIRATION_MS) {
			logger.info("SMS verification code expired", {
				userId: user.id,
				sentAt: userData.verification_sent_at,
			});
			return Response.json(
				{
					ok: false,
					message: "code_expired",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		// Rate limit verification attempts to prevent brute force attacks
		const adminSupabase = createSupabaseAdminClient();
		const { data: rateLimitAllowed, error: rateLimitError } = await adminSupabase.rpc(
			"check_rate_limit",
			{
				p_user_id: user.id,
				p_endpoint: "sms_verify_code",
				p_max_requests: 10,
				p_window_minutes: 15,
			},
		);

		if (rateLimitError) {
			logger.error(
				"Rate limit check failed for SMS verification",
				{ userId: user.id },
				rateLimitError,
			);
			return Response.json(
				{
					ok: false,
					message: "server_error",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 500 },
			);
		}

		if (rateLimitAllowed === false) {
			logger.info("User rate-limited for SMS verification attempts", {
				userId: user.id,
			});
			return Response.json(
				{
					ok: false,
					message: "verification_rate_limited",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 429 },
			);
		}

		if (rateLimitAllowed !== true) {
			logger.error("SMS verification rate limit check returned unexpected value", {
				userId: user.id,
				rateLimitAllowed,
			});
			return Response.json(
				{
					ok: false,
					message: "server_error",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 500 },
			);
		}

		const fullPhone = `${userData.phone_country_code}${userData.phone_number}`;
		const result = await checkVerification(fullPhone, code);

		if (!result.success) {
			logger.info("Verification failed", { error: result.error });
			return Response.json(
				{
					ok: false,
					message: "invalid_code",
					tone: "error",
				} satisfies ApiJsonBody,
				{ status: 400 },
			);
		}

		const updates = {
			phone_verified: true,
			verification_sent_at: null,
			...(userData.sms_opted_out ? {} : { sms_notifications_enabled: true }),
		};
		await userService.update(user.id, updates);

		return Response.json(
			{
				ok: true,
				message: "phone_verified",
				tone: "success",
			} satisfies ApiJsonBody,
			{ status: 200 },
		);
	} catch (error) {
		logger.error("Verify code error", { userId: user.id, action: "verify_sms_code" }, error);
		return Response.json(
			{
				ok: false,
				message: "server_error",
				tone: "error",
			} satisfies ApiJsonBody,
			{ status: 500 },
		);
	}
};
