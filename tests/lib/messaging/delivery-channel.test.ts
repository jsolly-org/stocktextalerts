import { describe, expect, it } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import {
	needsNotificationChannelSelection,
	resolveOutboundChannel,
	updateUserDeliveryChannel,
	wantsEmailDelivery,
	wantsTelegramDelivery,
} from "../../../src/lib/messaging/delivery-channel";

describe("account delivery routing", () => {
	it("resolves email when delivery_channel is email", () => {
		expect(resolveOutboundChannel({ delivery_channel: "email", telegram_chat_id: null })).toBe(
			"email",
		);
		expect(wantsEmailDelivery({ delivery_channel: "email" })).toBe(true);
		expect(wantsEmailDelivery({ delivery_channel: "telegram" })).toBe(false);
	});

	it("resolves telegram only when routed to telegram AND linked", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "telegram",
				telegram_chat_id: 8675309,
			}),
		).toBe("telegram");
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: 8675309,
				delivery_channel: "telegram",
			}),
		).toBe(true);
	});

	it("returns null when telegram is selected but chat is not linked", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "telegram",
				telegram_chat_id: null,
			}),
		).toBeNull();
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: null,
				delivery_channel: "telegram",
			}),
		).toBe(false);
	});

	it("returns null when delivery_channel is disabled", () => {
		expect(
			resolveOutboundChannel({
				delivery_channel: "disabled",
				telegram_chat_id: 8675309,
			}),
		).toBeNull();
		expect(wantsEmailDelivery({ delivery_channel: "disabled" })).toBe(false);
		expect(
			wantsTelegramDelivery({
				telegram_chat_id: 8675309,
				delivery_channel: "disabled",
			}),
		).toBe(false);
	});
});

describe("needsNotificationChannelSelection (dashboard setup gate)", () => {
	it("does not warn when delivery_channel is email", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "email" })).toBe(false);
	});

	it("does not warn when delivery_channel is telegram", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "telegram" })).toBe(false);
	});

	it("warns when delivery_channel is disabled", () => {
		expect(needsNotificationChannelSelection({ delivery_channel: "disabled" })).toBe(true);
	});
});

type RecordedUpdate = {
	patch: unknown;
	filters: Array<{ column: string; value: unknown }>;
};

/** Spy for users.update().eq().select().maybeSingle(). */
function makeUpdateSpy(
	options: { data?: { id: string } | null; error?: { message: string; code?: string } | null } = {},
): { client: AppSupabaseClient; updates: RecordedUpdate[] } {
	const updates: RecordedUpdate[] = [];
	const resolvedData = "data" in options ? options.data : { id: "user-1" };
	const client = {
		from(table: string) {
			return {
				update(patch: unknown) {
					const filters: Array<{ column: string; value: unknown }> = [];
					const chain = {
						eq(column: string, value: unknown) {
							filters.push({ column, value });
							return chain;
						},
						select(_columns: string) {
							return {
								maybeSingle: async () => {
									if (table === "users") {
										updates.push({ patch, filters: [...filters] });
									}
									return {
										data: resolvedData ?? null,
										error: options.error ?? null,
									};
								},
							};
						},
					};
					return chain;
				},
			};
		},
	} as unknown as AppSupabaseClient;
	return { client, updates };
}

describe("updateUserDeliveryChannel", () => {
	it("writes delivery_channel in the patch", async () => {
		const { client, updates } = makeUpdateSpy();
		const result = await updateUserDeliveryChannel({
			supabase: client,
			userId: "user-1",
			channel: "email",
		});

		expect(result).toEqual({ updated: true, error: null });
		expect(updates).toEqual([
			{
				patch: { delivery_channel: "email" },
				filters: [{ column: "id", value: "user-1" }],
			},
		]);
	});

	it("applies casCurrent filter when provided", async () => {
		const { client, updates } = makeUpdateSpy();
		await updateUserDeliveryChannel({
			supabase: client,
			userId: "user-1",
			channel: "disabled",
			casCurrent: "telegram",
		});

		expect(updates[0]?.filters).toEqual([
			{ column: "id", value: "user-1" },
			{ column: "delivery_channel", value: "telegram" },
		]);
	});

	it("merges extra columns into the patch", async () => {
		const { client, updates } = makeUpdateSpy();
		await updateUserDeliveryChannel({
			supabase: client,
			userId: "user-1",
			channel: "disabled",
			extra: { telegram_chat_id: null },
		});

		expect(updates[0]?.patch).toEqual({
			telegram_chat_id: null,
			delivery_channel: "disabled",
		});
	});

	it("returns updated: false on CAS miss (null data)", async () => {
		const { client } = makeUpdateSpy({ data: null });
		const result = await updateUserDeliveryChannel({
			supabase: client,
			userId: "user-1",
			channel: "disabled",
			casCurrent: "telegram",
		});

		expect(result).toEqual({ updated: false, error: null });
	});

	it("maps PostgREST errors onto the return shape", async () => {
		const { client } = makeUpdateSpy({
			data: null,
			error: { message: "boom", code: "42501" },
		});
		const result = await updateUserDeliveryChannel({
			supabase: client,
			userId: "user-1",
			channel: "disabled",
			casCurrent: "telegram",
		});

		expect(result).toEqual({
			updated: false,
			error: { message: "boom", code: "42501" },
		});
	});
});
