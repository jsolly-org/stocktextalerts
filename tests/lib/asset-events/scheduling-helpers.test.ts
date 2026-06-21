import { describe, expect, it } from "vitest";
import { computeAssetEventsNextSendAt } from "../../../src/lib/asset-events/scheduling-helpers";
import type { User, UserUpdateInput } from "../../../src/lib/db";

function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: "00000000-0000-0000-0000-000000000111",
		timezone: "America/New_York",
		daily_digest_time: 1020,
		asset_events_next_send_at: "2026-01-14T22:00:00.000Z",
		...overrides,
	} as unknown as User;
}

// asset-events per-option preferences now live in notification_preferences, so the
// scheduler is field-agnostic: the caller resolves "any asset-events facet enabled"
// (hasAnyAssetEventsOption) and "did any change" (assetEventsOptionsChanged) and
// passes them in. These tests exercise that boolean contract directly.
describe("computeAssetEventsNextSendAt", () => {
	it("Enabling an asset-events option schedules next send.", () => {
		const user = makeUser();
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false, // timezoneChanged
			false, // dailyTimeChanged
			true, // assetEventsOptionsChanged
			true, // hasAnyAssetEventsOption
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Disabling the last enabled option clears next_send_at.", () => {
		const user = makeUser();
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			true, // assetEventsOptionsChanged
			false, // hasAnyAssetEventsOption — nothing left enabled
		);

		expect(updates.asset_events_next_send_at).toBeNull();
	});

	it("No options + no change flags = no mutation.", () => {
		const user = makeUser();
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			false,
			false,
		);

		expect(updates.asset_events_next_send_at).toBeUndefined();
	});

	it("Timezone change recomputes when an option is enabled.", () => {
		const user = makeUser();
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			"America/Chicago",
			true, // timezoneChanged
			false,
			false,
			true, // hasAnyAssetEventsOption
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Daily time change recomputes when an option is enabled.", () => {
		const user = makeUser();
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			600,
			user.timezone,
			false,
			true, // dailyTimeChanged
			false,
			true, // hasAnyAssetEventsOption
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Self-healing: repairs null next_send_at when an option is enabled.", () => {
		const user = makeUser({ asset_events_next_send_at: null });
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			false,
			true, // hasAnyAssetEventsOption — repairs a missing schedule
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("No repair when next_send_at is already set.", () => {
		const user = makeUser({ asset_events_next_send_at: "2026-01-14T22:00:00.000Z" });
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			false,
			true,
		);

		expect(updates.asset_events_next_send_at).toBeUndefined();
	});
});
