import type { ActiveMarketSession } from "../market-notifications/scheduled/session-label";
import type { SparklineData } from "./sparkline";
import { toSvgSparklineImg } from "./svg-sparkline";
import type { EmailFormatContext } from "./types";

export type AssetPrice = {
	price: number;
	changePercent: number;
	/** Yesterday's close (Massive `prevDay.c`). Available on snapshot quotes. */
	prevClose?: number | null;
	/** Today's 4:00 PM ET regular-session close. Populated for after-hours sessions only. */
	dayCloseRegular?: number | null;
};
type AssetWithName = { symbol: string; name: string };

/**
 * Footnote marker appended to a change-% string when the after-hours session
 * fell back to Massive's `todaysChangePerc` (vs. prev-day close) because
 * today's 4:00 PM ET close wasn't available.
 */
export const SESSION_CHANGE_FALLBACK_MARKER = "†";

/**
 * Footnote text shown at the bottom of a message body when any asset's change-%
 * was computed against the prior-day close instead of today's regular close.
 */
export const SESSION_CHANGE_FALLBACK_FOOTNOTE_TEXT =
	"† using prior close — no regular close available";

/**
 * Compute the session-aware change-% for a quote.
 *
 * For after-hours sessions, change-% is computed against TODAY's 4:00 PM ET
 * regular close (so it reflects only the post-close move). When today's close
 * isn't available, falls back to Massive's `todaysChangePerc` (vs. prev-day
 * close) and signals to the caller via `usedFallback: true` so the renderer
 * can append a footnote marker.
 *
 * For pre/regular sessions, returns the change-% as-returned by Massive.
 */
function computeSessionChangePercent(
	price: AssetPrice,
	session: ActiveMarketSession,
): { changePercent: number; usedFallback: boolean } {
	if (session === "after") {
		const dayClose = price.dayCloseRegular;
		if (typeof dayClose === "number" && Number.isFinite(dayClose) && dayClose !== 0) {
			return {
				changePercent: ((price.price - dayClose) / dayClose) * 100,
				usedFallback: false,
			};
		}
		return { changePercent: price.changePercent, usedFallback: true };
	}
	return { changePercent: price.changePercent, usedFallback: false };
}

export const NO_TRACKED_ASSETS_MESSAGE = "You don't have any tracked assets";

// Only allows http: and https: schemes to prevent javascript:, data:, and similar XSS.
export function getSafeHrefUrl(url: string): string | null {
	if (typeof url !== "string" || url.trim() === "") return null;
	const trimmed = url.trim().toLowerCase();
	if (trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
		return url.trim();
	}
	return null;
}

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatAssetPriceText(
	price: AssetPrice,
	sparkline?: string | null,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	let base = `$${price.price.toFixed(2)}`;
	if (showChangePercent) {
		const computed = marketSession
			? computeSessionChangePercent(price, marketSession)
			: { changePercent: price.changePercent, usedFallback: false };
		const sign = computed.changePercent >= 0 ? "+" : "";
		const fallbackMarker = computed.usedFallback ? SESSION_CHANGE_FALLBACK_MARKER : "";
		base += ` (${sign}${computed.changePercent.toFixed(2)}%${fallbackMarker})`;
	}
	if (sparkline) {
		return `${base} ${sparkline}`;
	}
	return base;
}

/**
 * Format a single asset line for plaintext contexts (email text / SMS / previews).
 *
 * When `marketSession` is provided, change-% is computed via
 * `computeSessionChangePercent` (after-hours uses today's 4:00 PM ET close
 * when available; appends a footnote marker on fallback).
 */
export function formatAssetTextLine(
	asset: AssetWithName,
	price: AssetPrice | undefined,
	sparkline?: string | null,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	if (!price) {
		return `${asset.symbol} — price unavailable`;
	}
	return `${asset.symbol} — ${formatAssetPriceText(price, sparkline, showChangePercent, marketSession)}`;
}

// WCAG 2.1 AA 4.5:1 on light bg.
export function getChangeColor(changePercent: number): string {
	return changePercent >= 0 ? "#166534" : "#b91c1c";
}

export function formatAssetHtmlLine(
	asset: AssetWithName,
	price: AssetPrice | undefined,
	sparkline?: SparklineData | null,
	logoHtml?: string,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	const assetInfo = `${logoHtml ?? ""}${escapeHtml(asset.symbol)}`;

	if (!price) {
		return `<strong>${assetInfo}</strong> &mdash; <span style="color: #6b7280;">price unavailable</span>`;
	}

	const priceStr = escapeHtml(`$${price.price.toFixed(2)}`);
	const computed = marketSession
		? computeSessionChangePercent(price, marketSession)
		: { changePercent: price.changePercent, usedFallback: false };
	const color = getChangeColor(computed.changePercent);

	let changeHtml = "";
	if (showChangePercent) {
		const sign = computed.changePercent >= 0 ? "+" : "";
		const fallbackMarker = computed.usedFallback ? SESSION_CHANGE_FALLBACK_MARKER : "";
		const changeStr = escapeHtml(`(${sign}${computed.changePercent.toFixed(2)}%${fallbackMarker})`);
		changeHtml = ` <span style="color: ${color};">${changeStr}</span>`;
	}

	let sparklineHtml = "";
	if (sparkline?.values && sparkline.values.length >= 2) {
		sparklineHtml = ` ${toSvgSparklineImg(sparkline.values, color)}`;
	}

	return `<strong>${assetInfo}</strong> &mdash; ${priceStr}${changeHtml}${sparklineHtml}`;
}

export function formatAssetsTextList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	getSparkline?: (symbol: string) => string | null | undefined,
	showChangePercent = true,
	marketSession?: ActiveMarketSession,
): string {
	if (assets.length === 0) {
		return NO_TRACKED_ASSETS_MESSAGE;
	}

	return assets
		.map((asset) =>
			formatAssetTextLine(
				asset,
				getPrice(asset.symbol),
				getSparkline?.(asset.symbol),
				showChangePercent,
				marketSession,
			),
		)
		.join("\n\n");
}

export function formatAssetsHtmlList(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	context?: Pick<EmailFormatContext, "getSparkline" | "getLogoHtml"> & {
		showChangePercent?: boolean;
		marketSession?: ActiveMarketSession;
	},
): string {
	if (assets.length === 0) {
		return escapeHtml(NO_TRACKED_ASSETS_MESSAGE);
	}

	const showChange = context?.showChangePercent ?? true;
	return assets
		.map((asset) =>
			formatAssetHtmlLine(
				asset,
				getPrice(asset.symbol),
				context?.getSparkline?.(asset.symbol),
				context?.getLogoHtml?.(asset.symbol),
				showChange,
				context?.marketSession,
			),
		)
		.join("<br>");
}

/**
 * Returns true when at least one asset will fall back to prev-day close for
 * its after-hours change-% (because `dayCloseRegular` is null/undefined).
 *
 * Used by the email/SMS renderers to conditionally add a `† using prior close`
 * footnote at the bottom of the message body.
 */
export function hasAfterHoursFallback(
	assets: AssetWithName[],
	getPrice: (symbol: string) => AssetPrice | undefined,
	marketSession: ActiveMarketSession,
): boolean {
	if (marketSession !== "after") return false;
	for (const asset of assets) {
		const price = getPrice(asset.symbol);
		if (!price) continue;
		const dayClose = price.dayCloseRegular;
		if (typeof dayClose !== "number" || !Number.isFinite(dayClose) || dayClose === 0) {
			return true;
		}
	}
	return false;
}
