import { describe, expect, it, vi } from "vitest";
import type { AppSupabaseClient } from "../../../src/lib/db/supabase";
import type { Logger } from "../../../src/lib/logging";
import { optOutIfBotBlocked } from "../../../src/lib/messaging/telegram/opt-out";
import type { DeliveryResult } from "../../../src/lib/types";

type RecordedUpdate = { table: string; payload: unknown; eqColumn: string; eqValue: unknown };

/** Supabase spy capturing `.from(t).update(p).eq(c, v)` calls; the eq resolves to {error}. */
function makeSupabaseSpy(error: unknown = null): {
	client: AppSupabaseClient;
	updates: RecordedUpdate[];
} {
	const updates: RecordedUpdate[] = [];
	const client = {
		from(table: string) {
			return {
				update(payload: unknown) {
					return {
						eq(eqColumn: string, eqValue: unknown) {
							updates.push({ table, payload, eqColumn, eqValue });
							return Promise.resolve({ error });
						},
					};
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
	it("sets telegram_opted_out=true for the user on a 403 (bot blocked)", async () => {
		const { client, updates } = makeSupabaseSpy();
		const result: DeliveryResult = { success: false, error: "blocked", errorCode: "403" };

		await optOutIfBotBlocked(client, "user-1", result, silentLogger());

		expect(updates).toEqual([
			{ table: "users", payload: { telegram_opted_out: true }, eqColumn: "id", eqValue: "user-1" },
		]);
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
		await optOutIfBotBlocked(client, "u", { success: false, error: "boom" }, silentLogger());
		expect(updates).toHaveLength(0);
	});

	it("swallows a DB error (best-effort: logs, never throws)", async () => {
		const logger = silentLogger();
		const { client } = makeSupabaseSpy({ message: "update failed" });
		const result: DeliveryResult = { success: false, error: "blocked", errorCode: "403" };

		await expect(optOutIfBotBlocked(client, "user-1", result, logger)).resolves.toBeUndefined();
		expect(logger.error).toHaveBeenCalledOnce();
	});
});
