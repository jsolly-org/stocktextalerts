import type { APIRoute } from "astro";
import type { ApiJsonBody } from "../../../lib/api/types";
import { mintLinkToken } from "../../../lib/auth/deep-link-token";
import { createUserService } from "../../../lib/db";
import { requireEnv } from "../../../lib/db/env";
import { createSupabaseAdminClient, createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { createErrorForLogging } from "../../../lib/logging/errors";

/** Linking tokens are single-use and short-lived: 10 minutes. */
const LINK_TOKEN_TTL_MS = 10 * 60 * 1000;

/**
 * POST /api/telegram/link
 *
 * Mint a short-TTL, single-use Telegram linking token for the authenticated
 * user and return a `t.me/<bot>?start=<token>` deep link. The token's nonce is
 * persisted in `telegram_link_tokens` bound to THIS user's id (the signed
 * subject); the bot webhook resolves the nonce back to the user and links the
 * chat. The token itself never carries the user id.
 */
export const POST: APIRoute = async ({ url, request, cookies, locals }) => {
	const logger = createLogger({
		requestId: locals?.requestId,
		path: url.pathname,
		method: request.method,
	});

	const supabase = createSupabaseServerClient();
	const users = createUserService(supabase, cookies);

	const authUser = await users.getCurrentUser();
	if (!authUser) {
		logger.info("Telegram link attempt without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}

	const { token, nonce, expiresAtMs } = mintLinkToken({
		userId: authUser.id,
		ttlMs: LINK_TOKEN_TTL_MS,
	});

	const admin = createSupabaseAdminClient();
	const { error } = await admin.from("telegram_link_tokens").insert({
		nonce,
		user_id: authUser.id,
		expires_at: new Date(expiresAtMs).toISOString(),
		consumed_at: null,
	});
	if (error) {
		logger.error(
			"Failed to persist Telegram link token",
			{ userId: authUser.id },
			createErrorForLogging(error),
		);
		return Response.json({ ok: false, message: "failed_to_create_link" } satisfies ApiJsonBody, {
			status: 500,
		});
	}

	// The server owns the link shape: the app deep link, the web client URL, and
	// the raw `/start <token>` command browser-only users paste into web Telegram.
	// Returning all three keeps the client from reverse-engineering the URL.
	const botUsername = requireEnv("TELEGRAM_BOT_USERNAME");
	const deepLink = `https://t.me/${botUsername}?start=${token}`;
	const webUrl = `https://web.telegram.org/k/#@${botUsername}`;
	const startCommand = `/start ${token}`;

	logger.info("Minted Telegram link token", { userId: authUser.id });

	return Response.json(
		{
			ok: true,
			message: "link_created",
			deepLink,
			webUrl,
			botUsername,
			startCommand,
		} satisfies ApiJsonBody,
		{ status: 200 },
	);
};
