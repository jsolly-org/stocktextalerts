import { describe, expect, it } from "vitest";
import {
	ASSET_EVENTS_OPTION_FIELDS,
	computeAssetEventsNextSendAt,
} from "../../../src/lib/asset-events/scheduling-helpers";
import type { User, UserUpdateInput } from "../../../src/lib/db";

function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: "00000000-0000-0000-0000-000000000111",
		timezone: "America/New_York",
		market_scheduled_asset_price_times: [570],
		market_scheduled_asset_price_next_send_at: "2026-01-14T14:30:00.000Z",
		daily_digest_time: 1020,
		daily_digest_next_send_at: "2026-01-14T22:00:00.000Z",
		asset_events_next_send_at: "2026-01-14T22:00:00.000Z",
		email_notifications_enabled: true,
		sms_notifications_enabled: false,
		sms_opted_out: false,
		asset_events_include_calendar_email: false,
		asset_events_include_calendar_sms: false,
		asset_events_include_ipo_email: false,
		asset_events_include_ipo_sms: false,
		asset_events_include_analyst_email: false,
		asset_events_include_analyst_sms: false,
		asset_events_include_insider_email: false,
		asset_events_include_insider_sms: false,
		market_scheduled_asset_price_enabled: true,
		market_scheduled_asset_price_include_email: true,
		market_scheduled_asset_price_include_sms: false,
		market_asset_price_alerts_enabled: false,
		market_asset_price_alerts_include_email: false,
		market_asset_price_alerts_include_sms: false,
		...overrides,
	} as unknown as User;
}

describe("computeAssetEventsNextSendAt", () => {
	it.each(
		ASSET_EVENTS_OPTION_FIELDS,
	)("Enabling %s schedules next send.", (field) => {
		const user = makeUser();
		const updates: UserUpdateInput = { [field]: true };

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			true,
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Disabling the last enabled option clears next_send_at.", () => {
		const user = makeUser({ asset_events_include_calendar_email: true });
		const updates: UserUpdateInput = {
			asset_events_include_calendar_email: false,
		};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			true,
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
		);

		expect(updates.asset_events_next_send_at).toBeUndefined();
	});

	it("Timezone change recomputes when an option is enabled.", () => {
		const user = makeUser({ asset_events_include_insider_sms: true });
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			"America/Chicago",
			true,
			false,
			false,
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Daily time change recomputes when an option is enabled.", () => {
		const user = makeUser({ asset_events_include_ipo_email: true });
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			600,
			user.timezone,
			false,
			true,
			false,
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("Self-healing: repairs null next_send_at when an option is enabled.", () => {
		const user = makeUser({
			asset_events_include_analyst_email: true,
			asset_events_next_send_at: null,
		});
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			false,
		);

		expect(updates.asset_events_next_send_at).toBeTruthy();
	});

	it("No repair when next_send_at is already set.", () => {
		const user = makeUser({
			asset_events_include_analyst_email: true,
			asset_events_next_send_at: "2026-01-14T22:00:00.000Z",
		});
		const updates: UserUpdateInput = {};

		computeAssetEventsNextSendAt(
			updates,
			user,
			user.daily_digest_time,
			user.timezone,
			false,
			false,
			false,
		);

		expect(updates.asset_events_next_send_at).toBeUndefined();
	});
});
