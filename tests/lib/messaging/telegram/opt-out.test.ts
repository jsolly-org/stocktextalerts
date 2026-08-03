import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../../src/lib/db/supabase";
import type { Logger } from "../../../../src/lib/logging";
import { optOutIfBotBlocked } from "../../../../src/lib/messaging/telegram/opt-out";
import type { DeliveryResult } from "../../../../src/lib/types";

type RecordedUpdate = {
	table: string;
	payload: unknown;
	filters: Array<{ column: string; value: unknown }>;
};

/** Supabase spy for select→maybeSingle and update→eq→eq→select→maybeSingle. */
function makeSupabaseSpy(
	options: { deliveryChannel?: "email" | "telegram" | "disabled"; updateError?: unknown } = {},
): {
	client: AppSupabaseClient;
	updates: RecordedUpdate[];
} {
	const updates: RecordedUpdate[] = [];
	const deliveryChannel = options.deliveryChannel ?? "telegram";
	const client = {
		from(table: string) {
			return {
				select(_columns: string) {
					return {
						eq(_column: string, _value: unknown) {
							return {
								maybeSingle: async () => ({
									data: { delivery_channel: deliveryChannel },
									error: null,
								}),
							};
						},
					};
				},
				update(payload: unknown) {
					const filters: Array<{ column: string; value: unknown }> = [];
					const chain = {
						eq(column: string, value: unknown) {
							filters.push({ column, value });
							return chain;
						},
						select(_columns: string) {
							return {
								maybeSingle: async () => {
									updates.push({ table, payload, filters: [...filters] });
									if (options.updateError) {
										return { data: null, error: options.updateError };
									}
									return { data: { id: "user-1" }, error: null };
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

function silentLogger(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("optOutIfBotBlocked", () => {
	it("sets delivery_channel=disabled when the account was routed to telegram on a 403", async () => {
		const { client, updates } = makeSupabaseSpy({ deliveryChannel: "telegram" });
		const result: DeliveryResult = { success: false, error: "blocked", errorCode: "403" };

		await optOutIfBotBlocked(client, "user-1", result, silentLogger());

		expect(updates).toEqual([
			{
				table: "users",
				payload: {
					delivery_channel: "disabled",
					email_notifications_enabled: false,
					telegram_opted_out: true,
				},
				filters: [
					{ column: "id", value: "user-1" },
					{ column: "delivery_channel", value: "telegram" },
				],
			},
		]);
	});

	it("does nothing when delivery_channel is not telegram", async () => {
		const { client, updates } = makeSupabaseSpy({ deliveryChannel: "email" });
		const result: DeliveryResult = { success: false, error: "blocked", errorCode: "403" };

		await optOutIfBotBlocked(client, "user-1", result, silentLogger());
		expect(updates).toHaveLength(0);
	});

	it("does nothing on a successful send", async () => {
		const { client, updates } = makeSupabaseSpy();
		await optOutIfBotBlocked(client, "user-1", { success: true }, silentLogger());
		expect(updates).toHaveLength(0);
	});

	it("does nothing on a non-403 failure (e.g. 429 flood, transient 5xx, no code)", async () => {
		const { client, updates } = makeSupabaseSpy();
		await optOutIfBotBlocked(
			client,
			"u",
			{ success: false, error: "flood", errorCode: "429" },
			silentLogger(),
		);
		expect(updates).toHaveLength(0);
		await optOutIfBotBlocked(client, "u", { success: false, error: "boom" }, silentLogger());
		expect(updates).toHaveLength(0);
	});
});
