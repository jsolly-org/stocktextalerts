import type { EarningsEvent, ProviderResult } from "./types";

export const earningsCalendarCache = new Map<
	string,
	{ result: ProviderResult<EarningsEvent>; expiresAt: number }
>();
