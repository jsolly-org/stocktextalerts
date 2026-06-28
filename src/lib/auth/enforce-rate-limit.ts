import type { AppSupabaseClient } from "../db/supabase";
import type { Logger } from "../logging";

type AuthRateLimitEndpoint = "change_password" | "change_email" | "delete_account";

/**
 * Checks auth rate limit via check_rate_limit RPC. Returns a redirect Response
 * on failure, exceeded, or unexpected result; returns null when allowed.
 */
export async function enforceAuthRateLimit(params: {
	adminSupabase: AppSupabaseClient;
	userId: string;
	endpoint: AuthRateLimitEndpoint;
	maxRequests: number;
	windowMinutes: number;
	logger: Logger;
	contextLabel: string;
}): Promise<Response | null> {
	const { adminSupabase, userId, endpoint, maxRequests, windowMinutes, logger, contextLabel } =
		params;

	const { data: rateLimitAllowed, error: rateLimitError } = await adminSupabase.rpc(
		"check_rate_limit",
		{
			p_user_id: userId,
			p_endpoint: endpoint,
			p_max_requests: maxRequests,
			p_window_minutes: windowMinutes,
		},
	);

	if (rateLimitError) {
		logger.error(`Rate limit check failed for ${contextLabel}`, { userId }, rateLimitError);
		return new Response(null, {
			status: 302,
			headers: { Location: "/profile?error=failed" },
		});
	}

	if (rateLimitAllowed === false) {
		logger.info(`User rate-limited for ${contextLabel} attempts`, { userId });
		return new Response(null, {
			status: 302,
			headers: {
				Location: `/profile?error=rate_limit&minutes=${windowMinutes}`,
			},
		});
	}

	if (rateLimitAllowed !== true) {
		logger.error(`${contextLabel} rate limit check returned unexpected value`, {
			userId,
			rateLimitAllowed,
		});
		return new Response(null, {
			status: 302,
			headers: { Location: "/profile?error=failed" },
		});
	}

	return null;
}
