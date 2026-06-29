import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { userLocalToEtMinute } from "../../../lib/time/conversion";
import { calculateNextMarketScheduledSendAtFromTimes } from "../../../lib/time/schedule/market-next-send";
import { parseScheduledTimes } from "../../../lib/time/schedule/next-send";
import type { ApiJsonBody } from "../types";

/** Max time inputs to accept (DoS mitigation; DB allows fewer). */
const MAX_TIME_INPUTS = 32;
/** Max timezone string length (IANA names are ~40 chars; cap to avoid abuse). */
const MAX_TIMEZONE_LENGTH = 64;

interface NextSendAtRequestBody {
	timezone?: unknown;
	timeInputs?: unknown;
}

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
		logger.info("Next-send-at request without authenticated user", {
			reason: "unauthenticated",
		});
		return Response.json({ ok: false, message: "unauthorized" } satisfies ApiJsonBody, {
			status: 401,
		});
	}
	let body: NextSendAtRequestBody;
	try {
		body = (await request.json()) as NextSendAtRequestBody;
	} catch {
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	const rawTimezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
	const timezone =
		rawTimezone.length > 0 && rawTimezone.length <= MAX_TIMEZONE_LENGTH ? rawTimezone : null;
	const timeInputs: string[] = [];
	if (Array.isArray(body.timeInputs)) {
		for (const value of body.timeInputs) {
			if (typeof value !== "string") continue;
			timeInputs.push(value);
			if (timeInputs.length >= MAX_TIME_INPUTS) break;
		}
	}

	if (!timezone || timeInputs.length === 0) {
		return Response.json(
			{
				ok: true,
				message: "ok",
				nextSendAtIso: null,
				delayReasons: [],
				dstShift: null,
			} satisfies ApiJsonBody,
			{ status: 200 },
		);
	}

	const parsedTimes = parseScheduledTimes(timeInputs);
	if (!parsedTimes.ok || parsedTimes.times.length === 0) {
		return Response.json({ ok: false, message: "invalid_form" } satisfies ApiJsonBody, {
			status: 400,
		});
	}

	// Form supplies user-local-minutes; storage and computation are ET-canonical.
	const etMinutesList = parsedTimes.times.map((m) => userLocalToEtMinute(m, timezone));
	const { nextSendAt, delayReasons, holidayName, dstShift } =
		await calculateNextMarketScheduledSendAtFromTimes({
			etMinutesList,
			now: DateTime.utc(),
		});

	return Response.json(
		{
			ok: true,
			message: "ok",
			nextSendAtIso: nextSendAt?.toISO() ?? null,
			delayReasons,
			holidayName,
			dstShift,
		} satisfies ApiJsonBody,
		{ status: 200 },
	);
};
