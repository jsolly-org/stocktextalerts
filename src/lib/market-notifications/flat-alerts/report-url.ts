import { getSiteUrl } from "../../db/env";

/** Auth-gated path for the latest saved price-move why packet. */
export function buildPriceMoveReportPath(symbol: string): string {
	return `/dashboard/price-move/${encodeURIComponent(symbol)}`;
}

/** Absolute URL for Telegram/email "Full report" links. */
export function buildPriceMoveReportUrl(symbol: string): string {
	return new URL(buildPriceMoveReportPath(symbol), getSiteUrl()).toString();
}
