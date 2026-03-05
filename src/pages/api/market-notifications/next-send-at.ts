import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { jsonResponse } from "../../../lib/api/json-response";
import { createUserService } from "../../../lib/db";
import { createSupabaseServerClient } from "../../../lib/db/supabase";
import { createLogger } from "../../../lib/logging";
import { calculateNextMarketScheduledSendAtFromTimes } from "../../../lib/time/market-scheduled-next-send";
import { parseScheduledTimes } from "../../../lib/time/scheduled-times";

/** Max time inputs to accept (DoS mitigation; DB allows fewer). */
const MAX_TIME_INPUTS = 32;

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
		return jsonResponse(401, { ok: false, message: "unauthorized" });
	}
	let body: NextSendAtRequestBody;
	try {
		body = (await request.json()) as NextSendAtRequestBody;
	} catch {
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const timezone =
		typeof body.timezone === "string" && body.timezone.trim() !== ""
			? body.timezone
			: null;
	const timeInputs: string[] = [];
	if (Array.isArray(body.timeInputs)) {
		for (const value of body.timeInputs) {
			if (typeof value !== "string") continue;
			timeInputs.push(value);
			if (timeInputs.length >= MAX_TIME_INPUTS) break;
		}
	}

	if (!timezone || timeInputs.length === 0) {
		return jsonResponse(200, {
			ok: true,
			message: "ok",
			nextSendAtIso: null,
			delayReasons: [],
		});
	}

	const parsedTimes = parseScheduledTimes(timeInputs);
	if (!parsedTimes.ok || parsedTimes.times.length === 0) {
		return jsonResponse(400, { ok: false, message: "invalid_form" });
	}

	const { nextSendAt, delayReasons, holidayName } =
		await calculateNextMarketScheduledSendAtFromTimes({
			localMinutesList: parsedTimes.times,
			timezone,
			now: DateTime.utc(),
		});

	return jsonResponse(200, {
		ok: true,
		message: "ok",
		nextSendAtIso: nextSendAt?.toISO() ?? null,
		delayReasons,
		holidayName,
	});
};
