import { describe, expect, it } from "vitest";
import {
	anyFacetEnabled,
	buildDefaultPreferenceRows,
	enabledFacets,
	isFacetEnabled,
	parsePrefRow,
} from "../../../src/lib/messaging/notification-prefs";
import { makePrefRows } from "../../helpers/user-record-fixture";

describe("notification-prefs channel-parametric helpers", () => {
	const prefs = makePrefRows([
		["daily_notification", "prices", "email", true],
		["daily_notification", "top_movers", "email", true],
		["daily_notification", "news", "telegram", true],
		["price_move_alerts", "", "telegram", true],
	]);

	describe("isFacetEnabled", () => {
		it("is true only when a matching enabled row exists for (type, channel, content)", () => {
			expect(isFacetEnabled(prefs, "daily_notification", "email", "prices")).toBe(true);
			expect(isFacetEnabled(prefs, "daily_notification", "telegram", "prices")).toBe(false); // no such row
			expect(isFacetEnabled(prefs, "daily_notification", "email", "news")).toBe(false); // no such row
		});

		it("defaults content to '' for facet-less notification types", () => {
			expect(isFacetEnabled(prefs, "price_move_alerts", "telegram")).toBe(true);
			expect(isFacetEnabled(prefs, "price_move_alerts", "email")).toBe(false);
		});
	});

	describe("enabledFacets", () => {
		it("returns only the enabled content facets for the requested (type, channel)", () => {
			expect(enabledFacets(prefs, "daily_notification", "email")).toEqual(
				new Set(["prices", "top_movers"]),
			);
			expect(enabledFacets(prefs, "daily_notification", "telegram")).toEqual(new Set(["news"]));
		});
	});

	describe("anyFacetEnabled", () => {
		it("is true when at least one facet is enabled for (type, channel)", () => {
			expect(anyFacetEnabled(prefs, "daily_notification", "email")).toBe(true);
			expect(anyFacetEnabled(prefs, "daily_notification", "telegram")).toBe(true);
			expect(anyFacetEnabled(prefs, "price_move_alerts", "telegram")).toBe(true);
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
					channel: "email",
					enabled: true,
				}),
			).toBeNull();
		});
	});

	describe("buildDefaultPreferenceRows", () => {
		it("seeds prices email on and every other facet off, all owned by the user", () => {
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
				]),
			);
			// Exactly the one prices default is on by default; everything else is off.
			expect(enabled).toHaveLength(1);
		});
	});
});
