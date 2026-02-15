import type { APIRoute } from "astro";
import { DateTime } from "luxon";
import { jsonResponse } from "../../../lib/api/json-response";
import { calculateNextMarketScheduledSendAtFromTimes } from "../../../lib/time/market-scheduled-next-send";
import { parseScheduledTimes } from "../../../lib/time/scheduled-times";

interface NextSendAtRequestBody {
	timezone?: unknown;
	timeInputs?: unknown;
}

export const POST: APIRoute = async ({ request }) => {
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
	const timeInputs = Array.isArray(body.timeInputs)
		? body.timeInputs.filter(
				(value): value is string => typeof value === "string",
			)
		: [];

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
