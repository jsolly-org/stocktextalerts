import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAssetEventsContent } from "../../../src/lib/asset-events/content";
import { processAssetEventsEmailDelivery } from "../../../src/lib/asset-events/delivery";
import { processAssetEventsUser } from "../../../src/lib/asset-events/process";
import { loadUserAssets } from "../../../src/lib/schedule/helpers";

vi.mock("../../../src/lib/schedule/helpers", async () => {
	const actual = await vi.importActual("../../../src/lib/schedule/helpers");
	return {
		...actual,
		loadUserAssets: vi.fn(),
	};
});

vi.mock("../../../src/lib/asset-events/content", async () => {
	const actual = await vi.importActual("../../../src/lib/asset-events/content");
	return {
		...actual,
		buildAssetEventsContent: vi.fn(),
	};
});

vi.mock("../../../src/lib/asset-events/delivery", async () => {
	const actual = await vi.importActual("../../../src/lib/asset-events/delivery");
	return {
		...actual,
		processAssetEventsEmailDelivery: vi.fn(),
		processAssetEventsSmsDelivery: vi.fn(),
	};
});

import type { UserRecord } from "../../../src/lib/messaging/types";
import { makeUserRecord } from "../../helpers/user-record-fixture";

function makeUser(overrides: Partial<UserRecord> = {}): UserRecord {
	return makeUserRecord({
		sms_opted_out: true,
		asset_events_include_ipo_email: true,
		asset_events_next_send_at: "2026-02-10T10:00:00.000Z",
		...overrides,
	});
}

describe("processAssetEventsUser", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("continues processing IPO notifications even with zero tracked assets", async () => {
		vi.mocked(loadUserAssets).mockResolvedValue([]);
		vi.mocked(buildAssetEventsContent).mockResolvedValue({
			eventsSection: {
				earnings: null,
				dividends: null,
				splits: null,
				ipos: "ACME: IPO tomorrow",
			},
			insiderSection: null,
			analystSection: null,
			shouldUpdateAnalystMonth: false,
			hasAnyContent: true,
		});
		vi.mocked(processAssetEventsEmailDelivery).mockResolvedValue();

		const user = makeUser();
		const supabase = {
			from() {
				return {
					update() {
						return {
							eq() {
								return Promise.resolve({ error: null });
							},
						};
					},
				};
			},
		};
		const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

		const stats = await processAssetEventsUser({
			user,
			supabase: supabase as never,
			logger: logger as never,
			currentTime: DateTime.fromISO("2026-02-10T10:00:00.000Z"),
			sendEmail: vi.fn(async () => ({ success: true })) as never,
			getSmsSender: vi.fn(() => ({ sender: "+15555550123" })) as never,
		});

		expect(vi.mocked(buildAssetEventsContent)).toHaveBeenCalledWith(
			expect.objectContaining({ tickers: [] }),
		);
		expect(vi.mocked(processAssetEventsEmailDelivery)).toHaveBeenCalledOnce();
		expect(stats.skipped).toBe(0);
	});
});
