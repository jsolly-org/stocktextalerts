import { describe, expect, it } from "vitest";
import {
	anyFacetEnabled,
	buildDefaultPreferenceRows,
	enabledFacets,
	isFacetEnabled,
	parsePrefRow,
} from "../../../src/lib/messaging/notification-prefs";
import { makePrefRows } from "../../helpers/user-record-fixture";

describe("notification-prefs channel-agnostic helpers", () => {
	const prefs = makePrefRows([
		["daily_notification", "prices", true],
		["daily_notification", "top_movers", true],
		["daily_notification", "news", true],
		["price_move_alerts", "", true],
	]);

	describe("isFacetEnabled", () => {
		it("is true only when a matching enabled row exists for (type, content)", () => {
			expect(isFacetEnabled(prefs, "daily_notification", "prices")).toBe(true);
			expect(isFacetEnabled(prefs, "daily_notification", "rumors")).toBe(false); // no such row
			expect(isFacetEnabled(prefs, "daily_notification", "ipo")).toBe(false); // no such row
		});

		it("defaults content to '' for facet-less notification types", () => {
			expect(isFacetEnabled(prefs, "price_move_alerts")).toBe(true);
			expect(isFacetEnabled(prefs, "market_scheduled_asset_price")).toBe(false);
		});
	});

	describe("enabledFacets", () => {
		it("returns only the enabled content facets for the requested type", () => {
			expect(enabledFacets(prefs, "daily_notification")).toEqual(
				new Set(["prices", "top_movers", "news"]),
			);
			expect(enabledFacets(prefs, "price_move_alerts")).toEqual(new Set([""]));
		});
	});

	describe("anyFacetEnabled", () => {
		it("is true when at least one facet is enabled for the type", () => {
			expect(anyFacetEnabled(prefs, "daily_notification")).toBe(true);
			expect(anyFacetEnabled(prefs, "price_move_alerts")).toBe(true);
			expect(anyFacetEnabled(prefs, "market_scheduled_asset_price")).toBe(false);
		});
	});

	describe("parsePrefRow", () => {
		it("returns null for retired/unknown notification types instead of throwing", () => {
			// Deploy-window safety: rows with a retired type (e.g. the removed
			// 'price_targets') can linger in the table until the drop migration
			// runs. They must be ignored, not thrown, by the read path.
			expect(
				parsePrefRow({
					notification_type: "price_targets",
					content: "",
					enabled: true,
				}),
			).toBeNull();
		});
	});

	describe("buildDefaultPreferenceRows", () => {
		it("seeds prices on and every other facet off, all owned by the user", () => {
			const rows = buildDefaultPreferenceRows("user-xyz");
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.user_id === "user-xyz")).toBe(true);

			const enabled = rows.filter((r) => r.enabled);
			expect(enabled).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						notification_type: "daily_notification",
						content: "prices",
						enabled: true,
					}),
				]),
			);
			// Exactly the one prices default is on by default; everything else is off.
			expect(enabled).toHaveLength(1);
			expect(enabled.every((r) => !("channel" in r))).toBe(true);
		});
	});
});
