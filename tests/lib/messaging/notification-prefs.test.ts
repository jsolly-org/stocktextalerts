import { describe, expect, it } from "vitest";
import {
	anyFacetEnabled,
	anySmsFacetEnabled,
	buildDefaultPreferenceRows,
	enabledFacets,
	isFacetEnabled,
} from "../../../src/lib/messaging/notification-prefs";
import { makePrefRows } from "../../helpers/user-record-fixture";

describe("notification-prefs channel-parametric helpers", () => {
	const prefs = makePrefRows([
		["daily_notification", "prices", "email", true],
		["daily_notification", "top_movers", "email", true],
		["daily_notification", "prices", "sms", false],
		["daily_notification", "news", "telegram", true],
		["market_asset_price_alerts", "", "telegram", true],
	]);

	describe("isFacetEnabled", () => {
		it("is true only when a matching enabled row exists for (type, channel, content)", () => {
			expect(isFacetEnabled(prefs, "daily_notification", "email", "prices")).toBe(true);
			expect(isFacetEnabled(prefs, "daily_notification", "sms", "prices")).toBe(false); // row disabled
			expect(isFacetEnabled(prefs, "daily_notification", "email", "news")).toBe(false); // no such row
		});

		it("defaults content to '' for facet-less notification types", () => {
			expect(isFacetEnabled(prefs, "market_asset_price_alerts", "telegram")).toBe(true);
			expect(isFacetEnabled(prefs, "market_asset_price_alerts", "email")).toBe(false);
		});
	});

	describe("enabledFacets", () => {
		it("returns only the enabled content facets for the requested (type, channel)", () => {
			expect(enabledFacets(prefs, "daily_notification", "email")).toEqual(
				new Set(["prices", "top_movers"]),
			);
			expect(enabledFacets(prefs, "daily_notification", "sms")).toEqual(new Set());
			expect(enabledFacets(prefs, "daily_notification", "telegram")).toEqual(new Set(["news"]));
		});
	});

	describe("anyFacetEnabled", () => {
		it("is true when at least one facet is enabled for (type, channel)", () => {
			expect(anyFacetEnabled(prefs, "daily_notification", "email")).toBe(true);
			expect(anyFacetEnabled(prefs, "daily_notification", "sms")).toBe(false);
			expect(anyFacetEnabled(prefs, "market_asset_price_alerts", "telegram")).toBe(true);
		});
	});

	describe("anySmsFacetEnabled", () => {
		it("is false when no SMS facet is enabled", () => {
			// `prefs` has only a disabled SMS row.
			expect(anySmsFacetEnabled(prefs)).toBe(false);
		});

		it("is true once any SMS facet is enabled", () => {
			const withDigestSms = makePrefRows([["daily_notification", "prices", "sms", true]]);
			expect(anySmsFacetEnabled(withDigestSms)).toBe(true);
		});
	});

	describe("buildDefaultPreferenceRows", () => {
		it("seeds prices email+sms on and every other facet off, all owned by the user", () => {
			const rows = buildDefaultPreferenceRows("user-xyz");
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.user_id === "user-xyz")).toBe(true);

			const enabled = rows.filter((r) => r.enabled);
			expect(enabled).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						notification_type: "daily_notification",
						content: "prices",
						channel: "email",
						enabled: true,
					}),
					expect.objectContaining({
						notification_type: "daily_notification",
						content: "prices",
						channel: "sms",
						enabled: true,
					}),
				]),
			);
			// Exactly the two prices defaults are on by default; everything else is off.
			expect(enabled).toHaveLength(2);
		});
	});
});
